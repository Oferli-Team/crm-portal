import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getOrganizationAnalytics } from "@/lib/analytics/services/analytics-service";
import { AnalyticsAccessError } from "@/lib/analytics/authorization";
import { testEmail, testSlug } from "../../support/run-id";

const NOW = new Date("2026-08-12T15:30:00.000Z");
// One minute before NOW, comfortably inside every window this file exercises
// (last7Days/last30Days/allTime) and strictly less than `bounds.end` (=NOW),
// which growth-metrics.ts's own `windowFilter` requires (`createdAt: { lt:
// bounds.end } }` — a strict `<`, so `createdAt: NOW` itself would NOT
// satisfy it). Explicit, not `@default(now())`: Prisma's schema default
// stamps the real wall clock, which drifts past this file's frozen `NOW` as
// soon as real time moves on — exactly what made
// `growth.clientGrowth.currentPeriodCount` flip from 1 to 0 once the
// calendar caught up to this fixture (Sale-Ready Phase E, E3.4). Every
// row this file creates that growth metrics can see must set `createdAt`
// explicitly to a fixed instant relative to `NOW`, never rely on the
// column's own default.
const CLIENT_CREATED_AT = new Date(NOW.getTime() - 60_000);

async function createOrgWithOwner(label: string) {
  const runSuffix = randomUUID().slice(0, 8);
  const owner = await prisma.user.create({
    data: { id: randomUUID(), email: testEmail(`analytics-svc-${label}`, "test.local", runSuffix), name: `Analytics ${label}` },
  });
  const org = await prisma.organization.create({
    data: { name: `Analytics Service Org ${label}`, slug: testSlug(`analytics-svc-${label}`, runSuffix) },
  });
  await prisma.membership.create({ data: { userId: owner.id, organizationId: org.id, role: "OWNER" } });
  return { owner, org };
}

