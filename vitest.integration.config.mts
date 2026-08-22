import { defineConfig } from "vitest/config";

// Separate from vitest.config.mts (unit tests) so unit runs never pay the
// cost of starting the test database or loading the Supabase/storage
// mocks — those only make sense for test/integration.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/global-setup.ts"],
    setupFiles: ["test/integration/setup-env.ts", "test/integration/setup-mocks.ts"],
    // The whole suite shares one PGlite instance (see test/support/
    // local-postgres.ts), whose socket server can only service one
    // connection at a time (see src/lib/prisma.ts's PGLITE_TEST_DB pool
    // cap) — running test files in parallel worker processes would mean
    // multiple separate pools contending for that single connection, so
    // keep file execution sequential.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
