import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { ConversationsService } from './conversations.service';

@Controller('conversations')
@UseGuards(SessionGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(@Query('limit') limit = '50', @Query('offset') offset = '0') {
    return this.conversations.list({
      take: Math.min(parseInt(limit, 10) || 50, 100),
      skip: parseInt(offset, 10) || 0,
    });
  }

  @Get(':id/messages')
  messages(
    @Param('id') id: string,
    @Query('limit') limit = '100',
    @Query('offset') offset = '0',
  ) {
    return this.conversations.messages(id, {
      take: Math.min(parseInt(limit, 10) || 100, 100),
      skip: parseInt(offset, 10) || 0,
    });
  }
}
