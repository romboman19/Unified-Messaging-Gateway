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
import { RoutingRulesService } from './routing-rules.service';
import { CreateRoutingRuleDto, UpdateRoutingRuleDto } from './routing-rules.dto';

@Controller('routing-rules')
@UseGuards(SessionGuard)
export class RoutingRulesController {
  constructor(private readonly service: RoutingRulesService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Post()
  create(@Body() dto: CreateRoutingRuleDto, @Body('actorId') actorId: string) {
    return this.service.create(dto, actorId ?? null);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRoutingRuleDto,
    @Body('actorId') actorId: string,
  ) {
    return this.service.update(id, dto, actorId ?? null);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @Body() body: { actorId?: string }) {
    return this.service.delete(id, body?.actorId ?? null);
  }
}
