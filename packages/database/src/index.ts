import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'production'
    ? ['warn', 'error']
    : ['query', 'info', 'warn', 'error'],
});
