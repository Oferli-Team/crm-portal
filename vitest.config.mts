import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    // Invoice System Official Slice 3, sub-PR 3a — invoice-pdf-document.test.tsx
    // is the first .tsx unit test in this repo (it exercises the React-pdf
    // <InvoicePdfDocument> element directly). Additive only — every existing
    // *.test.ts file still matches unchanged.
    include: ["test/unit/**/*.test.ts", "test/unit/**/*.test.tsx", "test/integration/**/*.test.ts"],
    exclude: ["test/e2e/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      // Only the pure modules Stage 3's unit suite actually exercises —
      // the rest of src/ needs Prisma/Next/Supabase and belongs to
      // integration/E2E coverage in a later stage, not this number.
      include: [
        "src/lib/safe-redirect.ts",
        "src/lib/format.ts",
        "src/lib/supabase/cookie-options.ts",
        "src/lib/rate-limit/store.ts",
        "src/lib/rate-limit/index.ts",
        "src/lib/storage/attachment-files.ts",
        "src/lib/dashboard/period.ts",
        "src/lib/dashboard/revenue.ts",
        "src/lib/activity/attachment-metadata.ts",
        "src/lib/activity/portal-metadata.ts",
        "src/lib/activity/team-metadata.ts",
        "src/lib/activity/client-metadata.ts",
        "src/lib/activity/project-metadata.ts",
        "src/lib/activity/task-metadata.ts",
        "src/lib/activity/invoice-metadata.ts",
        "src/lib/activity/format-activity.ts",
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 80,
        statements: 90,
      },
    },
  },
});
