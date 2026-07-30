import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { PrismaClient } from '@umg/database';
import { Inject } from '@nestjs/common';

@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(@Inject('PRISMA') private readonly prisma: PrismaClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.headers.authorization ?? '';
    const [scheme, token] = auth.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Потрібен Bearer API token.');
    }
    const hash = await this.sha256(token);
    const row = await this.prisma.globalApiToken.findFirst({
      where: { tokenHash: hash, revokedAt: null },
    });
    if (!row) throw new UnauthorizedException('Недійсний API token.');
    await this.prisma.globalApiToken.update({
      where: { id: row.id },
      data: { lastUsedAt: new Date() },
    });
    (req as any)['apiToken'] = row;
    return true;
  }

  private async sha256(input: string): Promise<string> {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
