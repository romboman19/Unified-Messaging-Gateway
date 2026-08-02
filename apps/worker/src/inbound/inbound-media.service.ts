import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@umg/database';
import type { AccountConfig, CanonicalContent, ChannelAdapter } from '@umg/channel-sdk';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Mirrors the API's upload cap so both entry points agree (spec §27). */
const MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Downloads inbound attachments off the vendor sidecar and stores them as
 * `Attachment` rows (TZ §27).
 *
 * This has to happen at ingest time, not lazily: gwmd keeps decrypted media in
 * the container's writable layer — no volume — and signal-cli discards
 * attachments once its queue is drained. A reference we do not resolve now is
 * a file that is simply gone later.
 *
 * Storage layout matches the API's MediaService exactly, since both write into
 * the same `umg-media-data` volume and the API serves what we write:
 *   /data/media/YYYY/MM/DD/<sha256-prefix>/<uuid>.<ext>
 */
@Injectable()
export class InboundMediaService {
  private readonly logger = new Logger(InboundMediaService.name);
  private readonly baseDir = process.env.MEDIA_STORAGE_PATH || '/data/media';

  constructor(@Inject('PRISMA') private readonly prisma: PrismaClient) {}

  /**
   * Resolves every attachment reference on the message and persists the bytes.
   * Failures are logged and skipped: a message whose photo we could not fetch
   * is still worth keeping, and throwing here would retry the whole ingest and
   * duplicate nothing but work.
   *
   * @returns how many attachments were stored
   */
  async storeFor(
    messageId: string,
    content: CanonicalContent,
    adapter: ChannelAdapter,
    account: AccountConfig,
  ): Promise<number> {
    const refs = content.attachments ?? [];
    if (refs.length === 0) return 0;
    if (!adapter.fetchInboundMedia) {
      this.logger.warn(
        `Adapter ${adapter.name} reported ${refs.length} attachment(s) but cannot fetch them`,
      );
      return 0;
    }

    let stored = 0;
    for (const ref of refs) {
      if (!ref.ref) continue; // outbound-shaped entry; nothing to fetch
      try {
        const file = await adapter.fetchInboundMedia(account, ref.ref);
        if (file.bytes.length === 0) {
          this.logger.warn(`Attachment ${ref.ref} came back empty; skipping`);
          continue;
        }
        if (file.bytes.length > MAX_FILE_SIZE) {
          this.logger.warn(
            `Attachment ${ref.ref} is ${file.bytes.length} bytes, over the ${MAX_FILE_SIZE} limit; skipping`,
          );
          continue;
        }
        await this.persist(messageId, Buffer.from(file.bytes), {
          fileName: ref.filename ?? file.fileName,
          mimeType: ref.mime ?? file.contentType,
        });
        stored++;
      } catch (err) {
        this.logger.error(
          `Could not store attachment ${ref.ref} for message ${messageId}: ${(err as Error).message}`,
        );
      }
    }
    return stored;
  }

  private async persist(
    messageId: string,
    buffer: Buffer,
    meta: { fileName: string; mimeType: string },
  ): Promise<void> {
    const id = randomUUID();
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const safeName = sanitizeFileName(meta.fileName);
    const ext = safeExt(safeName) || extFromMime(meta.mimeType);

    const now = new Date();
    const relDir = path.join(
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      String(now.getUTCDate()).padStart(2, '0'),
      sha256.slice(0, 8),
    );
    const fileName = ext ? `${id}.${ext}` : id;
    const absDir = path.join(this.baseDir, relDir);

    await fs.mkdir(absDir, { recursive: true });
    await fs.writeFile(path.join(absDir, fileName), buffer);

    await this.prisma.attachment.create({
      data: {
        id,
        messageId,
        storagePath: path.join(relDir, fileName),
        fileName: safeName,
        mimeType: meta.mimeType,
        sizeBytes: buffer.length,
        sha256,
      } as never,
    });
    this.logger.log(`Stored ${buffer.length}B attachment ${id} (${meta.mimeType}) for ${messageId}`);
  }
}

/** Strips directories and anything that could escape the storage root. */
function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'attachment';
  const clean = base.replace(/[^\w.\-Ѐ-ӿ ]+/g, '_').slice(0, 200);
  return clean || 'attachment';
}

function safeExt(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/** Vendors do not always give a filename, but they do give a content type. */
function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/aac': 'aac',
    'application/pdf': 'pdf',
  };
  return map[mime.split(';')[0].trim()] ?? '';
}
