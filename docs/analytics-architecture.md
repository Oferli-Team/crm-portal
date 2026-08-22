# Analytics — Architecture

## 1. Purpose

A provider-neutral analytics subsystem answering questions like "how many
clients exist," "what changed this week," and "is this organization
growing" — derived exclusively from data this application already owns.
No external event pipeline, no third-party analytics SDK (no Google
Analytics, Segment, Mixpanel, PostHog, or similar), no tracking pixels, no
browser fingerprinting, and no cookies beyond the existing
authentication/session cookie. Every number on this page is a Postgres
aggregate query away from a table this app already writes to for other
reasons.

## 2. Stage scope

- **Stage 1 (Foundation)** — typed metric calculations, queries, and one
  service entry point; a plain, numbers-only page; OWNER/ADMIN
  authorization; unit + integration tests.
- **Stage 2 (Metrics UI)** — KPI cards, growth indicators, a URL-driven
  range selector (`?range=`, never a cookie), loading/empty/access-denied
  states, responsive layout, E2E + accessibility tests.
- **Stage 3 (Charts)** — line/bar/stacked charts, sparklines, trend
  indicators, period-comparison charts — see §10/§11 below.
- **Stage 4 (Portal analytics)** — aggregate Client Portal metrics
  (portal users, adoption rate, document/invoice visibility, invitation
  acceptance) — see §12/§13. Two of the metrics the Stage 4 task spec
  requested (recent logins, document download count) were **not**
  implemented at the time — §12.2 explains exactly why, in detail, per
  that spec's own "stop and document" instruction. Both are now
  implemented, honestly and with a deliberately narrower semantic than
  originally requested, by the later Portal Analytics persistence
  Slice 1/Slice 2 work — see §12.2a/§12.2b.

Still explicitly **not** implemented (deferred — see §14): CSV/PDF
export, scheduled/emailed reports, AI-generated summaries, configurable
MEMBER access.

## 3. Directory layout

```
src/lib/analytics/
  types.ts                    All types (TimeRange, BucketUnit, metric groups, chart series, AnalyticsSnapshot)
  constants.ts                Time-range labels/defaults, parseTimeRangeParam, MAX_CHART_WEEKS
  authorization.ts            canViewAnalytics / assertCanViewAnalytics
  calculations/
    date-ranges.ts            Pure: TimeRange -> UTC bounds; calendar boundaries; bucket unit/interval
    rates.ts                  Pure: completion rate, growth rate
    format-bucket-label.ts    Pure: chart x-axis label formatting
  queries/
    organization-metrics.ts   Live totals (clients/projects/tasks/invoices/members/attachments)
    activity-metrics.ts       Activity counts (today/this week/this month)
    completion-metrics.ts     Invoice paid/cancelled counts
    growth-metrics.ts         Current-vs-previous-period counts (client/project/task)
    billing-metrics.ts        Thin wrapper over billing's entitlements + subscription event count
    onboarding-metrics.ts     Thin wrapper over onboarding's progress
    time-series.ts            Bucketed chart series (raw, parameterized SQL — see §10)
    portal-metrics.ts         Stage 4: portal user/adoption/document/invoice/invitation counts
    portal-time-series.ts     Stage 4: portal user growth + invitation sent/accepted series
  services/
    analytics-service.ts      getOrganizationAnalytics() — the one public entry point

src/components/analytics/
  analytics-header.tsx, analytics-range-selector.tsx, analytics-grid.tsx,
  analytics-card.tsx, analytics-empty-state.tsx, analytics-access-denied.tsx,
  analytics-skeleton.tsx, growth-indicator.tsx
  charts/
    growth-line-chart.tsx, activity-stacked-bar-chart.tsx, sparkline.tsx,
    comparison-bar-chart.tsx, charts-section.tsx, organization-activity-section.tsx,
    chart-empty-state.tsx, portal-analytics-section.tsx (Stage 4)

src/app/(dashboard)/analytics/
  page.tsx, loading.tsx, error.tsx
```

