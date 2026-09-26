import { PrismaClient, Prisma } from '@prisma/client';

export * from '@prisma/client';

/** Merge only supplied top-level keys so balance callbacks cannot erase settings. */
export async function mergeEndpointConfig(
  db: Pick<Prisma.TransactionClient, '$executeRaw'>,
  endpointId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db.$executeRaw`
    UPDATE endpoints SET config_json = config_json || ${JSON.stringify(patch)}::jsonb,
      updated_at = clock_timestamp()
    WHERE id = ${endpointId}
  `;
}

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'production'
    ? ['warn', 'error']
    : ['query', 'info', 'warn', 'error'],
});
