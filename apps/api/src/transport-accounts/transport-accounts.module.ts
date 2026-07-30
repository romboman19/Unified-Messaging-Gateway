import { Module } from '@nestjs/common';
import { TransportAccountsController, EndpointsController } from './transport-accounts.controller';
import { TransportAccountsService } from './transport-accounts.service';

@Module({
  controllers: [TransportAccountsController, EndpointsController],
  providers: [TransportAccountsService],
  exports: [TransportAccountsService],
})
export class TransportAccountsModule {}
