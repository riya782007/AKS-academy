import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __db__: PrismaClient | undefined;
}

function createPrismaClient() {
  return new PrismaClient({
    log: process.env.NODE_ENV === "development"
      ? ["query", "error", "warn"]
      : ["error"],
  });
}

// Singleton pattern to avoid connection exhaustion in dev (hot reload)
const db = globalThis.__db__ ?? createPrismaClient();
if (process.env.NODE_ENV !== "production") globalThis.__db__ = db;

export { db };
