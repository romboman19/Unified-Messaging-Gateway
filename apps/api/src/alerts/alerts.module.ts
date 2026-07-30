import { Module } from '@nestjs/common';
import { AlertsController, AlertRulesController } from './alerts.controller';
import { AlertsService } from './alerts.service';

@Module({
  controllers: [AlertsController, AlertRulesController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