describe("getOrganizationAnalytics", () => {
  let org: Awaited<ReturnType<typeof createOrgWithOwner>>;

  beforeAll(async () => {
    org = await createOrgWithOwner("A");
    await prisma.client.create({
      data: { name: "Service Client", userId: org.owner.id, organizationId: org.org.id, createdAt: CLIENT_CREATED_AT },
    });
  });

  afterAll(async () => {
    await prisma.subscription.deleteMany({ where: { organizationId: org.org.id } });
    await prisma.client.deleteMany({ where: { organizationId: org.org.id } });
    await prisma.organization.delete({ where: { id: org.org.id } });
    await prisma.user.delete({ where: { id: org.owner.id } });
  });

  it("MEMBER is denied with AnalyticsAccessError, before any query runs", async () => {
    await expect(getOrganizationAnalytics(org.org.id, "MEMBER", "last30Days", NOW)).rejects.toThrow(AnalyticsAccessError);
  });

  it("OWNER receives a full snapshot with every metric group present", async () => {
    const snapshot = await getOrganizationAnalytics(org.org.id, "OWNER", "last30Days", NOW);

    expect(snapshot.organizationId).toBe(org.org.id);
    expect(snapshot.timeRange).toBe("last30Days");
    expect(snapshot.computedAt).toEqual(NOW);
    expect(snapshot.organization.totalClients).toBe(1);
    expect(snapshot.activity).toEqual({ createdToday: 0, createdThisWeek: 0, createdThisMonth: 0 });
    expect(snapshot.completion.taskCompletionRate).toBe(0);
    expect(snapshot.completion.invoiceCompletionRate).toBe(0);
    expect(snapshot.growth.clientGrowth.currentPeriodCount).toBe(1);
    expect(typeof snapshot.onboarding.percent).toBe("number");
  });

  it("ADMIN also receives a full snapshot (not just OWNER)", async () => {
    const snapshot = await getOrganizationAnalytics(org.org.id, "ADMIN", "last30Days", NOW);
    expect(snapshot.organization.totalClients).toBe(1);
  });

  it("billing metrics fall back to LEGACY when no Subscription row exists", async () => {
    const snapshot = await getOrganizationAnalytics(org.org.id, "OWNER", "last30Days", NOW);
    expect(snapshot.billing.planKey).toBe("LEGACY");
    expect(snapshot.billing.subscriptionStatus).toBe("LEGACY");
  });

  it("billing metrics reflect a real Subscription row when one exists", async () => {
    await prisma.subscription.create({
      data: { organizationId: org.org.id, planKey: "PRO", status: "ACTIVE", trialStartedAt: NOW, trialEndsAt: NOW },
    });
    const snapshot = await getOrganizationAnalytics(org.org.id, "OWNER", "last30Days", NOW);
    expect(snapshot.billing.planKey).toBe("PRO");
    expect(snapshot.billing.subscriptionStatus).toBe("ACTIVE");
    await prisma.subscription.deleteMany({ where: { organizationId: org.org.id } });
  });

  it("allTime falls back to the default growth window instead of throwing", async () => {
    const snapshot = await getOrganizationAnalytics(org.org.id, "OWNER", "allTime", NOW);
    expect(snapshot.timeRange).toBe("allTime");
    expect(snapshot.growth.clientGrowth.currentPeriodCount).toBe(1); // still finds the one client created at CLIENT_CREATED_AT
  });

  it("is fully scoped to the given organization — never leaks another org's data", async () => {
    const { owner: otherOwner, org: otherOrg } = await createOrgWithOwner("B");
    const snapshot = await getOrganizationAnalytics(otherOrg.id, "OWNER", "last30Days", NOW);
    expect(snapshot.organization.totalClients).toBe(0);
    await prisma.organization.delete({ where: { id: otherOrg.id } });
    await prisma.user.delete({ where: { id: otherOwner.id } });
  });

  it("Stage 3: charts are present, adaptive to the selected range, and never a second query beyond this one call", async () => {
    const snapshot = await getOrganizationAnalytics(org.org.id, "OWNER", "last7Days", NOW);
    expect(snapshot.charts.clientGrowthSeries.unit).toBe("day");
    expect(snapshot.charts.projectGrowthSeries.unit).toBe("day");
    expect(snapshot.charts.taskActivitySeries.unit).toBe("day");
    expect(snapshot.charts.invoiceActivitySeries.unit).toBe("day");
    expect(snapshot.charts.activityEventsSeries.unit).toBe("day");
    expect(snapshot.charts.clientGrowthSeries.points.length).toBeGreaterThan(0);

    const hourly = await getOrganizationAnalytics(org.org.id, "OWNER", "today", NOW);
    expect(hourly.charts.clientGrowthSeries.unit).toBe("hour");

    const weekly = await getOrganizationAnalytics(org.org.id, "OWNER", "allTime", NOW);
    expect(weekly.charts.clientGrowthSeries.unit).toBe("week");
  });

  it("Stage 3: subscriptionEventCount is a real, present number (0 for an org with no WebhookEvent rows)", async () => {
    const snapshot = await getOrganizationAnalytics(org.org.id, "OWNER", "last30Days", NOW);
    expect(snapshot.billing.subscriptionEventCount).toBe(0);
  });

  it("Stage 4: portal metrics and portal chart series are present, adaptive, and never leak PII", async () => {
    const snapshot = await getOrganizationAnalytics(org.org.id, "OWNER", "last7Days", NOW);

    expect(snapshot.portal.totalPortalUsers).toBe(0);
    expect(snapshot.portal.portalAdoptionRate).toBe(0); // org has a Client but no PortalUser
    expect(snapshot.portal.documentsAvailable).toBe(0);
    expect(snapshot.portal.invoicesVisible).toBe(0);
    expect(snapshot.portal.invitationsAccepted).toEqual({ currentPeriodCount: 0, previousPeriodCount: 0, changePercent: null });
    expect(snapshot.portal.portalRelatedActivity).toBe(0);
    // Portal Analytics persistence Slice 2.
    expect(snapshot.portal.recentlyActivePortalUsers).toBe(0);
    expect(snapshot.portal.documentDownloadRequests).toBe(0);

    expect(snapshot.charts.portalUserGrowthSeries.unit).toBe("day");
    expect(snapshot.charts.portalInvitationSeries.unit).toBe("day");

    // No PortalUser email/name/id anywhere in the serialized snapshot —
    // every portal field is a plain count/rate/GrowthMetric.
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toMatch(/@test\.local/); // the fixture's own email domain
  });

  describe("Portal Analytics persistence Slice 2: recentlyActivePortalUsers / documentDownloadRequests", () => {
    let engagementOrg: Awaited<ReturnType<typeof createOrgWithOwner>>;
    let engagementClient: { id: string };

    // Deliberately older than DEFAULT_GROWTH_TIME_RANGE/last30Days (30
    // days before NOW) but still before NOW itself — the exact scenario
    // that would only be caught by a service-level test, never a direct
    // query test: if getOrganizationAnalytics ever accidentally passed
    // growthBounds (which silently substitutes last30Days for a selected
    // allTime) instead of the literal selectedBounds to
    // getPortalEngagementCounts, this data would wrongly disappear from
    // "allTime" too, not just from "last30Days".
    const OLD_LOGIN_AT = new Date(NOW.getTime() - 45 * 24 * 60 * 60 * 1000);
    const OLD_DOWNLOAD_AT = new Date(NOW.getTime() - 45 * 24 * 60 * 60 * 1000);

    beforeAll(async () => {
      engagementOrg = await createOrgWithOwner("engagement-svc");
      engagementClient = await prisma.client.create({
        data: { name: "Engagement Service Client", userId: engagementOrg.owner.id, organizationId: engagementOrg.org.id },
      });
      await prisma.portalUser.create({
        data: {
          id: randomUUID(),
          clientId: engagementClient.id,
          email: testEmail("engagement-svc", "test.local", randomUUID().slice(0, 8)),
          name: "Engagement Svc User",
          lastLoginAt: OLD_LOGIN_AT,
        },
      });
      await prisma.portalDownloadRequest.create({
        data: { organizationId: engagementOrg.org.id, requestedAt: OLD_DOWNLOAD_AT },
      });
    });

    afterAll(async () => {
      await prisma.portalDownloadRequest.deleteMany({ where: { organizationId: engagementOrg.org.id } });
      await prisma.client.deleteMany({ where: { organizationId: engagementOrg.org.id } });
      await prisma.organization.delete({ where: { id: engagementOrg.org.id } });
      await prisma.user.delete({ where: { id: engagementOrg.owner.id } });
    });

    it("last30Days excludes data older than 30 days from both new metrics", async () => {
      const snapshot = await getOrganizationAnalytics(engagementOrg.org.id, "OWNER", "last30Days", NOW);
      expect(snapshot.portal.recentlyActivePortalUsers).toBe(0);
      expect(snapshot.portal.documentDownloadRequests).toBe(0);
    });

    it("allTime is literal — not the growth-comparison last30Days fallback — and includes the same 45-day-old data", async () => {
      const snapshot = await getOrganizationAnalytics(engagementOrg.org.id, "OWNER", "allTime", NOW);
      expect(snapshot.timeRange).toBe("allTime");
      expect(snapshot.portal.recentlyActivePortalUsers).toBe(1);
      expect(snapshot.portal.documentDownloadRequests).toBe(1);
    });
  });
});

