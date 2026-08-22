import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { startTestDatabase, TEST_DATABASE_URL } from "../support/local-postgres";
import { E2E_DB_SERVER_PORT } from "../support/e2e-ports";

// Written here, read by global-teardown.ts — a plain file rather than an
// env var, since Playwright doesn't guarantee globalSetup/globalTeardown
// share a process (an in-memory handle wouldn't reliably survive between them).
const PID_FILE = join(process.cwd(), "test-results", ".e2e-db-server.pid");

async function waitForDbServer(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${E2E_DB_SERVER_PORT}/seed`, { method: "OPTIONS" }).catch(() => null);
      // Any response (even 404 for OPTIONS) means the server is up.
      if (res) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`test/e2e/db-server.ts never became reachable on port ${E2E_DB_SERVER_PORT}`);
}

// Runs once before Playwright starts its webServer (see playwright.config.ts):
//  1. starts the shared in-process PGlite Postgres (test/support/
//     local-postgres.ts) — the same one Stage 4's integration suite uses.
//  2. starts test/e2e/db-server.ts as its own tsx subprocess, the only
//     thing in this whole E2E setup allowed to import @/lib/prisma
//     directly (see that file's own header comment for why).
export default async function globalSetup(): Promise<void> {
  await startTestDatabase();

  const dbServerProcess = spawn("npx", ["tsx", "test/e2e/db-server.ts"], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, PGLITE_TEST_DB: "1" },
    stdio: "inherit",
    detached: true,
  });
  dbServerProcess.unref();

  if (dbServerProcess.pid) {
    mkdirSync(dirname(PID_FILE), { recursive: true });
    writeFileSync(PID_FILE, String(dbServerProcess.pid));
  }

  await waitForDbServer();
}
