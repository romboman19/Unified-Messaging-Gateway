import { Controller, Get } from '@nestjs/common';
import { PrismaClient } from '@umg/database';
import { Inject } from '@nestjs/common';

@Controller('health')
export class HealthController {
  constructor(@Inject('PRISMA') private readonly prisma: PrismaClient) {}

  @Get('live')
  live() {
    return { status: 'ok', service: 'umg-api' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', service: 'umg-api' };
    } catch (err) {
      return { status: 'not_ready', service: 'umg-api', error: (err as Error).message };
    }
  }

  @Get('details')
  async details() {
    const dbOk = await this.prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
    return {
      service: 'umg-api',
      version: process.env.npm_package_version ?? '0.1.0',
      database: dbOk ? 'healthy' : 'unhealthy',
    };
  }
}
