import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import pg from "pg";

const execFileAsync = promisify(execFile);

// A real Postgres engine (PGlite compiles actual Postgres to WASM),
// reachable over a normal TCP wire-protocol connection — not a mock, not
// pg-mem's reimplementation. This exists because this sandbox has neither
// Docker nor a writable Homebrew, so a real `supabase start`/system
// Postgres isn't available (see Stage 4's report for the full story).
// `prisma migrate deploy` and the app's own `@prisma/adapter-pg` both
// connect to this exactly as they would to any real Postgres server.
const TEST_DB_HOST = "127.0.0.1";
const TEST_DB_PORT = 55432;

export const TEST_DATABASE_URL = `postgresql://postgres@${TEST_DB_HOST}:${TEST_DB_PORT}/postgres`;

let pglite: PGlite | undefined;
let socketServer: PGLiteSocketServer | undefined;

/**
 * Starts the in-process Postgres engine, creates stand-ins for the two
 * Supabase-managed roles the lockdown migration (20260802120937) revokes
 * privileges from, and applies every migration via a real `prisma migrate
 * deploy` subprocess. Idempotent-ish for one process lifetime — call once
 * per test run (see test/integration/global-setup.ts).
 */
async function waitForSocketReady(): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client({
      host: TEST_DB_HOST,
      port: TEST_DB_PORT,
      database: "postgres",
      user: "postgres",
    });
    try {
      await client.connect();
      await client.end();
      return;
    } catch (err) {
      lastError = err;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`PGlite socket server never became reachable: ${String(lastError)}`);
}

export async function startTestDatabase(): Promise<void> {
  pglite = new PGlite();
  // maxConnections defaults to 1 in @electric-sql/pglite-socket, which caps
  // *TCP connections*, not concurrent queries (those are already serialized
  // per-handler by its internal query queue regardless of connection count).
  // The E2E suite has two separate OS processes each holding their own
  // connection — the long-lived test/e2e/db-server.ts subprocess and the
  // `next start` webServer — so the default of 1 rejects whichever
  // connects second ("Too many connections"), which Prisma then surfaces
  // as a P1017 ConnectionClosed error. A small headroom avoids that without
  // giving up single-writer safety (queries still queue, not run in true
  // parallel).
  socketServer = new PGLiteSocketServer({ db: pglite, host: TEST_DB_HOST, port: TEST_DB_PORT, maxConnections: 5 });
  await socketServer.start();
  // PGLiteSocketServer's start() can resolve slightly before the
  // underlying net.Server is actually accepting connections — wait for a
  // real TCP handshake to succeed rather than racing the subprocess below
  // against that gap.
  await waitForSocketReady();

  // `anon`/`authenticated` are real roles on a Supabase project (owned by
  // the platform, not this app's migrations) — they don't exist on a bare
  // Postgres, so the lockdown migration's REVOKE statements would
  // otherwise fail with "role does not exist". Creating them as inert
  // stand-ins lets every migration apply exactly as it does against a
  // real Supabase project; verifying the REVOKE actually took effect is
  // what test/integration/security/grants.test.ts checks.
  await pglite.query("CREATE ROLE anon NOLOGIN");
  await pglite.query("CREATE ROLE authenticated NOLOGIN");

  // Must be the async execFile, never execFileSync: PGlite runs in this
  // same process (a WASM instance driven by the Node event loop), so a
  // *synchronous* child-process wait would freeze the very engine the
  // migrate subprocess is trying to talk to over the socket — it would
  // accept the TCP connection (that much happens at the OS level) but
  // never actually process a query, and the subprocess would eventually
  // report "can't reach database server". Keeping this async lets the
  // event loop keep driving PGlite while the subprocess runs.
  await execFileAsync("npx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      DIRECT_URL: TEST_DATABASE_URL,
    },
  });
}

/**
 * Sale-Ready Phase E, E3.4. `pglite.close()` below is Postgres itself
 * shutting down inside the WASM sandbox — Emscripten's generated runtime
 * maps that internal `exit()`/`proc_exit()` call to its own `quit_`
 * helper, which does a bare `process.exitCode = status` on the *host*
 * Node process (confirmed by reading `node_modules/@electric-sql/pglite/
 * dist/pglite.js`'s own `quit_=(status,toThrow)=>{process.exitCode=status;
 * throw toThrow}`, and proven live: instrumenting a run showed
 * `process.exitCode` flip from Vitest's own correctly-set `1` to `0`
 * across exactly this call, with no other code in between). Postgres always
 * shuts down "successfully" from its own WASM-internal point of view
 * (`status` 0) regardless of whether the test suite that happened to be
 * using it passed or failed — so left alone, this unconditionally
 * overwrites Vitest's real exit code with 0 during every single
 * integration run, which is exactly why `npm run test:integration` was
 * reporting failing tests but exiting 0 (masking real regressions from
 * CI). Saving/restoring `process.exitCode` around this one shutdown
 * sequence is the narrowest fix: it doesn't touch Vitest, doesn't touch
 * `@electric-sql/pglite`, and doesn't change what either program observes
 * about its own execution — only that a third party's internal "I exited
 * 0" no longer leaks into a process-global property this test runner
 * doesn't own.
 */
export async function stopTestDatabase(): Promise<void> {
  const exitCodeBeforeShutdown = process.exitCode;
  await socketServer?.stop();
  await pglite?.close();
  process.exitCode = exitCodeBeforeShutdown;
  pglite = undefined;
  socketServer = undefined;
}
