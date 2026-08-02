import { Module } from '@nestjs/common';
import { TransportAccountsController, EndpointsController } from './transport-accounts.controller';
import { TransportAccountsService } from './transport-accounts.service';
import { TransportAccountsBootstrapService } from './transport-accounts.bootstrap';
import { ProvisioningService } from './provisioning.service';
import { BalanceService } from './balance.service';

@Module({
  controllers: [TransportAccountsController, EndpointsController],
  providers: [
    TransportAccountsService,
    TransportAccountsBootstrapService,
    ProvisioningService,
    BalanceService,
  ],
  exports: [TransportAccountsService, ProvisioningService],
})
export class TransportAccountsModule {}