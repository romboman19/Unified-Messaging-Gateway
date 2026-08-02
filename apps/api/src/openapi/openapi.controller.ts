import { Controller, Get, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { OpenApiService } from './openapi.service';

/**
 * Machine-readable API reference for the admin UI's "API" tab.
 *
 * Session-guarded on purpose: the spec enumerates every route in the system,
 * which is exactly the map you would want before attacking it. The admin is
 * already authenticated, so there is no reason to publish it anonymously.
 */
@Controller('openapi')
@UseGuards(SessionGuard)
export class OpenApiController {
  constructor(private readonly openapi: OpenApiService) {}

  @Get()
  get() {
    return this.openapi.get();
  }
}
