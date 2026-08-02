import { Global, Module } from '@nestjs/common';
import { OpenApiController } from './openapi.controller';
import { OpenApiService } from './openapi.service';

/** Global so `main.ts` can reach the service to hand over the document. */
@Global()
@Module({
  controllers: [OpenApiController],
  providers: [OpenApiService],
  exports: [OpenApiService],
})
export class OpenApiModule {}
