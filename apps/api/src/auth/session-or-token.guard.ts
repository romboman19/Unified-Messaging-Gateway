import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Inject } from '@nestjs/common';
import { Request } from 'express';
import { PrismaClient } from '@umg/database';

/**
 * Allows the request when EITHER a valid admin session OR a valid global API token is present.
 */
@Injectable()
export class SessionOrTokenGuard implements CanActivate {
  constructor(@Inject('PRISMA') private readonly prisma: PrismaClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    const user = (req.session as any)?.['user'];
    if (user) {
      (req as any)['user'] = user;
      return true;
    }

    const auth = req.headers.authorization ?? '';
    const [scheme, token] = auth.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Потрібна сесія адміністратора або Bearer API token.');
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
