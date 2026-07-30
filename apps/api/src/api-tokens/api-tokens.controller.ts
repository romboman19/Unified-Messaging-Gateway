import { Controller, Get, Post, Delete, Param, UseGuards, Body } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { ApiTokensService } from './api-tokens.service';
import { AuditService } from '../common/audit.service';

import { IsOptional, IsString } from 'class-validator';
class GenerateDto {
  @IsOptional()
  @IsString()
  name?: string;
}

@Controller('api-tokens')
export class ApiTokensController {
  constructor(
    private readonly tokens: ApiTokensService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @UseGuards(SessionGuard)
  list() {
    return this.tokens.list();
  }

  @Post()
  @UseGuards(SessionGuard)
  async generate(@Body() dto: GenerateDto, @Body('actorId') actorId: string) {
    const result = await this.tokens.generate(dto.name);
    await this.audit.log(actorId ?? null, 'api_token.generated', 'global_api_token', result.token.substring(0, 8), null, { name: result.name });
    return result;
  }

  @Delete(':id')
  @UseGuards(SessionGuard)
  async revoke(@Param('id') id: string, @Body('actorId') actorId: string) {
    await this.tokens.revoke(id);
    await this.audit.log(actorId ?? null, 'api_token.revoked', 'global_api_token', id, {}, {});
    return { ok: true };
  }
}
