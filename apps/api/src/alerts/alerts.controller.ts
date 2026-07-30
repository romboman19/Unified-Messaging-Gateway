import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AlertStatus } from '@prisma/client';
import { SessionGuard } from '../auth/session.guard';
import { AlertsService } from './alerts.service';
import { UpdateAlertRuleDto } from './alerts.dto';

@Controller('alerts')
@UseGuards(SessionGuard)
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
  ) {
    let statusFilter: AlertStatus | undefined;
    if (status) {
      if (!Object.values(AlertStatus).includes(status as AlertStatus)) {
        throw new UnprocessableEntityException('Невідомий статус алерту.');
      }
      statusFilter = status as AlertStatus;
    }
    return this.alerts.list({
      status: statusFilter,
      take: Math.min(parseInt(limit, 10) || 50, 100),
      skip: parseInt(offset, 10) || 0,
    });
  }

  @Post(':id/resolve')
  resolve(@Param('id') id: string, @Body() body: { actorId?: string }) {
    return this.alerts.resolve(id, body?.actorId ?? null);
  }
}

@Controller('alert-rules')
@UseGuards(SessionGuard)
export class AlertRulesController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  list() {
    return this.alerts.listRules();
  }

  @Patch(':key')
  update(
    @Param('key') key: string,
    @Body() dto: UpdateAlertRuleDto,
    @Body('actorId') actorId: string,
  ) {
    return this.alerts.updateRule(key, dto, actorId ?? null);
  }
}
