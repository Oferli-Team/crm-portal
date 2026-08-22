import { afterAll } from "vitest";
import { TEST_DATABASE_URL } from "../support/local-postgres";

// Runs before each integration test file loads (Vitest `setupFiles`, once
// per worker) — must happen before anything imports @/lib/prisma, whose
// PrismaPg adapter reads DATABASE_URL at module-eval time. This is what
// lets integration tests `import { prisma } from "@/lib/prisma"` and get
// the exact same singleton the app's own Server Actions use, transparently
// pointed at the test database instead of whatever's in .env.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
// See src/lib/prisma.ts — caps the pool at one connection, since PGlite's
// socket server can't service concurrent connections.
process.env.PGLITE_TEST_DB = "1";

// Each test file gets its own fresh @/lib/prisma module instance (and
// therefore its own pg.Pool), but nothing ever explicitly closes it — the
// pool keeps an idle connection open by design. With the single-connection
// cap above, an unclosed connection from one finished test file was
// intermittently contending with the next file's brand-new connection
// attempt against PGlite, surfacing as flaky "Server has closed the
// connection"/"Connection terminated unexpectedly" errors. Disconnecting
// here — a global afterAll every integration test file picks up via
// setupFiles — closes each file's connection before the next file opens
// its own.
afterAll(async () => {
  const { prisma } = await import("@/lib/prisma");
  await prisma.$disconnect();
});
