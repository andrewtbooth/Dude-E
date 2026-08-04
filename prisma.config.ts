import path from "node:path";
import { defineConfig } from "prisma/config";

/**
 * Prisma 7 reads the migration/introspection connection URL from here rather
 * than from schema.prisma. The runtime connection is separate — see
 * src/lib/db.ts, which passes a better-sqlite3 driver adapter.
 */
export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "file:./prisma/dude-e.db",
  },
});
