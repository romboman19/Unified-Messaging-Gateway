import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { MediaAccessGuard } from './media-access.guard';
import { MediaService, MAX_FILE_SIZE, decodeBase64Payload } from './media.service';
import { UploadMediaBase64Dto } from './media.dto';

@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post()
  @UseGuards(SessionGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadMediaBase64Dto,
  ) {
    if (file) {
      return this.media.upload(
        {
          buffer: file.buffer,
          fileName: file.originalname || 'file',
          mimeType: file.mimetype || 'application/octet-stream',
        },
        dto.actorId ?? null,
      );
    }
    if (dto.dataBase64 && dto.fileName) {
      return this.media.upload(
        {
          buffer: decodeBase64Payload(dto.dataBase64),
          fileName: dto.fileName,
          mimeType: dto.mimeType || 'application/octet-stream',
        },
        dto.actorId ?? null,
      );
    }
    throw new UnprocessableEntityException(
      'Потрібен файл (multipart поле "file") або JSON {fileName, mimeType, dataBase64}.',
    );
  }

  @Get(':id/signed-url')
  @UseGuards(SessionGuard)
  signedUrl(@Param('id') id: string) {
    return this.media.createSignedUrl(id);
  }

  @Get(':id')
  @UseGuards(MediaAccessGuard)
  async download(@Param('id') id: string, @Res() res: Response) {
    const { attachment, stream } = await this.media.getForDownload(id);
    res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(attachment.fileName)}"`,
    );
    res.setHeader('Content-Length', String(attachment.sizeBytes));
    stream.pipe(res);
  }

  @Delete(':id')
  @UseGuards(SessionGuard)
  delete(@Param('id') id: string, @Body() body: { actorId?: string }) {
    return this.media.delete(id, body?.actorId ?? null);
  }
}
