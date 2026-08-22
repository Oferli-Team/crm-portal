import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stopTestDatabase } from "../support/local-postgres";

const PID_FILE = join(process.cwd(), "test-results", ".e2e-db-server.pid");

export default async function globalTeardown(): Promise<void> {
  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    rmSync(PID_FILE, { force: true });
  }

  await stopTestDatabase();
}
