import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import RedisStore from 'connect-redis';
import { createClient } from 'redis';
import { AppModule } from './app.module';
import { LoggerService } from './common/logger.service';

async function bootstrap() {
  const logger = new LoggerService();
  logger.setContext('Bootstrap');
  const app = await NestFactory.create(AppModule, { logger });
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.use(cookieParser(config.get('COOKIE_SECRET')));

  const redisUrl = config.get('REDIS_URL') ?? 'redis://redis:6379';
  const redisClient = createClient({ url: redisUrl });
  redisClient.on('error', (err) => logger.error(err, 'RedisSession'));
  await redisClient.connect();

  app.use(
    session({
      store: new RedisStore({ client: redisClient, prefix: 'umg:sess:' }),
      name: 'umg.session',
      secret: config.get('SESSION_SECRET') ?? 'change-me-in-production',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: config.get('SESSION_SECURE') === 'true',
        httpOnly: true,
        sameSite: 'strict',
        maxAge: 12 * 60 * 60 * 1000, // 12h
      },
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  if (config.get('NODE_ENV') !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Unified Messaging Gateway API')
      .setDescription('Єдиний REST API для SMS, WhatsApp та Signal')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = config.get('PORT') ?? 4000;
  await app.listen(port, '0.0.0.0');
  logger.log(`API listening on 0.0.0.0:${port}`);
}
bootstrap();
