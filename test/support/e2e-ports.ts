/**
 * Single source of truth for the two fixed ports the E2E suite binds to —
 * previously hardcoded independently in playwright.config.ts, test/e2e/
 * db-server.ts, test/e2e/global-setup.ts, and test/support/e2e-db-client.ts,
 * which could silently drift out of sync. Neither is configurable (unlike
 * TEST_DATABASE_URL's port in test/support/local-postgres.ts, which only
 * this process ever binds to): both must stay fixed so a human running
 * `npm run test:e2e` locally and CI agree on where things live without any
 * extra env wiring.
 */

/** Where playwright.config.ts's webServer runs the real `next start` build — distinct from the local dev server's 3000. */
export const E2E_APP_PORT = 3100;

/** Where test/e2e/db-server.ts (the tsx-subprocess Prisma proxy) listens, loopback-only. */
export const E2E_DB_SERVER_PORT = 3101;
