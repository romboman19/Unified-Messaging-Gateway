import { IsString, IsUUID, IsOptional, IsObject, IsEnum } from 'class-validator';
import { ChannelType, MessageType } from '@prisma/client';

export class SendMessageDto {
  @IsEnum(ChannelType)
  channel!: ChannelType;

  @IsOptional()
  @IsUUID()
  accountId!: string;

  @IsOptional()
  @IsUUID()
  endpointId!: string;

  @IsString()
  to!: string;

  @IsEnum(MessageType)
  type!: MessageType;

  @IsObject()
  content!: Record<string, unknown>;

  @IsOptional()
  @IsUUID(undefined, { each: true })
  attachments?: string[];

  @IsOptional()
  @IsString()
  replyToMessageId?: string;

  @IsOptional()
  @IsString()
  scheduledAt?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
