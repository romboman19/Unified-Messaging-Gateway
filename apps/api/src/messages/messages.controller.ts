import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  UseGuards,
  Query,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Request } from 'express';
import { ChannelType, MessageDirection, MessageStatus } from '@prisma/client';
import { MessagesService } from './messages.service';
import { ApiTokenGuard } from '../auth/api-token.guard';
import { SessionGuard } from '../auth/session.guard';
import { SessionOrTokenGuard } from '../auth/session-or-token.guard';
import { SendMessageDto } from './send-message.dto';

@Controller('messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post()
  @UseGuards(ApiTokenGuard)
  async send(
    @Body() dto: SendMessageDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() req: Request,
  ) {
    const requestId = (req as unknown as { requestId: string }).requestId;
    const result = await this.messages.send(dto, idempotencyKey, requestId);
    return result;
  }

  @Post('ui-send')
  @UseGuards(SessionGuard)
  async uiSend(
    @Body() dto: SendMessageDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() req: Request,
  ) {
    const requestId = (req as unknown as { requestId: string }).requestId;
    return this.messages.send(dto, idempotencyKey, requestId);
  }

  @Get()
  @UseGuards(SessionOrTokenGuard)
  list(
    @Query('status') status?: string,
    @Query('channel') channel?: string,
    @Query('direction') direction?: string,
    @Query('q') q?: string,
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
  ) {
    return this.messages.list({
      status: status ? this.parseEnum(status, MessageStatus, 'статус повідомлення') : undefined,
      channel: channel ? this.parseEnum(channel, ChannelType, 'канал') : undefined,
      direction: direction ? this.parseEnum(direction, MessageDirection, 'напрямок') : undefined,
      q,
      take: Math.min(parseInt(limit, 10) || 50, 100),
      skip: parseInt(offset, 10) || 0,
    });
  }

  @Get(':id')
  @UseGuards(SessionOrTokenGuard)
  get(@Param('id') id: string) {
    return this.messages.get(id);
  }

  @Post(':id/retry')
  @UseGuards(SessionGuard)
  retry(@Param('id') id: string, @Body() body: { actorId?: string }) {
    return this.messages.retry(id, body?.actorId ?? null);
  }

  @Post(':id/cancel')
  @UseGuards(SessionGuard)
  cancel(@Param('id') id: string, @Body() body: { actorId?: string }) {
    return this.messages.cancel(id, body?.actorId ?? null);
  }

  private parseEnum<T extends Record<string, string>>(value: string, enm: T, label: string): T[keyof T] {
    if (!Object.values(enm).includes(value)) {
      throw new UnprocessableEntityException(`Невідоме значення "${value}" для параметра "${label}".`);
    }
    return value as T[keyof T];
  }
}