describe("getOrganizationAnalytics — Stage 3 empty-state scenarios", () => {
  it("a brand-new organization (no clients/projects/tasks/invoices/activity at all) returns a full snapshot with zero-filled charts, never an error", async () => {
    const { owner, org: emptyOrg } = await createOrgWithOwner("empty");
    const snapshot = await getOrganizationAnalytics(emptyOrg.id, "OWNER", "last30Days", NOW);

    expect(snapshot.organization.totalClients).toBe(0);
    expect(snapshot.charts.clientGrowthSeries.points.every((p) => p.count === 0)).toBe(true);
    expect(snapshot.charts.taskActivitySeries.points.every((p) => p.created === 0 && p.completed === 0)).toBe(true);
    // A brand-new org still has zero OrganizationOnboardingStep rows —
    // getOrganizationOnboardingProgress() has no error path for that.
    expect(typeof snapshot.onboarding.percent).toBe("number");
    expect(snapshot.onboarding.percent).toBeGreaterThanOrEqual(0);
    // No Subscription row — legacy fallback, not an error.
    expect(snapshot.billing.planKey).toBe("LEGACY");
    expect(snapshot.billing.subscriptionEventCount).toBe(0);

    await prisma.organization.delete({ where: { id: emptyOrg.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  });

  it("a legacy organization (real data, but no Subscription row at all) still renders full chart series", async () => {
    const { owner, org: legacyOrg } = await createOrgWithOwner("legacy");
    await prisma.client.create({ data: { name: "Legacy Client", userId: owner.id, organizationId: legacyOrg.id, createdAt: NOW } });

    const snapshot = await getOrganizationAnalytics(legacyOrg.id, "OWNER", "last30Days", NOW);
    expect(snapshot.billing.planKey).toBe("LEGACY");
    expect(snapshot.billing.subscriptionStatus).toBe("LEGACY");
    expect(snapshot.charts.clientGrowthSeries.points.reduce((sum, p) => sum + p.count, 0)).toBe(1);

    await prisma.client.deleteMany({ where: { organizationId: legacyOrg.id } });
    await prisma.organization.delete({ where: { id: legacyOrg.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  });

  it("Stage 4: a brand-new organization (zero Clients, zero PortalUsers) returns zero-filled portal metrics, never an error", async () => {
    const { owner, org: emptyOrg } = await createOrgWithOwner("portal-empty");
    const snapshot = await getOrganizationAnalytics(emptyOrg.id, "OWNER", "last30Days", NOW);

    expect(snapshot.portal).toEqual({
      totalPortalUsers: 0,
      portalAdoptionRate: 0,
      documentsAvailable: 0,
      invoicesVisible: 0,
      invitationsAccepted: { currentPeriodCount: 0, previousPeriodCount: 0, changePercent: null },
      portalRelatedActivity: 0,
      recentlyActivePortalUsers: 0,
      documentDownloadRequests: 0,
    });
    expect(snapshot.charts.portalUserGrowthSeries.points.every((p) => p.count === 0)).toBe(true);

    await prisma.organization.delete({ where: { id: emptyOrg.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  });
});
