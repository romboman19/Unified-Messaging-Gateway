import { Controller, Post, Get, Body, Param, Headers, UseGuards, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { MessagesService } from './messages.service';
import { ApiTokenGuard } from '../auth/api-token.guard';
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

  @Get()
  @UseGuards(ApiTokenGuard)
  list(
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
  ) {
    return this.messages.list({
      take: Math.min(parseInt(limit, 10) || 50, 100),
      skip: parseInt(offset, 10) || 0,
    });
  }

  @Get(':id')
  @UseGuards(ApiTokenGuard)
  get(@Param('id') id: string) {
    return this.messages.get(id);
  }
}
