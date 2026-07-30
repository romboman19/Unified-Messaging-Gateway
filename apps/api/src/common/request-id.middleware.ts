import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    (req as any)['requestId'] = req.headers['x-request-id'] ?? randomUUID();
    res.setHeader('x-request-id', (req as any)['requestId'] as string);
    next();
  }
}
