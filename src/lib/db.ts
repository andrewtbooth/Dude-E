import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../../prisma/generated/client";

/**
 * Prisma client singleton.
 *
 * Next dev-mode hot reload re-evaluates modules on every edit; without the
 * global cache that leaks a SQLite connection per reload until the process
 * runs out of file handles.
 */
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL ?? "file:./prisma/dude-e.db";
  const adapter = new PrismaBetterSqlite3({ url });
  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
