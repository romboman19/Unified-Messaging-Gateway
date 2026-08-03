import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { SessionOrTokenGuard } from '../auth/session-or-token.guard';
import { DestinationsService } from './destinations.service';
import { CreateDestinationDto, UpdateDestinationDto } from './destinations.dto';

@Controller('destinations')
export class DestinationsController {
  constructor(private readonly service: DestinationsService) {}

  @Get()
  @UseGuards(SessionOrTokenGuard)
  list() {
    return this.service.list();
  }

  @Post()
  @UseGuards(SessionGuard)
  create(@Body() dto: CreateDestinationDto, @Body('actorId') actorId: string) {
    return this.service.create(dto, actorId ?? null);
  }

  @Post(':id/test')
  @UseGuards(SessionGuard)
  test(@Param('id') id: string, @Body() body: { actorId?: string }) {
    return this.service.test(id, body?.actorId ?? null);
  }

  @Get(':id')
  @UseGuards(SessionOrTokenGuard)
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Patch(':id')
  @UseGuards(SessionGuard)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDestinationDto,
    @Body('actorId') actorId: string,
  ) {
    return this.service.update(id, dto, actorId ?? null);
  }

  @Delete(':id')
  @UseGuards(SessionGuard)
  delete(@Param('id') id: string, @Body() body: { actorId?: string }) {
    return this.service.delete(id, body?.actorId ?? null);
  }
}
