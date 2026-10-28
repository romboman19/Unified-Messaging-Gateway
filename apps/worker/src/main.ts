import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  // dist/main.js → apps/worker/dist → repo root, the same layout as in the image.
  const version = (() => {
    try {
      return JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8')).version;
    } catch {
      return 'unknown';
    }
  })();
  new Logger('Worker').log(`UMG worker v${version} started`);
  await new Promise<void>(() => {});
}
bootstrap();
