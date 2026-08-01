import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
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
  delete(@Param('id') id: string, @Request() req: unknown) {
    return this.service.deleteEndpoint(id, this.actor(req));
  }

  @Delete(':id/registration')
  unlinkRegistration(@Param('id') id: string, @Request() req: unknown) {
    return this.provisioning.unlink(id, this.actor(req));
  }
}
