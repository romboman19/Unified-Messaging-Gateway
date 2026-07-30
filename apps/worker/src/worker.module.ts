import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaClient } from '@umg/database';
import { MessageSendProcessor } from './processors/message-send.processor';
import { WebhookDeliverProcessor } from './processors/webhook-deliver.processor';
import { MockAdapter } from './adapters/mock.adapter';
import { EventsService } from './events/events.service';
import { RoutingService } from './routing/routing.service';
import { AlertsService } from './alerts/alerts.service';
import { ScheduledSendScheduler } from './schedulers/scheduled-send.scheduler';
import { OutboxDispatcherScheduler } from './schedulers/outbox-dispatcher.scheduler';
import { MediaRetentionScheduler } from './schedulers/media-retention.scheduler';
import { ReconciliationScheduler } from './schedulers/reconciliation.scheduler';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
      },
    }),
    BullModule.registerQueue({ name: 'message.send' }, { name: 'webhook.deliver' }),
  ],
  providers: [
    MessageSendProcessor,
    WebhookDeliverProcessor,
    ScheduledSendScheduler,
    OutboxDispatcherScheduler,
    MediaRetentionScheduler,
    ReconciliationScheduler,
    EventsService,
    RoutingService,
    AlertsService,
    MockAdapter,
    { provide: 'PRISMA', useValue: new PrismaClient() },
  ],
})
export class WorkerModule {}
