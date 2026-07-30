import { IsEnum, IsOptional, IsString, IsObject, IsBoolean } from 'class-validator';
import { ChannelType, TransportStatus } from '@prisma/client';

export class CreateTransportAccountDto {
  @IsEnum(ChannelType)
  type!: ChannelType;

  @IsString()
  adapter!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsEnum(TransportStatus)
  status?: TransportStatus;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class UpdateTransportAccountDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(TransportStatus)
  status?: TransportStatus;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class CreateEndpointDto {
  @IsString()
  label!: string;

  @IsOptional()
  @IsString()
  externalId?: string;

  @IsOptional()
  @IsString()
  phoneRaw?: string;

  @IsOptional()
  @IsString()
  phoneE164?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class UpdateEndpointDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  externalId?: string;

  @IsOptional()
  @IsString()
  phoneRaw?: string;

  @IsOptional()
  @IsString()
  phoneE164?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}
