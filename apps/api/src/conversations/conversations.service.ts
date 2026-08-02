import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@umg/database';

@Injectable()
export class ConversationsService {
  constructor(@Inject('PRISMA') private readonly prisma: PrismaClient) {}

  async list(opts: { take: number; skip: number }) {
    const [conversations, count] = await Promise.all([
      this.prisma.conversation.findMany({
        take: opts.take,
        skip: opts.skip,
        orderBy: { lastMessageAt: 'desc' },
        include: {
          endpoint: { select: { id: true, label: true } },
          messages: {
            take: 1,
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              direction: true,
              messageType: true,
              status: true,
              contentJson: true,
              createdAt: true,
            },
          },
        },
      }),
      this.prisma.conversation.count(),
    ]);
    const items = conversations.map((c) => {
      const { messages, ...rest } = c;
      const last = messages[0] ?? null;
      return {
        ...rest,
        endpointLabel: c.endpoint?.label ?? null,
        lastMessage: last
          ? {
              id: last.id,
              direction: last.direction,
              messageType: last.messageType,
              status: last.status,
              preview: this.preview(last.contentJson),
              createdAt: last.createdAt,
            }
          : null,
      };
    });
    return { items, count };
  }

  async messages(id: string, opts: { take: number; skip: number }) {
    const conversation = await this.prisma.conversation.findUnique({ where: { id } });
    if (!conversation) throw new NotFoundException('Розмову не знайдено.');
    const [items, count] = await Promise.all([
      this.prisma.message.findMany({
        where: { conversationId: id },
        take: opts.take,
        skip: opts.skip,
        orderBy: { createdAt: 'asc' },
        include: {
          _count: { select: { attempts: true, statusHistory: true } },
          // The last attempt carries why a send failed. Without it the UI can
          // only say "не вдалося" and the admin has no way to tell an
          // unregistered recipient from a transport outage.
          attempts: {
            orderBy: { startedAt: 'desc' },
            take: 1,
            select: { result: true, errorJson: true },
          },
        },
      }),
      this.prisma.message.count({ where: { conversationId: id } }),
    ]);
    return {
      items: items.map(({ attempts, ...m }) => ({
        ...m,
        attemptsCount: m._count.attempts,
        statusHistoryCount: m._count.statusHistory,
        lastError: this.errorSummary(attempts[0]?.errorJson),
      })),
      count,
    };
  }

  /**
   * Flattens an attempt's stored error into `{ code, message }` for the UI.
   * Adapters already speak in canonical codes, so the web layer can turn a
   * code into human wording without parsing vendor payloads.
   */
  private errorSummary(errorJson: unknown): { code: string; message: string } | null {
    if (!errorJson || typeof errorJson !== 'object') return null;
    const e = errorJson as Record<string, unknown>;
    const code = typeof e['code'] === 'string' ? e['code'] : '';
    const message = typeof e['message'] === 'string' ? e['message'] : '';
    if (!code && !message) return null;
    return { code, message };
  }

  private preview(content: unknown): string {
    if (!content || typeof content !== 'object') return '';
    const text = (content as Record<string, unknown>)['text'];
    return typeof text === 'string' ? text.slice(0, 200) : '';
  }
}
