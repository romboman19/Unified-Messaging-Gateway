import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * Holds the OpenAPI document built during bootstrap.
 *
 * The document can only be produced once the whole app is instantiated, which
 * happens in `main.ts` — after Nest has finished wiring modules. Stashing it
 * here lets a normal, guarded controller serve it, so the API reference is
 * behind the same admin session as everything else instead of being mounted
 * as an unauthenticated route by SwaggerModule.
 */
@Injectable()
export class OpenApiService {
  private document: OpenAPIObject | null = null;

  set(document: OpenAPIObject): void {
    this.document = document;
  }

  get(): OpenAPIObject {
    if (!this.document) {
      throw new ServiceUnavailableException('Документацію API ще не сформовано.');
    }
    return this.document;
  }
}
