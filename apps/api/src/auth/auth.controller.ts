import { Controller, Post, Get, Body, Session, Request, UseGuards, Res, HttpCode } from '@nestjs/common';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { SessionGuard } from './session.guard';
import { LoginDto } from './login.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Session() sess: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.auth.validatePassword(dto.username, dto.password);
    if (!user) {
      res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Невірний логін або пароль.', requestId: '' } });
      return;
    }
    sess['user'] = user;
    return { user };
  }

  @Post('logout')
  @UseGuards(SessionGuard)
  @HttpCode(200)
  logout(@Session() sess: any) {
    sess.destroy(() => {});
    return { ok: true };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  async me(@Request() req: unknown) {
    const user = (req as { user: { id: string } }).user;
    return this.auth.getUser(user.id);
  }
}
