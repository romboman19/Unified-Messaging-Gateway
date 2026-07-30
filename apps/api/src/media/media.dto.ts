import { IsOptional, IsString, IsMimeType } from 'class-validator';

export class UploadMediaBase64Dto {
  @IsOptional()
  @IsString()
  fileName?: string;

  @IsOptional()
  @IsMimeType()
  mimeType?: string;

  @IsOptional()
  @IsString()
  dataBase64?: string;

  @IsOptional()
  @IsString()
  actorId?: string;
}
