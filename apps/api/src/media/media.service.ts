import {
  Injectable,
  Inject,
  NotFoundException,
  GoneException,
  ConflictException,
  PayloadTooLargeException,
  UnprocessableEntityException,
  Logger,
} from '@nestjs/common';
import { PrismaClient } from '@umg/database';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import { AuditService } from '../common/audit.service';
import { signMediaUrl } from './media-access.guard';

export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export interface UploadInput {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly baseDir = process.env.MEDIA_STORAGE_PATH || '/data/media';

  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  async upload(input: UploadInput, actorId: string | null) {
    if (input.buffer.length > MAX_FILE_SIZE) {
      throw new PayloadTooLargeException('Файл перевищує максимальний розмір 50 МБ.');
    }
    const id = randomUUID();
    const sha256 = createHash('sha256').update(input.buffer).digest('hex');
    const safeName = sanitizeFileName(input.fileName);
    const ext = safeExt(safeName);
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    // Layout per spec §27: /data/media/YYYY/MM/DD/<sha256-prefix>/<uuid>.<ext>
    const relDir = path.join(yyyy, mm, dd, sha256.slice(0, 8));
    const fileName = ext ? `${id}.${ext}` : id;
    const absDir = path.join(this.baseDir, relDir);
    const absPath = path.join(absDir, fileName);

    await fs.mkdir(absDir, { recursive: true });
    await fs.writeFile(absPath, input.buffer);

    const attachment = await this.prisma.attachment.create({
      data: {
        id,
        // messageId is linked later on message send; schema column is nullable.
        messageId: null,
        storagePath: path.join(relDir, fileName),
        fileName: safeName,
        mimeType: input.mimeType,
        sizeBytes: input.buffer.length,
        sha256,
      } as never,
    });

    await this.audit.log(actorId, 'media.uploaded', 'attachment', attachment.id, {}, {
      id: attachment.id,
      fileName: attachment.fileName,
      sizeBytes: attachment.sizeBytes,
      sha256,
    });

    return {
      id: attachment.id,
      fileName: attachment.fileName,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
    };
  }

  async getForDownload(id: string) {
    const attachment = await this.prisma.attachment.findUnique({ where: { id } });
    if (!attachment) throw new NotFoundException('Файл не знайдено.');
    if (attachment.deletedAt) throw new GoneException('Файл було видалено.');
    const absPath = path.join(this.baseDir, attachment.storagePath);
    return {
      attachment,
      stream: createReadStream(absPath),
    };
  }

  async createSignedUrl(id: string) {
    const attachment = await this.prisma.attachment.findUnique({ where: { id } });
    if (!attachment) throw new NotFoundException('Файл не знайдено.');
    if (attachment.deletedAt) throw new GoneException('Файл було видалено.');
    const ttlHours = parseInt(process.env.MEDIA_URL_TTL_HOURS ?? '24', 10) || 24;
    const exp = Math.floor(Date.now() / 1000) + ttlHours * 3600;
    const sig = signMediaUrl(attachment.id, exp);
    return {
      url: `/api/v1/media/${attachment.id}?exp=${exp}&sig=${sig}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  async delete(id: string, actorId: string | null) {
    const attachment = await this.prisma.attachment.findUnique({ where: { id } });
    if (!attachment) throw new NotFoundException('Файл не знайдено.');
    if (attachment.messageId) {
      throw new ConflictException(
        'Неможливо видалити файл, що прив\'язаний до повідомлення (незмінна історія).',
      );
    }
    const absPath = path.join(this.baseDir, attachment.storagePath);
    try {
      await fs.unlink(absPath);
    } catch (err) {
      this.logger.warn(`Файл уже відсутній на диску: ${absPath} (${(err as Error).message})`);
    }
    await this.prisma.attachment.delete({ where: { id } });
    await this.audit.log(actorId, 'media.deleted', 'attachment', id, {
      fileName: attachment.fileName,
      sha256: attachment.sha256,
    }, {});
    return { ok: true };
  }
}

/** Keep alnum, dot, dash, underscore; everything else becomes '_'. No path traversal possible. */
export function sanitizeFileName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? 'file';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'file';
  return cleaned.slice(0, 200);
}

function safeExt(safeName: string): string {
  const idx = safeName.lastIndexOf('.');
  if (idx <= 0) return '';
  return safeName.slice(idx + 1).toLowerCase().slice(0, 16);
}

export function decodeBase64Payload(dataBase64: string): Buffer {
  const buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length === 0 && dataBase64.length > 0) {
    throw new UnprocessableEntityException('Некоректні base64-дані файлу.');
  }
  if (buffer.length > MAX_FILE_SIZE) {
    throw new PayloadTooLargeException('Файл перевищує максимальний розмір 50 МБ.');
  }
  return buffer;
}
