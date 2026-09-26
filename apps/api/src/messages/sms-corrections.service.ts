import { Inject, Injectable, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaClient, Prisma } from '@umg/database';

@Injectable()
export class SmsCorrectionsService {
  constructor(@Inject('PRISMA') private readonly prisma: PrismaClient) {}

  async correct(id: string, order: string[] | null, actorId: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM messages WHERE id = ${id} FOR UPDATE`;
      const message = await tx.message.findUnique({
        where: { id }, include: { smsParts: { orderBy: { position: 'asc' } } },
      });
      if (!message) throw new NotFoundException('Повідомлення не знайдено.');
      if (message.status === 'assembling') throw new ConflictException('Дочекайтеся завершення групування.');
      if (message.smsParts.length < 2 || message.channelType !== 'sms' || message.direction !== 'inbound') {
        throw new UnprocessableEntityException('Потрібна група з кількох вхідних SMS.');
      }
      const parts = message.smsParts;
      const originalOrder = parts.map((p) => p.id);
      if (order && (order.length !== parts.length || new Set(order).size !== parts.length ||
          order.some((partId) => !originalOrder.includes(partId)))) {
        throw new ConflictException('Склад групи змінився. Оновіть сторінку.');
      }
      const metadata = message.metadataJson as Record<string, any>;
      const content = message.contentJson as Record<string, any>;
      const resultIds = [id];
      if (order) {
        const sorted = order.map((partId) => parts.find((p) => p.id === partId)!);
        for (const [position, part] of sorted.entries()) {
          await tx.smsPart.update({ where: { id: part.id }, data: { position } });
        }
        await tx.message.update({ where: { id }, data: {
          contentJson: { ...content, text: sorted.map((p) => p.text).join('') },
          metadataJson: { ...metadata, smsGrouping: { ...metadata.smsGrouping, manuallyOrdered: true } },
        } });
      } else {
        for (const [index, part] of parts.entries()) {
          const partMetadata = { ...metadata, smsGrouping: {
            approximate: false, partCount: 1, splitFrom: id, correctedLocally: true,
          } };
          if (index === 0) {
            await tx.message.update({ where: { id }, data: {
              contentJson: { ...content, text: part.text }, metadataJson: partMetadata,
              externalId: part.sourceKey, rawPayload: part.rawPayload as Prisma.InputJsonValue,
              createdAt: part.receivedAt,
            } });
            await tx.smsPart.update({ where: { id: part.id }, data: { position: 0 } });
          } else {
            const created = await tx.message.create({ data: {
              direction: 'inbound', channelType: 'sms', messageType: 'text', status: 'delivered',
              accountId: message.accountId, endpointId: message.endpointId,
              conversationId: message.conversationId, externalId: part.sourceKey,
              fromJson: message.fromJson as Prisma.InputJsonValue,
              toJson: message.toJson as Prisma.InputJsonValue,
              contentJson: { ...content, text: part.text }, metadataJson: partMetadata,
              rawPayload: part.rawPayload as Prisma.InputJsonValue, createdAt: part.receivedAt,
            } });
            resultIds.push(created.id);
            await tx.smsPart.update({ where: { id: part.id }, data: { messageId: created.id, position: 0 } });
          }
        }
      }
      // Delivery events are immutable snapshots. Corrections never re-dispatch.
      await tx.auditLog.create({ data: {
        actorId, action: order ? 'sms.reordered' : 'sms.split', entityType: 'message', entityId: id,
        beforeJson: { partIds: originalOrder, text: content.text },
        afterJson: { partIds: order ?? originalOrder, messageIds: resultIds, localOnly: true },
      } });
      return { messageIds: resultIds, localOnly: true };
    });
  }
}