`queries/` never contains business rules — every query is a bounded,
org-scoped Prisma `count`/`aggregate`/`$queryRaw` and nothing else.
`calculations/` never touches Prisma — every function there is pure,
takes its inputs as plain values (including `now`, never reading the
system clock itself), and is unit-testable with no database. This mirrors
the split this codebase already uses in `src/lib/billing/` (`usage.ts` /
`access-mode.ts` / `entitlements.ts`).

## 4. Time ranges

```ts
type TimeRange = "today" | "last7Days" | "last30Days" | "last90Days" | "allTime";
```

A fixed, closed set — not an arbitrary date picker — so every downstream
query has a small, enumerable set of shapes. All bounds are computed in
UTC. Selected via `?range=` on the URL (`parseTimeRangeParam` never
trusts the raw value, falling back to `DEFAULT_TIME_RANGE` for anything
unrecognized) — never a cookie, so the selection survives a refresh for
free and needs no client-side state.

Two distinct kinds of "time" exist in this subsystem, deliberately not
unified into one:

- **Rolling windows** (`getTimeRangeBounds`) — `now - N days` to `now`.
  Used by growth metrics (§5.4) and, via `getSeriesBounds`, by chart
  series (§10). `allTime` has `start: null` for KPI metrics (no lower
  bound) but is capped for charts specifically — see §10.
- **Calendar-aligned boundaries** (`getCalendarBoundaries`) — UTC
  midnight of today, Monday 00:00 UTC of this ISO week, the 1st of this
  UTC month. Used by Activity metrics (§5.2) only.

## 5. Metrics

### 5.1 Organization metrics

