import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class SessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const user = (req.session as any)?.['user'];
    if (!user) throw new UnauthorizedException('Сесія недійсна. Увійдіть знову.');
    (req as any)['user'] = user;
    return true;
  }
}
