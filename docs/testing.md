# Testing

This project has three layers of automated tests, each verifying something
the layer below it structurally cannot. If you're new here, the short
version: **unit tests check pure logic, integration tests check real
Prisma/Postgres behavior through real Server Actions, and E2E tests check
that a real browser sees the right thing.** Nothing is duplicated between
layers on purpose — see "Why some things are deliberately not E2E" below.

| Layer | Runner | Talks to | Files | Tests |
|---|---|---|---|---|
| Unit | Vitest | nothing external | `test/unit/*.test.ts` (10) | 174 |
| Integration | Vitest | real Prisma + PGlite Postgres | `test/integration/**/*.test.ts` (8) | 47 |
| E2E | Playwright | real browser + real `next start` build + PGlite | `test/e2e/*.spec.ts` (7) | 17 |

Plus a fourth, non-test layer: **static security checks**
(`npm run security:check`) — see [Static security checks](#static-security-checks)
below.

## Unit tests (`test/unit/`)

Pure functions only: formatters, validators, metadata builders, the
rate-limit store, `safe-redirect.ts`'s sanitizers. No database, no Next.js
request context, no network. Run with `npm run test:unit` (or
`test:unit:coverage` for a coverage report, `test:unit:watch` while
iterating). These are the fastest tests in the repo and should stay that
way — if a "unit" test needs to mock Prisma or `next/headers`, it likely
belongs in `test/integration/` instead.

## Integration tests (`test/integration/`)

Exercise real Server Actions and query functions against a **real Postgres
engine** — not a mock, not an in-memory reimplementation. Specifically:
[PGlite](https://pglite.dev/) (Postgres compiled to WASM) fronted by
[`@electric-sql/pglite-socket`](https://github.com/electric-sql/pglite/tree/main/packages/pglite-socket),
which speaks the real Postgres wire protocol over a real TCP socket. Prisma
and `prisma migrate deploy` connect to it exactly as they would to any real
Postgres server (see `test/support/local-postgres.ts`).

This exists because the sandbox this project was built in has neither
Docker nor a writable Homebrew, so a real `supabase start` isn't available.
It is not a permanent substitute for testing against real Supabase — see
[Limitations](#limitations).

What's real here: the Prisma schema, every migration (including the RLS/grants
lockdown migration — see `test/integration/security/grants.test.ts`), every
Server Action's actual database logic, transactions, unique constraints,
foreign keys, cascades.

What's mocked (see `test/integration/setup-mocks.ts` for the exhaustive
list, and *why* each one): `next/headers`' `cookies()`, `next/navigation`'s
`redirect()`/`notFound()`, `next/cache`'s `revalidatePath()`, and
`@/lib/supabase/server`'s `createClient()` (a fake Auth client backed by
`test/support/auth-mock.ts`'s `setMockAuthUser()`). Each of these needs
either a live Next.js request context or a live external network call that
plain Vitest doesn't provide — everything else in a Server Action's own
logic runs unmodified.

Run with `npm run test:integration`. Fixtures are seeded via
`test/fixtures/seed.ts` and torn down via `test/fixtures/cleanup.ts`, both
namespaced per run by `test/support/run-id.ts`'s `getRunId()` so nothing
collides across parallel or repeated runs.

## E2E tests (`test/e2e/`)

Real Chromium, driving a real production build (`next build` + `next
start`, never the dev server, never a Vercel Preview URL), against the
same PGlite-backed Postgres approach as the integration suite (a
**separate** instance — see [Architecture](#architecture) below).

This layer exists for exactly one reason: **some things can only be
verified by a real browser rendering real HTML and running real
middleware/routing**, not by calling a Server Action function directly in
Vitest. It is deliberately small — 7 files, 17 tests — because most of the
app's logic is already covered at the integration layer, which is faster,
more deterministic, and easier to debug. E2E is for the seam between
"the Server Action returned the right data" and "the user's browser ended
up on the right page seeing the right thing."

### What each E2E file covers

| File | Scenario |
|---|---|
| `staff-app.spec.ts` | Dashboard, sidebar navigation, Client create → edit → delete (+ the dashboard metric reacting to it), sign-out / no-session redirect |
| `org-isolation.spec.ts` | A forged `active_organization_id` cookie pointing at an org the user isn't a member of never leaks that org's data, and falls back to an org the user actually belongs to |
| `portal.spec.ts` | The Client Portal's separate identity boundary: `/portal` opens, `/dashboard` redirects a portal-only identity to `/portal`, no staff navigation ever renders, logout / no-session redirect |
| `invitation.spec.ts` | A real invitation-accept flow (open the link, accept, Membership created), and that re-opening the same link afterward shows a safe "already accepted" state rather than re-running anything |
| `attachments.spec.ts` | A real file upload via an actual `<input type="file">`, the download link's redirect, delete returning to the empty state |
| `activity.spec.ts` | A real UI action (creating a client) produces a visible entry on `/activity` |
| `security-ui.spec.ts` | A malicious `redirectTo` never escapes the app (staff and portal login), and injected `<script>`-like text renders as literal text and never executes |

Run with `npm run test:e2e`. Requires `npm run build` to have already
produced `.next/` — `playwright.config.ts`'s `webServer` runs `next start`
against that build, it does not build for you.

### TEST_MODE

There is no real Supabase Auth or Storage available in this environment
(same underlying constraint as the integration suite's mocks above), and a
real Chromium session can't be handed a mocked `createClient()` the way
Vitest can — the app is a real, running, compiled server. So instead,
`src/lib/test-mode.ts` defines a single boolean gate:

```ts
export const TEST_MODE = process.env.TEST_MODE === "1";
```

`TEST_MODE` is set **only** in `playwright.config.ts`'s `webServer.env`,
which only applies to the one `next start` process Playwright itself
spawns for an E2E run. It is never set by `.env`/`.env.example`, never by
`vercel.json`, never by a real deployment, never by `npm run build`/`npm
start` run normally. With `TEST_MODE` unset — which is every situation
except Playwright's own E2E run — every file gated on it falls through to
its original, real behavior, byte-for-byte.

Two things are gated on it, in exactly four production files:

- **Identity** (`src/lib/supabase/server.ts`, `src/lib/supabase/middleware.ts`):
  instead of a real Supabase session, the app reads an httpOnly cookie
  (`x_e2e_test_user`, written by `test/support/e2e-session.ts`'s
  `injectTestSession()`) containing a base64url-encoded `{ id, email }`.
  Everything downstream of "who is the current user" — Prisma queries
  scoped by `organizationId`/`clientId`, role checks, Membership
  lookups — still runs for real; only the identity *resolution* step is
  short-circuited.
- **Storage** (`src/lib/storage/attachments-storage.ts`,
  `src/lib/storage/test-storage.ts`, and the serving route
  `src/app/api/e2e-test-storage/[...path]/route.ts`): an in-memory object
  store stands in for a real Supabase Storage bucket, since one isn't
  reachable here either. Upload/download/delete all exercise the real
  validation, the real `Attachment` row, and the real Activity log — only
  the object bytes live in memory instead of a real bucket.

**How this is verified to never affect a real deployment** — not just
asserted in a comment, checked by `npm run security:check`
(`scripts/security-checks/check-no-test-mode.mjs`):

1. No committed config (`.env.example`, `vercel.json`, `package.json`)
   ever sets `TEST_MODE` to a truthy value.
2. `process.env.TEST_MODE` is read in exactly one file
   (`src/lib/test-mode.ts`) — every consumer imports the shared constant,
   never redefines its own check.
3. The expected consumers actually do import it (catches someone adding a
   new bypass without wiring it through the shared gate).
4. The test identity cookie's name never appears in a `.tsx` (Client
   Component) file.
5. The Storage serving route checks `TEST_MODE` textually before it ever
   reads the in-memory store.
6. Nothing under `src/` imports from `test/`.
7. `test-storage.ts` is imported only by its two expected consumers.

See [Static security checks](#static-security-checks) for the rest of what
this script checks (most of it predates TEST_MODE and isn't E2E-specific).

### Architecture

```
npm run test:e2e
  └─ playwright.config.ts
       ├─ globalSetup  (test/e2e/global-setup.ts)
       │    ├─ starts a PGlite instance (test/support/local-postgres.ts) —
       │    │  a SEPARATE instance from the integration suite's; each run
       │    │  of each suite gets its own, never shared
       │    └─ spawns test/e2e/db-server.ts as an `npx tsx` subprocess
       ├─ webServer: `next start -p 3100`, env: TEST_MODE=1, PGLITE_TEST_DB=1
       │    (a real production build — see "Why next start, not next dev")
       ├─ *.spec.ts files — talk to the app only over real HTTP (via a
       │    real browser), and to the database only via test/e2e/db-server.ts
       │    over plain fetch() (never import @/lib/prisma directly — see below)
       └─ globalTeardown (test/e2e/global-teardown.ts)
            stops db-server.ts and the PGlite instance
```

**Why a separate `db-server.ts` subprocess, instead of importing Prisma
directly in `*.spec.ts` files?** Playwright Test's own esbuild-based
TypeScript transform can't load `src/generated/prisma/client.ts` (an
`import.meta`-using ESM module) the way Vitest's Vite-based pipeline does
— any file Playwright loads that imports `@/lib/prisma` (or anything
transitively importing it, like the fixture builder) fails with
`SyntaxError: Cannot use 'import.meta' outside a module`. `db-server.ts`
runs exclusively via `npx tsx` (never loaded by Playwright's transform),
exposing a tiny local HTTP API (`POST /seed`, `POST /cleanup`, and a
generic `POST /query` escape hatch for ad-hoc assertions) that
`test/support/e2e-db-client.ts` calls over plain `fetch()`.

**Why `next start`, not `next dev`?** Matches how the app actually runs in
production — dev-server HMR, the dev error overlay, and dev-only warnings
have no place in an E2E assertion. The tradeoff: you must run `npm run
build` yourself before `npm run test:e2e` (it does not build for you).

**Why PGlite instead of a real local Postgres/Supabase?** No Docker and no
writable Homebrew were available when this suite was built — see the
Stage 4 report in the repo's history for the full story. PGlite compiles
real Postgres to WASM; `@electric-sql/pglite-socket` fronts it with a real
TCP wire-protocol server, so `prisma migrate deploy` and the app's own
`@prisma/adapter-pg` connect to it exactly as they would to any real
Postgres. It is a real engine, not a reimplementation — but see
[Limitations](#limitations) for what it still can't stand in for.

**Why does `src/lib/prisma.ts` cache its client on `globalThis`
unconditionally, not just outside production?** Next.js compiles Server
Actions and Route Handlers into separate bundle graphs even within one
`next start` process. Without a process-wide cache, each graph that first
imports `@/lib/prisma` gets its own fresh `PrismaClient` (and its own
connection) — harmless against a real multi-connection Postgres, but
PGlite's socket server serializes all query execution through one
handler-affinity-aware queue, so a second connection opening its own
transaction while another is mid-flight could stall that queue outright.
This was found as a real, intermittent E2E hang, not a report from real
usage — but the fix (always cache) is the standard Prisma+Next.js
pattern regardless, not a test-only workaround.

## Running locally

```bash
npm run test:unit          # fast, no setup needed
npm run test:integration   # starts its own PGlite instance, no setup needed
npm run build               # required once before test:e2e
npm run test:e2e            # starts its own separate PGlite instance + db-server
npm run security:check      # static checks, no setup needed
npm test                    # test:unit + test:integration (not e2e — see below)
```

`npm test` deliberately does not include `test:e2e` — the E2E suite needs
a fresh build first and installed Playwright browsers
(`npx playwright install --with-deps chromium`, one-time), which isn't a
reasonable default for a quick local test loop. Run it explicitly when
you're touching anything `test/e2e/` covers.

## Running in CI

- **`ci-fast.yml`** — `prisma validate`, `tsc --noEmit`, lint, build,
  `security:check`, `test:unit:coverage`. Runs on every PR and every push
  to `main`. No database of any kind.
- **`ci-integration.yml`** — `test:integration`, then build + install
  Chromium + `test:e2e`. Runs on every PR and every push to `main`. The two
  workflows run independently in parallel (not gated on each other) — see
  the comment above the `integration` job in `ci-integration.yml` for the
  tradeoff and when to revisit it.

Neither workflow needs a real database, Supabase project, or any secret —
everything above is self-contained (PGlite, TEST_MODE).

## Limitations

What this test suite **cannot** verify locally, and why (all documented at
their point of use, collected here for visibility):

- **Real Supabase PostgREST enforcement** — that an `anon`/`authenticated`
  JWT is actually rejected by a live Data API. PGlite is a bare
  Postgres-compatible engine; no PostgREST runs here.
- **Real Supabase Auth** — token issuance, session cookie behavior against
  a real Auth service, `signInWithPassword`/`signUp` end to end. TEST_MODE
  sidesteps this rather than faking it (see above); the integration
  suite's `auth-mock.ts` does the same for Vitest.
- **Real Supabase Storage** — same reasoning; TEST_MODE's in-memory store
  stands in for it in E2E, and integration tests mock
  `attachments-storage.ts` directly (`test/support/storage-mock.ts`).

Both are explicitly left as documented gaps (see
`test/integration/security/grants.test.ts`'s header comment) rather than
faked with an assertion that would pass regardless of real behavior — per
this project's own rule: leave a documented gap, never write a test that
can't fail.

## Why some things are deliberately not E2E

E2E tests are the slowest and least precise layer to debug when they fail
— a failure tells you "the browser didn't see X," not "line N is wrong."
Anything a lower layer can verify with equal or better precision stays
there. Concretely, **not** duplicated in `test/e2e/`:

- **Every enum transition, every role, every cross-org combination** —
  combinatorially large, and each individual combination is already
  covered by `test/integration/authorization/*.test.ts` against the real
  database.
- **Concurrent accept** (`test/integration/invitations/concurrent-accept.test.ts`) —
  a race condition is not something a single-worker Playwright run can
  reliably reproduce; Vitest can fire real concurrent Prisma calls directly.
- **Grants / default ACLs** (`test/integration/security/grants.test.ts`) —
  a SQL-level property (`information_schema` queries), not something a
  browser can observe at all.
- **Rate-limit store internals** — a pure data-structure property, covered
  by `test/unit/rate-limit-store.test.ts`; every rate-limited action is
  simply mocked to "never limited" in integration tests
  (`test/integration/setup-mocks.ts`) so it doesn't become a second,
  slower way to test the same logic.
- **Pure formatters** (currency, dates, activity metadata) — `test/unit/`.
  Zero reason to render a page to check a `toLocaleString()` call.
- **Attachment validation edge cases** (every rejected MIME type, size
  boundary, extension mismatch) — `test/unit/attachment-files.test.ts`;
  `attachments.spec.ts` only proves the *happy path* through the real UI.
- **Malformed Activity metadata handling** — `test/unit/format-activity.test.ts`'s
  `FALLBACK` path; `activity.spec.ts` only proves a real action produces a
  real, well-formed entry.
- **Security headers** (CSP, `X-Frame-Options`, etc.) — checked via direct
  HTTP requests (`test/integration/` or a plain `fetch`/`curl`), never via
  Playwright. A browser automation layer can obscure the distinction
  between "header present" and "header present and actually enforced";
  a raw HTTP response is unambiguous.

## Static security checks

`npm run security:check` (`scripts/security-checks/run-all.mjs`) runs
every `check-*.mjs` file in `scripts/security-checks/` and reports
pass/fail per assertion — not a test framework, just small standalone
Node scripts asserting one specific, falsifiable invariant each:

| Check | What it asserts |
|---|---|
| `check-cookie-options-usage.mjs` | Every `createServerClient(` call site passes `cookieOptions:` |
| `check-no-dangerous-html.mjs` | No `dangerouslySetInnerHTML` anywhere in `src/` |
| `check-no-data-api-access.mjs` | No `supabase.from(...)` (Data API) usage — this app is Prisma-only |
| `check-no-public-secrets.mjs` | No `NEXT_PUBLIC_*SERVICE`/`*SECRET`-shaped env var referenced anywhere |
| `check-no-raw-queries.mjs` | No `$queryRawUnsafe`/`$executeRawUnsafe` in application code |
| `check-no-test-mode.mjs` | The full TEST_MODE isolation guarantee — see above |

Add a new one only when an invariant is genuinely falsifiable by grep/AST
and worth checking on every PR — these are cheap to run but each one is
also a maintenance liability if it drifts from what the code actually
does (see `lib.mjs`'s `grep()` for a real bug this drifted into once: a
naive shell-string-interpolated `grep` call silently matched nothing for
any pattern containing a literal `"`).
