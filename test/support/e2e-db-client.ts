import type { TestFixtures } from "../fixtures/seed";
import { E2E_DB_SERVER_PORT } from "./e2e-ports";

// Talks to test/e2e/db-server.ts (a tsx subprocess started in globalSetup)
// over plain HTTP — this file itself never imports @/lib/prisma or the
// generated Prisma client, so it loads fine under Playwright Test's own
// transform (see the Stage 5 report for why that matters).
const DB_SERVER_URL = `http://127.0.0.1:${E2E_DB_SERVER_PORT}`;

export async function seedFixtures(): Promise<TestFixtures> {
  const res = await fetch(`${DB_SERVER_URL}/seed`, { method: "POST" });
  if (!res.ok) throw new Error(`seedFixtures failed: ${await res.text()}`);
  return res.json();
}

export async function cleanupFixtures(fixtures: TestFixtures): Promise<void> {
  const res = await fetch(`${DB_SERVER_URL}/cleanup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fixtures }),
  });
  if (!res.ok) throw new Error(`cleanupFixtures failed: ${await res.text()}`);
}

/** Generic escape hatch for ad-hoc DB assertions: dbQuery("client", "findUnique", { where: { id } }). */
export async function dbQuery<T = unknown>(model: string, operation: string, args?: unknown): Promise<T> {
  const res = await fetch(`${DB_SERVER_URL}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, operation, args }),
  });
  if (!res.ok) throw new Error(`dbQuery(${model}.${operation}) failed: ${await res.text()}`);
  return res.json();
}
