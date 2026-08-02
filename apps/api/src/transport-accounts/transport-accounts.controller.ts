import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { TransportAccountsService } from './transport-accounts.service';
import {
  CreateTransportAccountDto,
  UpdateTransportAccountDto,
  CreateEndpointDto,
  UpdateEndpointDto,
} from './transport-accounts.dto';
import { ProvisioningService } from './provisioning.service';
import { ProvisionQrDto, ProvisionVerifyDto, ReattachDto } from './provisioning.dto';
import { BalanceService } from './balance.service';

@Controller('transport-accounts')
@UseGuards(SessionGuard)
export class TransportAccountsController {
  constructor(
    private readonly service: TransportAccountsService,
    private readonly provisioning: ProvisioningService,
  ) {}

  private actor(req: unknown): string | null {
    return ((req as { user?: { id: string } }).user?.id) ?? null;
  }

  @Get()
  list() {
    return this.service.list();
  }

  @Post()
  create(@Body() dto: CreateTransportAccountDto, @Request() req: unknown) {
    return this.service.create(
      {
        type: dto.type,
        adapter: dto.adapter,
        name: dto.name,
        status: dto.status,
        config: dto.config,
      },
      this.actor(req),
    );
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTransportAccountDto,
    @Request() req: unknown,
  ) {
    return this.service.update(
      id,
      {
        name: dto.name,
        status: dto.status,
        config: dto.config,
      },
      this.actor(req),
    );
  }

  @Delete(':id')
  delete(@Param('id') id: string, @Request() req: unknown) {
    return this.service.delete(id, this.actor(req));
  }

  @Post(':id/endpoints')
  createEndpoint(
    @Param('id') accountId: string,
    @Body() dto: CreateEndpointDto,
    @Request() req: unknown,
  ) {
    return this.service.createEndpoint(
      accountId,
      {
        label: dto.label,
        externalId: dto.externalId,
        phoneRaw: dto.phoneRaw,
        phoneE164: dto.phoneE164,
        enabled: dto.enabled,
        config: dto.config,
      },
      this.actor(req),
    );
  }

  // ─────────────────── Provisioning (TZ §1038) ───────────────────

  @Post(':id/provision/qrcode')
  provisionQr(
    @Param('id') accountId: string,
    @Body() dto: ProvisionQrDto,
    @Request() req: unknown,
  ) {
    return this.provisioning.startQr(accountId, dto, this.actor(req));
  }

  @Get(':id/provision/accounts')
  listSidecarAccounts(@Param('id') accountId: string) {
    return this.provisioning.listSidecarAccounts(accountId);
  }

  /**
   * Proxy for sidecars that render the QR themselves (gwmd). The sidecar's
   * own URL sits on the internal `transports` network, so the browser asks
   * the API and the API fetches the bytes.
   */
  @Get(':id/provision/:endpointId/qr.png')
  async qrImage(
    @Param('id') accountId: string,
    @Param('endpointId') endpointId: string,
    @Res() res: Response,
  ) {
    const image = await this.provisioning.qrImage(accountId, endpointId);
    res.setHeader('content-type', image.contentType);
    // The QR is single-use and short-lived — never let a proxy hold it.
    res.setHeader('cache-control', 'no-store');
    res.end(Buffer.from(image.bytes));
  }

  @Get(':id/provision/:endpointId/poll')
  pollProvisioning(
    @Param('id') accountId: string,
    @Param('endpointId') endpointId: string,
  ) {
    return this.provisioning.poll(accountId, endpointId);
  }

  @Post(':id/provision/:endpointId/verify')
  verifyProvisioning(
    @Param('id') accountId: string,
    @Param('endpointId') endpointId: string,
    @Body() dto: ProvisionVerifyDto,
    @Request() req: unknown,
  ) {
    return this.provisioning.verify(accountId, endpointId, dto, this.actor(req));
  }

  @Post(':id/provision/:endpointId/reattach')
  reattachProvisioning(
    @Param('id') accountId: string,
    @Param('endpointId') endpointId: string,
    @Body() dto: ReattachDto,
    @Request() req: unknown,
  ) {
    return this.provisioning.reattach(
      accountId,
      endpointId,
      dto.externalId,
      this.actor(req),
    );
  }
}

@Controller('endpoints')
@UseGuards(SessionGuard)
export class EndpointsController {
  constructor(
    private readonly service: TransportAccountsService,
    private readonly provisioning: ProvisioningService,
    private readonly balance: BalanceService,
  ) {}

  private actor(req: unknown): string | null {
    return ((req as { user?: { id: string } }).user?.id) ?? null;
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateEndpointDto,
    @Request() req: unknown,
  ) {
    return this.service.updateEndpoint(
      id,
      {
        label: dto.label,
        externalId: dto.externalId,
        phoneRaw: dto.phoneRaw,
        phoneE164: dto.phoneE164,
        enabled: dto.enabled,
        config: dto.config,
      },
      this.actor(req),
    );
  }

  @Delete(':id')
  delete(
    @Param('id') id: string,
    @Query('force') force: string | undefined,
    @Request() req: unknown,
  ) {
    return this.service.deleteEndpoint(id, this.actor(req), force === 'true');
  }

  @Delete(':id/registration')
  unlinkRegistration(@Param('id') id: string, @Request() req: unknown) {
    return this.provisioning.unlink(id, this.actor(req));
  }

  /**
   * Reads the SIM's balance now. The daily scheduler covers the routine case;
   * this exists for the moment right after a top-up, when yesterday's figure
   * is not what the admin wants to see.
   */
  @Post(':id/balance')
  checkBalance(@Param('id') id: string, @Body() body: { ussd?: string }) {
    return this.balance.check(id, body?.ussd);
  }
}
