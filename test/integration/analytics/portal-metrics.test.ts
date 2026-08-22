import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getPortalOverview, getPortalActivityCounts, getPortalEngagementCounts } from "@/lib/analytics/queries/portal-metrics";
import { testEmail, testSlug } from "../../support/run-id";

async function createOrgWithOwner(label: string) {
  const runSuffix = randomUUID().slice(0, 8);
  const owner = await prisma.user.create({
    data: { id: randomUUID(), email: testEmail(`analytics-pm-${label}`, "test.local", runSuffix), name: `Analytics ${label}` },
  });
  const org = await prisma.organization.create({
    data: { name: `Analytics Portal Metrics Org ${label}`, slug: testSlug(`analytics-pm-${label}`, runSuffix) },
  });
  await prisma.membership.create({ data: { userId: owner.id, organizationId: org.id, role: "OWNER" } });
  return { owner, org };
}

describe("getPortalOverview", () => {
  let org: Awaited<ReturnType<typeof createOrgWithOwner>>;
  let clientWithPortal: { id: string };
  let clientWithoutPortal: { id: string };

  beforeAll(async () => {
    org = await createOrgWithOwner("A");
    clientWithPortal = await prisma.client.create({ data: { name: "Client Portal", userId: org.owner.id, organizationId: org.org.id } });
    clientWithoutPortal = await prisma.client.create({ data: { name: "Client No Portal", userId: org.owner.id, organizationId: org.org.id } });

    await prisma.portalUser.create({
      data: { id: randomUUID(), clientId: clientWithPortal.id, email: testEmail("portal-pm-1", "test.local", randomUUID().slice(0, 8)), name: "Portal One" },
    });

    // Attachments: one on the portal-enabled Client, one on a Project under it, one on the no-portal Client.
    const project = await prisma.project.create({ data: { name: "Portal Project", clientId: clientWithPortal.id, ownerId: org.owner.id, organizationId: org.org.id } });
    await prisma.attachment.create({
      data: { organizationId: org.org.id, entityType: "CLIENT", entityId: clientWithPortal.id, storageBucket: "attachments", storagePath: `test/${randomUUID()}`, originalName: "a.pdf", mimeType: "application/pdf", sizeBytes: 10 },
    });
    await prisma.attachment.create({
      data: { organizationId: org.org.id, entityType: "PROJECT", entityId: project.id, storageBucket: "attachments", storagePath: `test/${randomUUID()}`, originalName: "b.pdf", mimeType: "application/pdf", sizeBytes: 10 },
    });
    await prisma.attachment.create({
      data: { organizationId: org.org.id, entityType: "CLIENT", entityId: clientWithoutPortal.id, storageBucket: "attachments", storagePath: `test/${randomUUID()}`, originalName: "c.pdf", mimeType: "application/pdf", sizeBytes: 10 },
    });

    // Invoices: one for the portal client, one for the non-portal client.
    await prisma.invoice.create({ data: { invoiceNumber: "INV-P-1", amount: "10.00", clientId: clientWithPortal.id, projectId: project.id, organizationId: org.org.id } });
    const project2 = await prisma.project.create({ data: { name: "No Portal Project", clientId: clientWithoutPortal.id, ownerId: org.owner.id, organizationId: org.org.id } });
    await prisma.invoice.create({ data: { invoiceNumber: "INV-NP-1", amount: "10.00", clientId: clientWithoutPortal.id, projectId: project2.id, organizationId: org.org.id } });
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { organizationId: org.org.id } });
    await prisma.client.deleteMany({ where: { organizationId: org.org.id } }); // cascades Project, PortalUser
    await prisma.organization.delete({ where: { id: org.org.id } });
    await prisma.user.delete({ where: { id: org.owner.id } });
  });

  it("totalPortalUsers counts only this organization's PortalUser rows", async () => {
    const overview = await getPortalOverview(prisma, org.org.id);
    expect(overview.totalPortalUsers).toBe(1);
  });

  it("portalAdoptionRate is the percent of Clients with at least one PortalUser", async () => {
    const overview = await getPortalOverview(prisma, org.org.id);
    expect(overview.portalAdoptionRate).toBe(50); // 1 of 2 clients
  });

  it("documentsAvailable counts Client-level AND Project-level attachments reachable by a portal identity, never the non-portal client's", async () => {
    const overview = await getPortalOverview(prisma, org.org.id);
    expect(overview.documentsAvailable).toBe(2); // client-level + project-level, both under clientWithPortal
  });

  it("invoicesVisible counts only invoices belonging to a Client with portal access", async () => {
    const overview = await getPortalOverview(prisma, org.org.id);
    expect(overview.invoicesVisible).toBe(1);
  });

  it("a fresh organization with no clients at all returns all zeros, portalAdoptionRate 0 (never NaN)", async () => {
    const { owner, org: freshOrg } = await createOrgWithOwner("empty");
    const overview = await getPortalOverview(prisma, freshOrg.id);
    expect(overview).toEqual({ totalPortalUsers: 0, portalAdoptionRate: 0, documentsAvailable: 0, invoicesVisible: 0 });
    await prisma.organization.delete({ where: { id: freshOrg.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  });

  it("never leaks another organization's portal data", async () => {
    const { owner: otherOwner, org: otherOrg } = await createOrgWithOwner("isolated");
    const overview = await getPortalOverview(prisma, otherOrg.id);
    expect(overview.totalPortalUsers).toBe(0);
    expect(overview.documentsAvailable).toBe(0);
    await prisma.organization.delete({ where: { id: otherOrg.id } });
    await prisma.user.delete({ where: { id: otherOwner.id } });
  });
});

describe("getPortalActivityCounts", () => {
  let org: Awaited<ReturnType<typeof createOrgWithOwner>>;
  const bounds = { start: new Date("2026-08-01T00:00:00.000Z"), end: new Date("2026-08-12T00:00:00.000Z") };
  const previousBounds = { start: new Date("2026-07-21T00:00:00.000Z"), end: new Date("2026-08-01T00:00:00.000Z") };

  beforeAll(async () => {
    org = await createOrgWithOwner("counts");
    await prisma.activity.create({
      data: { organizationId: org.org.id, actorId: null, entityType: "PORTAL_USER", entityId: randomUUID(), action: "PORTAL_INVITATION_ACCEPTED", createdAt: new Date("2026-08-05T00:00:00.000Z") },
    });
    await prisma.activity.create({
      data: { organizationId: org.org.id, actorId: org.owner.id, entityType: "PORTAL_USER", entityId: randomUUID(), action: "PORTAL_INVITATION_SENT", createdAt: new Date("2026-08-06T00:00:00.000Z") },
    });
    // Outside the window entirely.
    await prisma.activity.create({
      data: { organizationId: org.org.id, actorId: null, entityType: "PORTAL_USER", entityId: randomUUID(), action: "PORTAL_INVITATION_ACCEPTED", createdAt: new Date("2020-01-01T00:00:00.000Z") },
    });
    // Non-portal Activity — must never be counted in portalRelatedActivity.
    await prisma.activity.create({
      data: { organizationId: org.org.id, actorId: org.owner.id, entityType: "CLIENT", entityId: randomUUID(), action: "CREATED", createdAt: new Date("2026-08-05T00:00:00.000Z") },
    });
  });

  afterAll(async () => {
    await prisma.activity.deleteMany({ where: { organizationId: org.org.id } });
    await prisma.organization.delete({ where: { id: org.org.id } });
    await prisma.user.delete({ where: { id: org.owner.id } });
  });

  it("invitationsAccepted counts PORTAL_INVITATION_ACCEPTED within bounds, with a real GrowthMetric shape", async () => {
    const counts = await getPortalActivityCounts(prisma, org.org.id, bounds, previousBounds);
    expect(counts.invitationsAccepted.currentPeriodCount).toBe(1);
    expect(counts.invitationsAccepted.previousPeriodCount).toBe(0);
    expect(counts.invitationsAccepted.changePercent).toBeNull();
  });

  it("portalRelatedActivity counts every PORTAL_USER-entityType Activity in the window, never a non-portal one", async () => {
    const counts = await getPortalActivityCounts(prisma, org.org.id, bounds, previousBounds);
    expect(counts.portalRelatedActivity).toBe(2); // accepted + sent, both PORTAL_USER entityType, both in-window
  });
});

/**
 * Portal Analytics persistence Slice 2 (docs/analytics-architecture.md
 * §12.2a/§12.3). `bounds` here is always the literal selected-range
 * bounds a caller would pass — never growthBounds — and every timestamp
 * filter must follow this domain's half-open `[start, end)` convention:
 * `start` inclusive, `end` exclusive.
 */
describe("getPortalEngagementCounts", () => {
  let org: Awaited<ReturnType<typeof createOrgWithOwner>>;
  let client: { id: string };
  const start = new Date("2026-08-01T00:00:00.000Z");
  const end = new Date("2026-08-12T00:00:00.000Z");
  const bounds = { start, end };

  const beforeStart = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  const inRange = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  beforeAll(async () => {
    org = await createOrgWithOwner("engagement");
    client = await prisma.client.create({ data: { name: "Engagement Client", userId: org.owner.id, organizationId: org.org.id } });

    // recentlyActivePortalUsers fixtures — one PortalUser per boundary case.
    await prisma.portalUser.createMany({
      data: [
        { id: randomUUID(), clientId: client.id, email: testEmail("engagement-no-login", "test.local", randomUUID().slice(0, 8)), name: "No Login", lastLoginAt: null },
        { id: randomUUID(), clientId: client.id, email: testEmail("engagement-before", "test.local", randomUUID().slice(0, 8)), name: "Before Start", lastLoginAt: beforeStart },
        { id: randomUUID(), clientId: client.id, email: testEmail("engagement-at-start", "test.local", randomUUID().slice(0, 8)), name: "At Start", lastLoginAt: start },
        { id: randomUUID(), clientId: client.id, email: testEmail("engagement-in-range", "test.local", randomUUID().slice(0, 8)), name: "In Range", lastLoginAt: inRange },
        { id: randomUUID(), clientId: client.id, email: testEmail("engagement-at-end", "test.local", randomUUID().slice(0, 8)), name: "At End", lastLoginAt: end },
      ],
    });

    // documentDownloadRequests fixtures — one row per boundary case.
    await prisma.portalDownloadRequest.createMany({
      data: [
        { organizationId: org.org.id, requestedAt: beforeStart },
        { organizationId: org.org.id, requestedAt: start },
        { organizationId: org.org.id, requestedAt: inRange },
        { organizationId: org.org.id, requestedAt: end },
      ],
    });
  });

  afterAll(async () => {
    await prisma.portalDownloadRequest.deleteMany({ where: { organizationId: org.org.id } });
    await prisma.client.deleteMany({ where: { organizationId: org.org.id } }); // cascades PortalUser
    await prisma.organization.delete({ where: { id: org.org.id } });
    await prisma.user.delete({ where: { id: org.owner.id } });
  });

  it("recentlyActivePortalUsers: correct count for the selected bounds — [start, end) half-open", async () => {
    const counts = await getPortalEngagementCounts(prisma, org.org.id, bounds);
    // "At Start" (== start, included) + "In Range" (included) = 2.
    // "No Login" (null), "Before Start" (< start), "At End" (== end, excluded).
    expect(counts.recentlyActivePortalUsers).toBe(2);
  });

  it("recentlyActivePortalUsers: a PortalUser with lastLoginAt = null is excluded, even under bounds wide enough to catch everything else", async () => {
    // A window spanning from well before "Before Start" to well after "At
    // End" would count all 4 non-null fixtures if the null one leaked in
    // too, the count would be 5, not 4.
    const wideBounds = { start: new Date(beforeStart.getTime() - 1), end: new Date(end.getTime() + 1) };
    const counts = await getPortalEngagementCounts(prisma, org.org.id, wideBounds);
    expect(counts.recentlyActivePortalUsers).toBe(4); // every fixture except "No Login"
  });

  it("recentlyActivePortalUsers: a PortalUser before the selected start is excluded", async () => {
    // A window spanning exactly [beforeStart, start) legitimately contains
    // only "Before Start" among the fixtures — proving it's real and
    // findable by this same function — while the real selected bounds
    // (start, not beforeStart) must not count it: the "correct count"
    // test above already proves the real-bounds total is 2, not 3, which
    // is only possible if this fixture is excluded once bounds.start
    // moves to `start`.
    const isolatedWindow = { start: beforeStart, end: start };
    const isolated = await getPortalEngagementCounts(prisma, org.org.id, isolatedWindow);
    expect(isolated.recentlyActivePortalUsers).toBe(1); // sanity: "Before Start" is real and findable
    const counts = await getPortalEngagementCounts(prisma, org.org.id, bounds);
    expect(counts.recentlyActivePortalUsers).toBe(2); // and excluded once bounds.start is `start`
  });

  it("recentlyActivePortalUsers: a PortalUser exactly at start is included", async () => {
    const exactBounds = { start, end: new Date(start.getTime() + 1) };
    const counts = await getPortalEngagementCounts(prisma, org.org.id, exactBounds);
    expect(counts.recentlyActivePortalUsers).toBe(1); // only "At Start" — gte(start) includes it
  });

  it("recentlyActivePortalUsers: a PortalUser exactly at end is excluded", async () => {
    const endOnlyBounds = { start: end, end: new Date(end.getTime() + 1) };
    const withEndIncludedIfBuggy = await getPortalEngagementCounts(prisma, org.org.id, endOnlyBounds);
    // "At End" (lastLoginAt === end) is >= this narrow window's own start
    // (== end), so it WOULD be found here if lt(end) weren't already
    // proven exclusive by the very next assertion against the real bounds.
    expect(withEndIncludedIfBuggy.recentlyActivePortalUsers).toBe(1); // sanity: the at-end fixture really exists at that instant
    const counts = await getPortalEngagementCounts(prisma, org.org.id, bounds);
    expect(counts.recentlyActivePortalUsers).toBe(2); // "At End" not among them — lt(end), not lte(end)
  });

  it("documentDownloadRequests: correct count for the selected bounds — [start, end) half-open", async () => {
    const counts = await getPortalEngagementCounts(prisma, org.org.id, bounds);
    // requestedAt === start (included) + requestedAt === inRange (included) = 2.
    // requestedAt === beforeStart (excluded) + requestedAt === end (excluded).
    expect(counts.documentDownloadRequests).toBe(2);
  });

  it("documentDownloadRequests: a download event before start is excluded", async () => {
    const isolatedWindow = { start: beforeStart, end: start };
    const isolated = await getPortalEngagementCounts(prisma, org.org.id, isolatedWindow);
    expect(isolated.documentDownloadRequests).toBe(1); // sanity: the before-start row is real and findable
    const counts = await getPortalEngagementCounts(prisma, org.org.id, bounds);
    expect(counts.documentDownloadRequests).toBe(2); // and excluded once bounds.start is `start`
  });

  it("documentDownloadRequests: a download event exactly at start is included", async () => {
    const exactBounds = { start, end: new Date(start.getTime() + 1) };
    const counts = await getPortalEngagementCounts(prisma, org.org.id, exactBounds);
    expect(counts.documentDownloadRequests).toBe(1); // gte(start) includes the row requestedAt === start
  });

  it("documentDownloadRequests: a download event exactly at end is excluded", async () => {
    const endOnlyBounds = { start: end, end: new Date(end.getTime() + 1) };
    const sanity = await getPortalEngagementCounts(prisma, org.org.id, endOnlyBounds);
    expect(sanity.documentDownloadRequests).toBe(1); // sanity: the at-end fixture really exists at that instant
    const counts = await getPortalEngagementCounts(prisma, org.org.id, bounds);
    expect(counts.documentDownloadRequests).toBe(2); // the at-end row not among them — lt(end), not lte(end)
  });

  it("never counts another organization's PortalUser or PortalDownloadRequest data, in either direction", async () => {
    const { owner: otherOwner, org: otherOrg } = await createOrgWithOwner("engagement-isolated");
    const otherClient = await prisma.client.create({ data: { name: "Other Client", userId: otherOwner.id, organizationId: otherOrg.id } });
    await prisma.portalUser.create({
      data: { id: randomUUID(), clientId: otherClient.id, email: testEmail("engagement-other", "test.local", randomUUID().slice(0, 8)), name: "Other Org User", lastLoginAt: inRange },
    });
    await prisma.portalDownloadRequest.create({ data: { organizationId: otherOrg.id, requestedAt: inRange } });

    const orgACounts = await getPortalEngagementCounts(prisma, org.org.id, bounds);
    expect(orgACounts.recentlyActivePortalUsers).toBe(2); // unchanged by orgB's own data
    expect(orgACounts.documentDownloadRequests).toBe(2);

    const orgBCounts = await getPortalEngagementCounts(prisma, otherOrg.id, bounds);
    expect(orgBCounts.recentlyActivePortalUsers).toBe(1); // only its own row
    expect(orgBCounts.documentDownloadRequests).toBe(1);

    await prisma.portalDownloadRequest.deleteMany({ where: { organizationId: otherOrg.id } });
    await prisma.client.deleteMany({ where: { organizationId: otherOrg.id } });
    await prisma.organization.delete({ where: { id: otherOrg.id } });
    await prisma.user.delete({ where: { id: otherOwner.id } });
  });

  it("a fresh organization returns both values as numeric 0", async () => {
    const { owner: freshOwner, org: freshOrg } = await createOrgWithOwner("engagement-empty");
    const counts = await getPortalEngagementCounts(prisma, freshOrg.id, bounds);
    expect(counts).toEqual({ recentlyActivePortalUsers: 0, documentDownloadRequests: 0 });
    await prisma.organization.delete({ where: { id: freshOrg.id } });
    await prisma.user.delete({ where: { id: freshOwner.id } });
  });

  it("returns exactly the two scalar fields — no PII, no identifiers, no timestamps", async () => {
    const counts = await getPortalEngagementCounts(prisma, org.org.id, bounds);
    // An exact-shape equality is itself the proof: any additional key
    // (an id, an email, a raw timestamp) would fail this assertion.
    expect(counts).toEqual({ recentlyActivePortalUsers: 2, documentDownloadRequests: 2 });
    expect(Object.keys(counts).sort()).toEqual(["documentDownloadRequests", "recentlyActivePortalUsers"]);
  });
});
