import { Module, Global } from '@nestjs/common';
import { PrismaClient } from '@umg/database';
import { LoggerService } from './logger.service';
import { AuditService } from './audit.service';
import { EventEmitterService } from './event-emitter.service';

@Global()
@Module({
  providers: [
    LoggerService,
    AuditService,
    EventEmitterService,
    { provide: 'PRISMA', useValue: new PrismaClient() },
  ],
  exports: [LoggerService, AuditService, EventEmitterService, 'PRISMA'],
})
export class CommonModule {}
