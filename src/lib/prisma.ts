import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";
import { attachDatabasePool } from "@vercel/functions";
import { Pool } from "pg";

import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";
import { isServerless } from "@/lib/serverless";

// Reuse one client across hot reloads in development instead of opening a new
// connection pool on every change.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function client(): PrismaClient {
  globalForPrisma.prisma ??= new PrismaClient({ adapter: adapter() });
  return globalForPrisma.prisma;
}

function adapter(): PrismaPg {
  if (!isServerless()) return new PrismaPg({ connectionString: env.DATABASE_URL });
  // On Vercel: a few connections per instance (DATABASE_URL should be the
  // pooled one, e.g. Neon's), released before an idle instance is paused.
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 5, idleTimeoutMillis: 5_000 });
  attachDatabasePool(pool);
  return new PrismaPg(pool);
}

/**
 * The shared database client. It's created on first use rather than on
 * import, so `next build`, which imports every page, works without the
 * secrets that reading `env` requires.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_, key) {
    const target = client();
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
