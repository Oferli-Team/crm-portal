// E2E test files cannot import @/lib/prisma directly — Playwright Test's
// own transform can't load the generated Prisma client (see test/e2e/
// db-server.ts's header comment). These re-exports are the HTTP-backed
// equivalents test/e2e specs should use instead; the underlying fixture
// graph is identical to Stage 4's (test/fixtures/seed.ts), just reached
// over test/e2e/db-server.ts rather than in-process.
export { seedFixtures as seedE2EFixtures, cleanupFixtures as cleanupTestData, dbQuery } from "../support/e2e-db-client";
export type { TestFixtures } from "../fixtures/seed";
