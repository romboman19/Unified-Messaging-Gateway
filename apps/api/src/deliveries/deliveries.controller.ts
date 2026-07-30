import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DeliveryStatus } from '@prisma/client';
import { SessionGuard } from '../auth/session.guard';
import { DeliveriesService } from './deliveries.service';

@Controller('deliveries')
@UseGuards(SessionGuard)
export class DeliveriesController {
  constructor(private readonly service: DeliveriesService) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('destinationId') destinationId?: string,
    @Query('eventId') eventId?: string,
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
  ) {
    let statusFilter: DeliveryStatus | undefined;
    if (status) {
      if (!Object.values(DeliveryStatus).includes(status as DeliveryStatus)) {
        throw new UnprocessableEntityException('Невідомий статус доставки.');
      }
      statusFilter = status as DeliveryStatus;
    }
    return this.service.list({
      status: statusFilter,
      destinationId,
      eventId,
      take: Math.min(parseInt(limit, 10) || 50, 100),
      skip: parseInt(offset, 10) || 0,
    });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post(':id/replay')
  replay(@Param('id') id: string, @Body() body: { actorId?: string }) {
    return this.service.replay(id, body?.actorId ?? null);
  }
}
