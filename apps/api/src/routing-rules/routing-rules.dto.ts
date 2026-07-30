import {
  IsString,
  MinLength,
  IsOptional,
  IsBoolean,
  IsInt,
  IsArray,
  IsObject,
  IsUUID,
} from 'class-validator';

export class CreateRoutingRuleDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  priority?: number;

  @IsArray()
  @IsString({ each: true })
  eventTypes!: string[];

  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  fieldSelector?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  destinationIds?: string[];

  @IsOptional()
  @IsString()
  actorId?: string;
}

export class UpdateRoutingRuleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  eventTypes?: string[];

  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  fieldSelector?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  destinationIds?: string[];

  @IsOptional()
  @IsString()
  actorId?: string;
}
