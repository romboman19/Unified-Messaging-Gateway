import { IsIn, IsOptional, IsString, ValidateIf } from 'class-validator';

/**
 * Provisioning DTOs (TZ §1038).
 *
 * The wizard is adapter-aware at the DTO level via a `kind` discriminator:
 *  - `signal`:    only `label` + `deviceName` (phone comes BACK from sidecar).
 *  - `whatsapp`:  only `label` + `phoneE164` (UnoAPI needs phone up front).
 *
 * `ReattachDto` carries the vendor-side externalId of a phone already paired
 * with the sidecar that we want to bind to an existing endpoint row.
 */

export type ProvisionKind = 'signal' | 'whatsapp';

export class ProvisionQrDto {
  /** Discriminator — drives which input fields are required. */
  @IsIn(['signal', 'whatsapp'])
  kind!: ProvisionKind;

  /** Human label that becomes the endpoint's `label`. */
  @IsString()
  label!: string;

  /** Signal only — deviceName visible to the linked phone. */
  @ValidateIf((o: ProvisionQrDto) => o.kind === 'signal')
  @IsString()
  deviceName?: string;

  /** WhatsApp only — phone in E.164 form (used as UnoAPI session path). */
  @ValidateIf((o: ProvisionQrDto) => o.kind === 'whatsapp')
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

export class ReattachDto {
  /** Sidecar-side identifier returned from `GET /v1/accounts` (Signal)
   *  or `GET /admin/sessions` (UnoAPI) — i.e. the phone or device number. */
  @IsString()
  externalId!: string;
}