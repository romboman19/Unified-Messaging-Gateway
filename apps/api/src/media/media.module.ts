import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MediaAccessGuard } from './media-access.guard';

@Module({
  controllers: [MediaController],
  providers: [MediaService, MediaAccessGuard],
  exports: [MediaService],
})
export class MediaModule {}
