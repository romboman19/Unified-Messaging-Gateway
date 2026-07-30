import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaClient } from '@umg/database';
import { MessageSendProcessor } from './processors/message-send.processor';
import { MockAdapter } from './adapters/mock.adapter';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
      },
    }),
    BullModule.registerQueue({ name: 'message.send' }),
  ],
  providers: [
    MessageSendProcessor,
    MockAdapter,
    { provide: 'PRISMA', useValue: new PrismaClient() },
  ],
})
export class WorkerModule {}
