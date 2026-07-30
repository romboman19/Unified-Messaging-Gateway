import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from './auth/auth.module';
import { MessagesModule } from './messages/messages.module';
import { TransportAccountsModule } from './transport-accounts/transport-accounts.module';
import { HealthModule } from './health/health.module';
import { QueueModule } from './queue/queue.module';
import { ApiTokensModule } from './api-tokens/api-tokens.module';
import { CommonModule } from './common/common.module';
import { RequestIdMiddleware } from './common/request-id.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: 10 }],
    }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'fixed', delay: 60000 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    }),
    CommonModule,
    AuthModule,
    ApiTokensModule,
    MessagesModule,
    TransportAccountsModule,
    HealthModule,
    QueueModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
