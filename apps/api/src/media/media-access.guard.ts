import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Inject,
  GoneException,
} from '@nestjs/common';
import { Request } from 'express';
import { PrismaClient } from '@umg/database';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Read access to media: admin session OR valid global API token OR valid signed URL
 * (?exp=<unix>&sig=<hmac-sha256(MEDIA_URL_SECRET || SESSION_SECRET, "<id>.<exp>")>).
 */
@Injectable()
export class MediaAccessGuard implements CanActivate {
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
    if (scheme?.toLowerCase() === 'bearer' && token) {
      const hash = await this.sha256(token);
      const row = await this.prisma.globalApiToken.findFirst({
        where: { tokenHash: hash, revokedAt: null },
      });
      if (row) {
        (req as any)['apiToken'] = row;
        return true;
      }
    }

    const id = req.params['id'];
    const expRaw = req.query['exp'];
    const sig = req.query['sig'];
    if (typeof expRaw === 'string' && typeof sig === 'string' && id) {
      const exp = parseInt(expRaw, 10);
      if (Number.isFinite(exp) && this.verifySignature(id, exp, sig)) {
        if (exp * 1000 < Date.now()) {
          throw new GoneException('Термін дії підписаного посилання минув.');
        }
        return true;
      }
    }

    throw new UnauthorizedException('Доступ до медіа заборонено.');
  }

  private verifySignature(id: string, exp: number, sig: string): boolean {
    const secret = process.env.MEDIA_URL_SECRET || process.env.SESSION_SECRET || 'change-me-in-production';
    const expected = createHmac('sha256', secret).update(`${id}.${exp}`).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(sig, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async sha256(input: string): Promise<string> {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

export function signMediaUrl(id: string, exp: number): string {
  const secret = process.env.MEDIA_URL_SECRET || process.env.SESSION_SECRET || 'change-me-in-production';
  return createHmac('sha256', secret).update(`${id}.${exp}`).digest('hex');
}
