import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@umg/database';
import argon2 from 'argon2';
import { Inject } from '@nestjs/common';

@Injectable()
export class AuthService {
  constructor(@Inject('PRISMA') private readonly prisma: PrismaClient) {
    void this.bootstrapAdmin();
  }

  async bootstrapAdmin(): Promise<void> {
    const count = await this.prisma.adminUser.count();
    if (count > 0) return;
    const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
    if (!password) return;
    const passwordHash = await argon2.hash(password);
    await this.prisma.adminUser.create({
      data: { username: 'admin', passwordHash },
    });
  }

  async validatePassword(username: string, password: string) {
    const user = await this.prisma.adminUser.findUnique({ where: { username } });
    if (!user) return null;
    const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!ok) return null;
    await this.prisma.adminUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    return { id: user.id, username: user.username };
  }

  async getUser(userId: string) {
    return this.prisma.adminUser.findUnique({
      where: { id: userId },
      select: { id: true, username: true, lastLoginAt: true },
    });
  }
}
