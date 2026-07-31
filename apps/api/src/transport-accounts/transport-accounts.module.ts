import { Module } from '@nestjs/common';
import { TransportAccountsController, EndpointsController } from './transport-accounts.controller';
import { TransportAccountsService } from './transport-accounts.service';
import { TransportAccountsBootstrapService } from './transport-accounts.bootstrap';

@Module({
  controllers: [TransportAccountsController, EndpointsController],
  providers: [TransportAccountsService, TransportAccountsBootstrapService],
  exports: [TransportAccountsService],
})
export class TransportAccountsModule {}
