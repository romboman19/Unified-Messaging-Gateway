import { Injectable, LoggerService as NestLogger } from '@nestjs/common';
import pino from 'pino';

@Injectable()
export class LoggerService implements NestLogger {
  private readonly logger: pino.Logger;
  private context = 'UMG';

  constructor() {
    this.logger = pino({
      level: process.env.LOG_LEVEL ?? 'info',
      transport: process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    });
  }

  setContext(ctx: string) { this.context = ctx; }

  log(message: string, ...args: unknown[]) { this.logger.info({ context: this.context, args }, message); }
  error(message: unknown, trace?: string, ...args: unknown[]) {
    if (message instanceof Error) {
      this.logger.error({ context: this.context, err: message, trace, args }, message.message);
    } else {
      this.logger.error({ context: this.context, trace, args }, String(message));
    }
  }
  warn(message: string, ...args: unknown[]) { this.logger.warn({ context: this.context, args }, message); }
  debug(message: string, ...args: unknown[]) { this.logger.debug({ context: this.context, args }, message); }
  verbose(message: string, ...args: unknown[]) { this.logger.trace({ context: this.context, args }, message); }
}
