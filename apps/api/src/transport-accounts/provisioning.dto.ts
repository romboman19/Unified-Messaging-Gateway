import { IsOptional, IsString } from 'class-validator';

/**
 * Provisioning DTOs (TZ §1038).
 *
 * The wizard is adapter-aware at the controller level: signal expects a
 * `deviceName`, WhatsApp expects a phone (`label` carries the E.164 in
 * that case). The optional `phoneE164` field lets the API pre-fill the
 * endpoint row.
 */
export class ProvisionQrDto {
  /** Human label that becomes the endpoint's `label`. */
  @IsString()
  label!: string;

  /**
   * For Signal: the deviceName visible to the linked phone.
   * For WhatsApp: the phone number in E.164 (used as the path param).
   */
  @IsString()
  deviceName!: string;

  /** Optional pre-known E.164 — used by the wizard for WhatsApp. */
  @IsOptional()
  @IsString()
  phoneE164?: string;
}

export class ProvisionVerifyDto {
  @IsString()
  code!: string;

  @IsOptional()
  @IsString()
  token?: string;
}