Live, unfiltered-by-time totals — "how many clients exist," not "how many
were created in the selected range." `totalTasks`/`completedTasks`
(`status = DONE`)/`openTasks` (`status IN (TODO, IN_PROGRESS, IN_REVIEW)`)
are three independent indexed counts, not a `groupBy` + in-memory
reduction (see `organization-metrics.ts`'s own comment for why).

### 5.2 Activity metrics

`createdToday` / `createdThisWeek` / `createdThisMonth` — three
independent counts against `Activity.createdAt`, using the
calendar-aligned boundaries from §4.

### 5.3 Completion metrics

`taskCompletionRate = round(completedTasks / totalTasks * 100)`, `0` when
`totalTasks` is `0` (never `NaN`).

`invoiceCompletionRate = round(paidInvoices / (totalInvoices -
cancelledInvoices) * 100)` — cancelled invoices are excluded from the
denominator: a cancelled invoice was never meant to be paid, and including
it would make the rate look artificially low for an organization that
cancels stale drafts as routine housekeeping.

### 5.4 Growth metrics

For each of Client/Project/Task: `currentPeriodCount`, `previousPeriodCount`,
and `changePercent = round((current - previous) / previous * 100)` —
**`null`**, never `Infinity`/`NaN`, when `previousPeriodCount` is `0`. The
same `GrowthMetric` values feed both the Growth KPI cards (Stage 2) and
the Stage 3 comparison bar charts (§11) — one query, two presentations,
never a second fetch.

### 5.5 Billing metrics

`planKey` / `subscriptionStatus` — a **read-only pass-through** of
`src/lib/billing/entitlements.ts`'s own `getOrganizationEntitlements()`.
`subscriptionEventCount` (Stage 3) — a single `count` of
`WebhookEvent` rows with `processingStatus: "PROCESSED"` for this
organization; never the events themselves, never `eventType`/
`providerEventId`/any other column, and never a per-event timeline (the
task's own "subscription status transitions — aggregate only"
instruction). This is the only query file that reaches into another
domain's module (Billing) — every other query touches Prisma directly.

### 5.6 Onboarding metrics

`percent` / `completedCount` / `totalCount` — a read-only pass-through of
`src/lib/onboarding/progress.ts`'s own `getOrganizationOnboardingProgress()`.

## 6. Multi-tenancy

Every query function takes `organizationId` as an explicit, required
parameter and filters every read by it — there is no "all organizations"
code path anywhere in this subsystem. `organizationId` is never accepted
from the client (page/action layer always resolves it server-side via
`getCurrentMembership()`). Legacy rows with a `null` `organizationId`
(pre-multi-tenant `Task`/`Invoice` rows) are simply excluded from every
org-scoped count, by construction.

## 7. Security

Analytics data is available only to **OWNER** and **ADMIN**
(`src/lib/analytics/authorization.ts`). `assertCanViewAnalytics()` is the
one entry point `getOrganizationAnalytics()` calls first, before any
query runs — a MEMBER role never triggers a single database read. The
page catches the resulting `AnalyticsAccessError` server-side (via
`instanceof`, safe — same process, never crosses a serialization
boundary) and renders a dedicated "Access denied" state **inline**,
deliberately NOT delegated to `error.tsx`: Next.js redacts Server
Component error messages in production before they reach a client-side
error boundary, which would make "access denied" indistinguishable from
any other failure once deployed. `error.tsx` is reserved for genuine
unexpected failures. MEMBER access is intentionally not configurable yet.
Client Portal identities never reach this code at all — this route lives
under `(dashboard)`, whose layout already redirects any Portal-only
identity to `/portal` first.

## 8. Performance

- Every KPI query is a bounded, indexed `count`/`aggregate` — never a
  `findMany` of full rows, never an unbounded scan.
- Every chart series is exactly **one** aggregate query (§10) — never N
  queries per bucket.
- Every metric group's internal reads run concurrently (`Promise.all`),
  and every top-level group in `getOrganizationAnalytics()` — KPIs and
  chart series alike — also runs concurrently in the same call. One page
  load costs one service call and a fixed, small number of parallel
  round-trips, never a chain of sequential ones and never a second
  service call for chart data.
- No N+1: nothing loops over a result set to issue a second query per row.
- No client-side aggregation: every rate/count/bucket is computed in the
  database or in a pure function server-side; chart components only ever
  format and draw numbers they're given.

## 9. Accessibility

- Every section is a real `<h2>` inside a `<section aria-labelledby>`
  landmark; the range selector is a `<nav aria-label="Time range">` of
  real `<a>` elements (keyboard-focusable, screen-reader-navigable, and
  functional with JS disabled — no client-side router state).
- Every chart (`role="img"` + a descriptive `aria-label`, e.g. "Clients
  over time, 6 total") carries the same information a sighted user gets
  from the drawn shape — direction/magnitude is never color-only
  (`growth-indicator.tsx`'s glyph + `aria-label` says "up 12%", not just
  green text). Recharts' `accessibilityLayer` prop is enabled on every
  interactive chart, giving Tab-to-focus and arrow-key point navigation
  with per-point screen-reader announcements for free.
- Sparklines (`sparkline.tsx`) are deliberately `aria-hidden="true"` —
  decorative only; the same series is already reachable, accessibly, via
  the real chart below the fold and the KPI card's own numeric value.
- Never relies on hover alone: every chart's data is in its `aria-label`
  and in the adjacent KPI card's plain-text value, not only in a
  mouse-triggered tooltip.

## 10. Chart data: bucketing and adaptive axes

Charts need a *series* (one count per time bucket), not a single total —
a new query shape (`queries/time-series.ts`) alongside Stage 1's
single-number aggregates.

**Adaptive bucket size** (`getBucketUnit`) — chosen from the selected
`TimeRange`, never fixed, so `today` isn't 24 empty-looking daily points
and `last90Days` isn't ~2,160 unreadable hourly ones:

| TimeRange | Bucket unit | Approx. points |
|---|---|---|
| `today` | hour | 24 |
| `last7Days` | day | 7 |
| `last30Days` | day | 30 |
| `last90Days` | week | ~13 |
| `allTime` | week | up to `MAX_CHART_WEEKS` (52) |

**`allTime` is capped for charts** (`getSeriesBounds`): a multi-year-old
organization would otherwise produce hundreds of weekly buckets, and the
single aggregate query behind it would scan that entire history every
request. Chart series for `allTime` show the last year; the `allTime`
**totals** shown elsewhere on the page (Overview, Growth) are still
computed over the organization's real, complete history — the cap only
bounds the chart's own x-axis window.

**One query per series, zero gaps.** Each function in `time-series.ts`
runs `generate_series(start, end, interval)` to produce every bucket in
the window up front, `LEFT JOIN`s the real rows, and groups with
`date_trunc()` — so a day/hour/week with zero activity is a real `0`
point a line chart draws correctly, never a gap it would silently skip.
Every interpolated value (organizationId, bounds, unit strings) is a
bound parameter via Prisma's tagged-template `$queryRaw` — never
`$queryRawUnsafe`/string concatenation; only the table/column names are
literal SQL text this file itself writes, never a runtime value. Task and
Invoice activity need two independent counts per bucket ("created" and
"completed"/"paid," bucketed on different columns, `Task.createdAt` vs.
`Task.completedAt`) — both computed in the same query via two `LEFT
JOIN`s against the same `generate_series` backbone, never two round-trips.

## 11. Charts

### Library selection: Recharts

**Chosen: [Recharts](https://recharts.org) (v3).** Evaluated against
lower-level alternatives (Visx) and canvas-based ones (Chart.js):

- **Established, Next.js/TS-compatible.** The most widely used React
  charting library for exactly this use case (dashboards fed by
  server-computed data); first-class TypeScript types; no special
  Next.js integration needed beyond marking chart components
  `"use client"` (see below) — the server still computes and passes
  already-aggregated data as plain props.
- **Accessibility out of the box.** The `accessibilityLayer` prop
  (enabled on every interactive chart in this codebase) gives real
  keyboard navigation and screen-reader point announcements without
  hand-building a parallel accessible data table — the reason it was
  chosen over a lower-level primitive library (Visx) that would need
  this built from scratch.
- **SVG, not canvas.** Every chart is real DOM (`role="img"` +
  `aria-label` on the container, real `<svg>`/`<path>` elements inside)
  — inspectable, stylable with the app's existing Tailwind tokens, and
  responsive via its own `ResponsiveContainer` (percentage-based, so a
  chart reflows with its parent instead of needing manual breakpoint
  logic).
- **Bundle size caveat, and the mitigation.** Recharts is not the
  smallest possible option (it bundles a D3 subset internally) — a
  lower-level library like Visx would ship less code for a team willing
  to write more of the chart logic by hand. Given this app's actual need
  (a handful of line/bar/sparkline charts, not a general-purpose
  visualization surface), the productivity and accessibility win was
  judged worth it. The mitigation: every chart component is a Client
  Component (`"use client"`), so Recharts' JS is code-split into the
  `/analytics` route's own client bundle by Next.js's router-level
  splitting — it never inflates any other page's bundle, and the
  `/analytics` Server Component itself (data fetching, authorization)
  ships zero extra client JS of its own.

### Chart types

- **Line charts** (`growth-line-chart.tsx`) — Client growth, Project
  growth, and Activity events, each a single-series line over the
  adaptive bucket window (§10).
- **Stacked bar charts** (`activity-stacked-bar-chart.tsx`) — Task and
  Invoice activity: each bucket's bar is `created` for that bucket,
  stacked into "completed" (darker) and "still open" (`created -
  completed`, clamped at `0`, lighter) segments.
- **Sparklines** (`sparkline.tsx`) — minimal, decorative, `aria-hidden`
  area charts embedded in the Clients/Projects/Tasks/Invoices Overview
  cards, reusing the exact same series data as the full charts below
  (no second fetch — see §8).
- **Comparison bar charts** (`comparison-bar-chart.tsx`) — current vs.
  previous period, one horizontal two-bar chart per dimension
  (Clients/Projects/Tasks), reusing Stage 1's `GrowthMetric` (§5.4)
  directly rather than a new query.
- **Trend indicators** (`growth-indicator.tsx`, Stage 2, reused
  unchanged) — the `+12%`/`−8%`/`±0%`/"No prior data" glyph shown next
  to Growth KPI cards and comparison charts alike.

### Empty states

- **Whole-organization empty** (Stage 2's `analytics-empty-state.tsx`,
  unchanged) — a brand-new org with zero clients/projects/tasks/invoices/
  attachments shows one banner in place of the Overview grid; every
  chart section still renders below it with its own zero-filled series
  (never a crash, never a second empty-state banner per chart).
- **Single-chart empty** (`chart-empty-state.tsx`, new in Stage 3) — an
  individual series with zero activity across every bucket in the window
  (e.g. Projects, when only Clients have recent activity) shows "Not
  enough data yet for projects" in place of a flat, uninformative
  zero-line chart.
- **Legacy organizations** — no Subscription row at all: `planKey`/
  `subscriptionStatus` resolve to `"LEGACY"` (§5.5, Billing's own Stage 5
  normalization) and every chart renders exactly as it would for any
  other organization — charts are independent of billing state by
  construction (`queries/time-series.ts` never reads `Subscription`).
- **No onboarding data** — zero `OrganizationOnboardingStep` rows (never
  onboarded, or pre-Onboarding-stage): `getOrganizationOnboardingProgress()`
  has no error path for this; the reused `OnboardingProgressBar` renders
  a real, correct percentage (never a crash or a "N/A").

## 12. Portal analytics (Stage 4) — what's implemented, and what deliberately isn't

The Stage 4 task spec allowed exactly seven data sources — PortalUser,
Client, Project, Attachment, Activity, Notification, Invoice — and
required: *"Do not create new tracking tables unless absolutely
necessary. If additional persistence becomes unavoidable: stop; document
the reason; return CHANGES REQUIRED."* This section is that
documentation.

### 12.1 What the schema contained at the time Stage 4 shipped (historical — see §12.2a for what has since changed)

- `PortalUser` had `id`, `clientId`, `email`, `name`, `createdAt`,
  `updatedAt` — **no login/session timestamp of any kind**. (This is no
  longer true — `lastLoginAt` was added by Slice 1, §12.2a.)
- `Attachment`'s only timestamp is `createdAt` (upload time) — no
  access/open/download event is ever recorded. This part is still
  accurate: Slice 1 added a download-*request* event
  (`PortalDownloadRequest`), never an `Attachment`-level column or event.
- The Portal attachment download route
  (`src/app/api/portal/attachments/[id]/download/route.ts`) issues a
  short-lived signed URL and redirects — its own header comment states
  the deliberate design: *"never log the signed URL, storagePath, or
  bucket."* This is a pre-existing, intentional privacy decision made
  before Stage 4 existed, not an oversight Stage 4 could work around.
- `Activity.actorId` is a relation to `User` (staff) — never `PortalUser`.
  A `PORTAL_INVITATION_ACCEPTED` Activity row genuinely exists
  (`actorId: null`, written inside the same transaction as the
  `PortalUser` upsert — `src/app/portal/invite/[token]/actions.ts`), but
  no Activity row, of any kind, is ever authored *by* a portal identity
  logging in or opening a page.
- `Notification.recipientId` is also a relation to `User` — portal
  identities never receive (or trigger) a Notification row either.

### 12.2 What this means for the two requested metrics

- **"Recent logins."** There is no login/session timestamp anywhere in
  the allowed data sources (or anywhere in the schema at all). Portal
  authentication is real Supabase Auth (`supabase.auth.getUser()` in
  `src/lib/current-portal-user.ts`) — Supabase's own `auth.users.
  last_sign_in_at` does technically exist, but it lives in a different
  system/schema this app deliberately never queries for business data,
  and it is not one of the seven allowed sources. Implementing this
  honestly would require a new `PortalUser.lastLoginAt` (or equivalent)
  column, written on every portal sign-in — new persistence, and new
  write-path logic in the portal auth flow, neither of which this stage
  added.
- **"Document download count."** No download/access event is recorded
  anywhere, and the one code path that could record one
  (`/api/portal/attachments/[id]/download`) explicitly documents choosing
  not to, as a privacy decision predating this stage. Implementing this
  honestly would require a new counter column or a new download-event
  log table, plus a write on every download — again, new persistence
  this stage did not add.

**At the time Stage 4 shipped, neither was implemented, faked, or
approximated with a misleading proxy.** No `lastLoginAt` column, no
download-count column, no download-log table existed anywhere in
`prisma/schema.prisma` — `check-analytics-security.mjs` asserted this
directly (check #13) so a future change couldn't silently reintroduce it
without the check catching it. **This is no longer the current state —
see §12.2a below for what a later stage, Portal Analytics persistence
Slice 1, deliberately and reviewedly added.**

### 12.2a Portal Analytics persistence foundation (Slice 1) — the gap above is now closed at the persistence layer

A later stage revisited this exact "stop and document" gap, did the
review it called for, and added the minimum honest persistence needed —
deliberately, not silently, and still gated by `check-analytics-security.mjs`
(check #13 now allowlists exactly these two additions instead of banning
all tracking persistence outright — see that check's own header comment).
**This section documents the persistence and write paths Slice 1 added.
Slice 2 (§12.2b) is the read path that consumes this exact persistence —
the analytics query, `PortalMetrics` fields, and UI cards described here
as future work at the time Slice 1 shipped now exist, exactly as
originally scoped.**

- **`PortalUser.lastLoginAt` (nullable `DateTime`).** Written by
  `src/lib/client-portal/analytics-events.ts`'s `recordPortalLogin()`,
  called from two places: a successful, credential-backed
  `/portal/login` sign-in (`src/app/portal/login/actions.ts`), and a
  genuine first `PENDING -> ACCEPTED` invitation acceptance
  (`src/app/portal/invite/[token]/actions.ts` — set inside the same
  `portalUser.upsert()` call that already gates on that exact
  transition, never a second write). **This is current/recent-user
  state only, never a login history or event log** — the column is
  overwritten on every write, so it can only ever answer "is this
  identity's most recent sign-in within some range right now," never
  "how many times did they sign in" or "what did their login history
  look like last month." It is never written by session-cookie
  resolution (`getCurrentPortalUser()`/`getOptionalPortalUser()` remain
  pure reads), a password-reset session, or a bare `portalSignup()` with
  no invitation accepted yet.
- **`PortalDownloadRequest` (new model).** One immutable row per
  successfully issued portal attachment signed download link
  (`src/app/api/portal/attachments/[id]/download/route.ts`, via
  `recordPortalDownloadRequest()`), written only after session/PortalUser
  verification, the rate limit, the `Attachment` lookup, access
  verification, and a successfully generated signed URL have all already
  succeeded. **Organization-only** — no `portalUserId`, no
  `attachmentId`, no `clientId`, no email/name, no signed URL, no
  storage path/bucket, no IP, no User-Agent, no session/auth data, no
  payload/metadata of any kind. It is structurally incapable of
  answering "who downloaded what." **One row means exactly "an
  authorized request successfully received a signed download link" — it
  does not, and cannot, prove the browser followed the redirect or that
  the file transfer completed.** Every legitimate repeat click creates
  its own separate row, by design (no unique constraint, no
  deduplication).
- **Both UI metrics (Slice 2, §12.2b) are plain, current-selected-range
  scalar counts** — `recentlyActivePortalUsers: number` and
  `documentDownloadRequests: number` — **never a `GrowthMetric`, never a
  previous-period comparison, and no chart.** `lastLoginAt` cannot
  honestly support a previous-period comparison at all (a later login
  destroys the only evidence of an earlier one within an older window),
  so it is only ever read against the literal currently-selected
  `TimeRange`, including a true `allTime`. `PortalDownloadRequest` rows
  are immutable and timestamped precisely enough to respect this app's
  actual rolling `TimeRange` windows (`today`/`last7Days`/`last30Days`/
  `last90Days`/`allTime` — see `calculations/date-ranges.ts`'s own
  "rolling, not calendar-aligned" doc comment) without the
  boundary-misalignment a calendar-day aggregate would introduce, but no
  growth comparison or trend chart was added for it either.
- **Slice 1 collected data before anything rendered it** — Slice 1
  shipped with no card, no chart, no `PortalMetrics` field referencing
  either value, specifically so the interface would never promise a
  number before the app had actually started tracking it. Slice 2
  (§12.2b) added the read path and UI only once real data already
  existed to display.
- **Historical data from before this deployment cannot be, and was not,
  backfilled.** Every `PortalUser` row that predates this migration has
  `lastLoginAt = NULL` (correctly meaning "no tracked sign-in yet," not
  a false "never signed in ever" claim); no `PortalDownloadRequest` rows
  exist for any download that happened before this stage shipped. Both
  metrics will honestly read as lower than real historical usage for any
  period that spans before this deployment — this is expected and
  disclosed, not a bug.

### 12.2b Portal Analytics read path (Slice 2) — the two new metrics are now live

The read side of the persistence §12.2a added. One new query function,
`getPortalEngagementCounts(client, organizationId, bounds)`
(`src/lib/analytics/queries/portal-metrics.ts`), two new `PortalMetrics`
fields, two new plain `AnalyticsGrid` cards, and one empty-state
predicate correction — nothing else changed about how Portal analytics
works.

- **Query shape.** Two independent `count` queries, run concurrently via
  `Promise.all` — never `findMany`, never raw SQL, never a per-row loop.
  `recentlyActivePortalUsers` counts `PortalUser` rows scoped through
  `client: { organizationId }` (the same Client-based scoping every
  other portal query in this file already uses — `PortalUser` has no
  `organizationId` column of its own, see §13). `documentDownloadRequests`
  counts `PortalDownloadRequest` rows scoped directly by its own
  `organizationId` column (no join needed — see §13). Neither reads a
  `PortalUser`'s email/name, an id, a `clientId`, or any raw timestamp;
  both return bare integers.
- **`[start, end)` filtering.** Both counts filter their respective
  timestamp column (`lastLoginAt`/`requestedAt`) with this domain's
  half-open convention: `gte` on the inclusive `start` (omitted entirely
  when `start` is `null`), `lt` on the exclusive `end` — matching
  `queries/growth-metrics.ts`'s own already-correct convention, not
  `getPortalActivityCounts`'s pre-existing `lte` (a separate, unrelated,
  out-of-scope behavior this function does not touch or repeat).
- **Literal `TimeRange`, including a true `allTime`.** The service layer
  (`analytics-service.ts`) computes a dedicated `selectedBounds =
  getTimeRangeBounds(timeRange, now)` — the literal, unsubstituted
  selected range — specifically for these two fields, kept deliberately
  separate from `growthBounds` (which silently substitutes
  `DEFAULT_GROWTH_TIME_RANGE`/`last30Days` for every `GrowthMetric` card
  whenever the UI selects `allTime`). Selecting "All time" for these two
  cards means exactly that: `bounds.start === null`, every row ever
  written counted, never a hidden 30-day cap.
- **UI.** Two plain `AnalyticsGrid` cards in the existing "Portal
  overview" grid (`portal-analytics-section.tsx`), with the exact visible
  labels **"Recently active portal users"** and **"Download-link
  requests"** — a label and a bare number, no `indicator`, no
  `sparkline`, no `GrowthIndicator`, no `ComparisonBarChart`, no trend
  chart, no tooltip. `documentDownloadRequests` is never labeled
  "Document downloads" — the value can only ever prove a signed link was
  successfully issued, never that the file transfer completed (§12.2a).
- **Empty-state correction.** `PortalDownloadRequest` belongs directly to
  `Organization`, not to `Client`/`PortalUser` — deleting a Client
  cascades away its `PortalUser` rows but never touches an
  organization-scoped `PortalDownloadRequest` row. The Portal section's
  own emptiness check now requires **all five** of `totalPortalUsers`,
  `documentsAvailable`, `invoicesVisible`, `recentlyActivePortalUsers`,
  and `documentDownloadRequests` to be zero before rendering the empty
  state — an organization with zero current Clients/PortalUsers but real
  historical download-link request data still renders its real Portal
  overview grid, not "No activity yet."

### 12.3 What was implemented instead, and why each is honest

| Requested | Implemented as | Real source |
|---|---|---|
| Active portal users | **"Portal users"** — current total of `PortalUser` rows, unfiltered by the selected `TimeRange` and not a retained historical/lifetime count (deleted rows cascade away with their Client); not a recency-filtered "active" count (see "Recently active portal users" below for that) | `PortalUser` rows for the org |
| Invitation acceptance count | Real, time-boundable count | `Activity` rows, `action = PORTAL_INVITATION_ACCEPTED` |
| Recent logins | **"Recently active portal users"** — distinct `PortalUser` identities whose most recent explicit sign-in falls within the literal selected `TimeRange` (§12.2b); a current-state scalar, not a login-event count | `PortalUser.lastLoginAt` |
| Document access count | Folded into **"Documents available"** — content *reachable* by a portal identity, never an access event | `Attachment` rows (Client + Project level) scoped to Clients with a `PortalUser` |
| Document download count | **"Download-link requests"** — authorized requests that successfully received a signed download link within the selected range; never "Document downloads," since a completed file transfer is never observed (§12.2a/§12.2b) | `PortalDownloadRequest` rows |
| Completed actions | **"Portal activity"** — count of portal-lifecycle Activity rows in the period | `Activity` rows, `entityType = PORTAL_USER` |
| Recent activity count | Same as above (one real signal, not two) | `Activity` rows, `entityType = PORTAL_USER` |
| Activity trend | **Portal trends** line chart | Same Activity rows, bucketed (§10's shape, reused) |
| Activity frequency | Implicit in the trend chart's own bucketing — no separate "frequency" number was invented | — |
| Document engagement | Same as "Documents available" — deliberately labeled as availability, never "engagement," since no open/view/download event exists to measure real engagement | `Attachment` |
| Portal adoption indicators | **"Portal adoption"** — percent of Clients with ≥1 PortalUser | `Client` + `PortalUser` |

`invoicesVisible` (Invoice rows belonging to a Client with portal access)
was added beyond the requested list, using `Invoice` — the seventh
allowed source — for the same "reachable, not accessed" reasoning as
documents.

## 13. Portal analytics: reuse and multi-tenancy

Every chart/card in the Portal section (`portal-analytics-section.tsx`)
is composed from Stage 2/3 components — `AnalyticsGrid`, `Sparkline`,
`GrowthLineChart`, `ActivityStackedBarChart` (extended with optional
`createdWord`/`completedLabel`/`openLabel` props so Stage 4 can relabel
"sent"/"accepted" instead of "created"/"completed" without a new
component), `ComparisonBarChart`, `ChartsSection`. No new chart-rendering
code was written for Stage 4.

`PortalUser` has no `organizationId` column of its own (only `clientId`)
— every `PortalUser`-based query scopes through `Client.organizationId`,
either as a Prisma `where: { client: { organizationId } }` filter
(`portal-metrics.ts`'s `getPortalOverview` and, for
`recentlyActivePortalUsers`, `getPortalEngagementCounts` — §12.2b) or a
`clientId IN (SELECT id FROM "Client" WHERE "organizationId" = ...)`
subquery in the one raw-SQL query (`portal-time-series.ts`) —
functionally identical scoping, verified by `check-analytics-security.mjs`'s
check #12 and by dedicated cross-organization-isolation tests in
`test/integration/analytics/portal-metrics.test.ts` and
`portal-time-series.test.ts`. `PortalDownloadRequest`, by contrast, *does*
carry its own `organizationId` column directly (§12.2a) — its count in
`getPortalEngagementCounts` scopes with a plain `where: { organizationId
}`, no `Client` join needed at all, and is covered by the same
cross-organization-isolation test file.

Portal-only identities are rejected the same way every other Analytics
consumer is: this route lives under `(dashboard)`, whose layout redirects
any Portal-only identity to `/portal` before the page (or any query)
ever runs — never a portal-specific check, because the existing
OWNER/ADMIN gate (§7) already covers it.

## 14. Deferred to a later stage

- CSV/PDF export.
- Scheduled/emailed analytics reports.
- AI-generated summaries.
- Configurable MEMBER-level access (§7).
