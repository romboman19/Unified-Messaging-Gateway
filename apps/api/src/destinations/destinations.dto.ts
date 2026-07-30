import {
  IsString,
  MinLength,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsUrl,
  IsObject,
  IsArray,
  IsInt,
  Min,
  ValidateIf,
} from 'class-validator';
import { DestinationType } from '@prisma/client';

export class CreateDestinationDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsEnum(DestinationType)
  type!: DestinationType;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @ValidateIf((o) => o.url !== null)
  @IsUrl({ require_tld: false })
  url?: string | null;

  @IsOptional()
  @IsString()
  secret?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  fieldSelector?: string[];

  @IsOptional()
  @ValidateIf((o) => o.template !== null)
  @IsObject({ message: 'templateJson має бути JSON-об\'єктом.' })
  template?: Record<string, unknown> | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  timeoutMs?: number;

  @IsOptional()
  @IsString()
  actorId?: string;
}

export class UpdateDestinationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsEnum(DestinationType)
  type?: DestinationType;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @ValidateIf((o) => o.url !== null)
  @IsUrl({ require_tld: false })
  url?: string | null;

  @IsOptional()
  @IsString()
  secret?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  fieldSelector?: string[];

  @IsOptional()
  @ValidateIf((o) => o.template !== null)
  @IsObject({ message: 'templateJson має бути JSON-об\'єктом.' })
  template?: Record<string, unknown> | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  timeoutMs?: number;

  @IsOptional()
  @IsString()
  actorId?: string;
}
