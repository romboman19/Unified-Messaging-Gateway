import { IsOptional, IsBoolean, IsObject, IsString } from 'class-validator';

export class UpdateAlertRuleDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsObject()
  configJson?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  actorId?: string;
}
