import type { PlanKey } from "@/lib/billing/plans";
import type { SubscriptionStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import type { prisma } from "@/lib/prisma";

/** Same shape as src/lib/billing/usage.ts's own `PrismaClientOrTx` — defined independently here (not imported) to keep the analytics domain decoupled from Billing's internals. */
export type PrismaClientOrTx = typeof prisma | Prisma.TransactionClient;

/**
 * Analytics Stage 1 (docs/analytics-architecture.md §4). The five ranges
 * this subsystem's own selector will offer — a fixed, closed set (not an
 * arbitrary date picker) so every downstream query has a small, enumerable
 * set of shapes to be indexed/tested against, rather than an unbounded
 * range space. `allTime` has no lower bound at all (see
 * calculations/date-ranges.ts's own TimeRangeBounds).
 */
export type TimeRange = "today" | "last7Days" | "last30Days" | "last90Days" | "allTime";

export const ALL_TIME_RANGES: readonly TimeRange[] = ["today", "last7Days", "last30Days", "last90Days", "allTime"];

/** A resolved [start, end) window in UTC — `start: null` means "no lower bound" (`allTime` only). */
export type TimeRangeBounds = {
  start: Date | null;
  end: Date;
};

/**
 * Foundation-only counts (docs/analytics-architecture.md §5.1) — every
 * field here is a live, unfiltered-by-time total for the organization
 * today, independent of whatever TimeRange the caller asked for. Mirrors
 * src/lib/billing/usage.ts's own "one bounded read, several parallel
 * counts" shape.
 */
export type OrganizationMetrics = {
  totalClients: number;
  totalProjects: number;
  totalTasks: number;
  completedTasks: number;
  openTasks: number;
  totalInvoices: number;
  totalMembers: number;
  totalAttachments: number;
};

/**
 * Calendar-aligned (not rolling — see calculations/date-ranges.ts's own
 * `getCalendarBoundaries` doc comment) counts of Activity rows, always
 * computed regardless of the caller's selected TimeRange — "how busy has
 * this organization been today / this week / this month" is a fixed
 * question, not one a range selector should change the meaning of.
 */
export type ActivityMetrics = {
  createdToday: number;
  createdThisWeek: number;
  createdThisMonth: number;
};

/**
 * 0–100, integer, `round(completed / total * 100)` — `0` (never NaN/
 * Infinity) when `total` is `0`, since an org with no tasks/invoices yet
 * has trivially completed none of them. See calculations/rates.ts.
 */
export type CompletionMetrics = {
  taskCompletionRate: number;
  invoiceCompletionRate: number;
};

/**
 * One dimension's current-vs-previous-equal-length-period comparison
 * (docs/analytics-architecture.md §5.4). `changePercent` is `null` — never
 * `Infinity`/`NaN` — whenever `previousPeriodCount` is `0`, since "grew
 * from zero" has no finite percentage (see calculations/rates.ts).
 */
export type GrowthMetric = {
  currentPeriodCount: number;
  previousPeriodCount: number;
  changePercent: number | null;
};

export type GrowthMetrics = {
  clientGrowth: GrowthMetric;
  projectGrowth: GrowthMetric;
  taskGrowth: GrowthMetric;
};

/**
 * Deliberately re-reads src/lib/billing/entitlements.ts's own
 * `getOrganizationEntitlements()` rather than re-deriving these two fields
 * from the Subscription row directly — that function is already the one
 * place LEGACY/unrecognized-planKey normalization happens (Billing Stage 5
 * audit fix), and duplicating that logic here would risk the two
 * subsystems silently disagreeing on what an organization's plan "is".
 * Foundation-only: no limits/usage duplicated here (Billing's own
 * `/settings/billing` page is the one place for that).
 */
export type BillingMetrics = {
  planKey: PlanKey;
  subscriptionStatus: SubscriptionStatus | "LEGACY";
  /**
   * Analytics Stage 3 ("subscription status transitions — aggregate
   * only"). The count of successfully-processed WebhookEvent rows for
   * this organization, all-time — never the events themselves, never
   * `eventType`/`providerEventId`/any other column, and never a
   * per-event timeline (see queries/billing-metrics.ts's own
   * `getSubscriptionEventCount`).
   */
  subscriptionEventCount: number;
};

/**
 * Deliberately re-reads src/lib/onboarding/progress.ts's own
 * `getOrganizationOnboardingProgress()` rather than re-deriving a percent
 * from OrganizationOnboardingStep rows directly — that function is the
 * one place "percent" already has a single, tested definition (excludes
 * WELCOME, includes FINISH; see that module's own doc comment).
 */
export type OnboardingMetrics = {
  percent: number;
  completedCount: number;
  totalCount: number;
};

/**
 * Analytics Stage 3 (docs/analytics-architecture.md §10). The bucket size
 * a chart's x-axis uses — chosen from the selected `TimeRange` (see
 * `calculations/date-ranges.ts`'s own `getBucketUnit`), never fixed,
 * so a `today` chart isn't 24 empty-looking daily buckets and a
 * `last90Days` chart isn't ~2,160 unreadable hourly ones ("adaptive
 * axes").
 */
export type BucketUnit = "hour" | "day" | "week";

/** One point on a time-series chart — `bucketStart` is always a real, aligned instant (never a label string); formatting for the x-axis happens client-side, in the chart component, from this real `Date`. */
export type SeriesPoint = { bucketStart: Date; count: number };

/** A two-series bucket (Task/Invoice activity: created vs completed) — same `bucketStart` alignment as `SeriesPoint`. */
export type DualSeriesPoint = { bucketStart: Date; created: number; completed: number };

export type ChartSeries = {
  unit: BucketUnit;
  points: SeriesPoint[];
};

export type DualChartSeries = {
  unit: BucketUnit;
  points: DualSeriesPoint[];
};

/** Stage 3's full chart payload — one call, alongside the Stage 1/2 snapshot, never duplicating any of its queries. */
export type AnalyticsChartData = {
  clientGrowthSeries: ChartSeries;
  projectGrowthSeries: ChartSeries;
  taskActivitySeries: DualChartSeries;
  invoiceActivitySeries: DualChartSeries;
  activityEventsSeries: ChartSeries;
  /** Stage 4 — PortalUser.createdAt bucketed, same shape/adaptive unit as clientGrowthSeries. */
  portalUserGrowthSeries: ChartSeries;
  /**
   * Stage 4 — reuses `DualChartSeries`'s `created`/`completed` field
   * names to mean "sent" / "accepted" respectively, so this can feed the
   * exact same `ActivityStackedBarChart` component Stage 3 already built
   * for Task/Invoice activity (docs/analytics-architecture.md §14) —
   * never a new chart component for what's structurally the identical
   * shape.
   */
  portalInvitationSeries: DualChartSeries;
};

/**
 * Analytics Stage 4 (docs/analytics-architecture.md §13), extended by
 * Portal Analytics persistence Slice 1 (§12.2a) and read path Slice 2
 * (§12.2b). Every field here is derived exclusively from
 * PortalUser/Client/Project/Attachment/Invoice/Activity/PortalDownloadRequest
 * rows this app already writes for other reasons — see
 * queries/portal-metrics.ts's own doc comment for exactly which source
 * backs which field.
 */
export type PortalMetrics = {
  /** Current total of PortalUser rows for the organization, unfiltered by the selected TimeRange — see §13 for why this is labeled "Portal users," not "active portal users." This is a current-state count, not a retained historical/lifetime count: Client deletion cascades to PortalUser, so deleted rows are not counted. Independent of, and not the same as, `recentlyActivePortalUsers` below. */
  totalPortalUsers: number;
  /** 0–100, integer: percent of the organization's Clients that have at least one PortalUser. `0` when the organization has no Clients at all (never NaN). */
  portalAdoptionRate: number;
  /** Attachment rows reachable by at least one of this organization's portal identities (Client-level + Project-level, scoped to Clients that have a PortalUser) — content *availability*, never an access/open/download event. */
  documentsAvailable: number;
  /** Invoice rows belonging to a Client that has a PortalUser — same "reachable, not accessed" caveat as documentsAvailable. */
  invoicesVisible: number;
  /** Count of Activity rows with action = PORTAL_INVITATION_ACCEPTED, within the selected TimeRange. */
  invitationsAccepted: GrowthMetric;
  /** Count of Activity rows scoped to the portal domain (entityType = PORTAL_USER, or a PORTAL_-prefixed action), within the selected TimeRange — "completed actions" / "recent activity count" combined into one real, time-boundable signal. */
  portalRelatedActivity: number;
  /**
   * Portal Analytics read path Slice 2 (docs/analytics-architecture.md
   * §12.2b; persisted by Slice 1, §12.2a; see also §12.3). Count of
   * `PortalUser` rows whose `lastLoginAt` falls
   * within the **literal** selected `TimeRange` (a true, unsubstituted
   * `allTime` included — never the growth-comparison fallback). A plain
   * current-range scalar, deliberately **not** a `GrowthMetric`:
   * `lastLoginAt` is mutable current state, not a login history — a
   * later sign-in overwrites the only evidence of an earlier one, so
   * this can never honestly support a previous-period comparison. This
   * counts distinct portal *identities*, never login *events* (a person
   * who signed in five times in the range still counts once). `NULL`
   * means "no explicit sign-in has been tracked since this persistence
   * was introduced," not "this identity has never signed in, ever."
   * Exposes no PII — never a name, email, id, or `clientId`, only the
   * aggregate count.
   */
  recentlyActivePortalUsers: number;
  /**
   * Portal Analytics read path Slice 2 (docs/analytics-architecture.md
   * §12.2b; persisted by Slice 1, §12.2a). Count of `PortalDownloadRequest`
   * rows for this organization whose `requestedAt` falls within the
   * literal selected `TimeRange`. Means "authorized portal requests that
   * successfully received a signed document download link during the
   * selected range" — **not** completed file transfers (this app cannot
   * observe whether the browser followed the redirect), so this is never
   * labeled "Document downloads." A plain current-range scalar,
   * deliberately not a `GrowthMetric`, with no previous-period
   * comparison, `GrowthIndicator`, or trend chart. Exposes no per-user or
   * per-document detail — `PortalDownloadRequest` itself carries no such
   * reference to begin with.
   */
  documentDownloadRequests: number;
};

/** The full snapshot — one call, one consistent `computedAt` instant, every dimension this and every prior stage defines. */
export type AnalyticsSnapshot = {
  organizationId: string;
  timeRange: TimeRange;
  computedAt: Date;
  organization: OrganizationMetrics;
  activity: ActivityMetrics;
  completion: CompletionMetrics;
  growth: GrowthMetrics;
  billing: BillingMetrics;
  onboarding: OnboardingMetrics;
  portal: PortalMetrics;
  charts: AnalyticsChartData;
};
