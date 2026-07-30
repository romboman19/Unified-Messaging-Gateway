import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@umg/database';
import { Inject } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';

@Injectable()
export class ApiTokensService {
  constructor(@Inject('PRISMA') private readonly prisma: PrismaClient) {}

  async generate(name = 'default') {
    const raw = 'umg_' + randomBytes(32).toString('hex');
    const hash = this.sha256(raw);
    await this.prisma.globalApiToken.create({
      data: { name, tokenHash: hash },
    });
    return { token: raw, name };
  }

  async list() {
    return this.prisma.globalApiToken.findMany({
      select: { id: true, name: true, createdAt: true, lastUsedAt: true, revokedAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revoke(id: string) {
    return this.prisma.globalApiToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  private sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }
}
