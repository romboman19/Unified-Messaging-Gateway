import { Module, Global } from '@nestjs/common';
import { PrismaClient } from '@umg/database';
import { LoggerService } from './logger.service';
import { AuditService } from './audit.service';

@Global()
@Module({
  providers: [
    LoggerService,
    AuditService,
    { provide: 'PRISMA', useValue: new PrismaClient() },
  ],
  exports: [LoggerService, AuditService, 'PRISMA'],
})
export class CommonModule {}
