import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { SessionOrTokenGuard } from '../auth/session-or-token.guard';
import { AuditLogsService } from './audit-logs.service';

@Controller('audit-logs')
@UseGuards(SessionOrTokenGuard)
export class AuditLogsController {
  constructor(private readonly service: AuditLogsService) {}

  @Get()
  list(@Query('limit') limit = '50', @Query('offset') offset = '0') {
    return this.service.list({
      take: Math.min(parseInt(limit, 10) || 50, 100),
      skip: parseInt(offset, 10) || 0,
    });
  }
}

@Controller('events')
@UseGuards(SessionGuard)
export class EventsController {
  constructor(private readonly service: AuditLogsService) {}

  @Get()
  list(
    @Query('type') type?: string,
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
  ) {
    return this.service.listEvents({
      type,
      take: Math.min(parseInt(limit, 10) || 50, 100),
      skip: parseInt(offset, 10) || 0,
    });
  }
}
