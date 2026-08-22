import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getOrCreateOrganizationId } from "@/lib/current-user";
import { createTrialSubscription } from "@/lib/billing/provisioning";
import { testEmail, testSlug } from "../../support/run-id";

async function createTestUser(label: string) {
  const id = randomUUID();
  const user = await prisma.user.create({
    data: { id, email: testEmail(`billing-prov-${label}`, "test.local"), name: `Billing Prov ${label}` },
  });
  return user;
}

describe("createTrialSubscription — atomic new-Organization provisioning", () => {
  it("a new Organization gets a trial Subscription row atomically, via getOrCreateOrganizationId", async () => {
    const user = await createTestUser(randomUUID().slice(0, 8));

    const organizationId = await getOrCreateOrganizationId(user);

    const org = await prisma.organization.findUnique({ where: { id: organizationId } });
    expect(org).not.toBeNull();

    const subscription = await prisma.subscription.findUnique({ where: { organizationId } });
    expect(subscription).not.toBeNull();
    expect(subscription?.planKey).toBe("TRIAL");
    expect(subscription?.status).toBe("TRIALING");
    expect(subscription?.trialStartedAt).toBeInstanceOf(Date);

    const expectedTrialEnd = subscription!.trialStartedAt.getTime() + 14 * 24 * 60 * 60 * 1000;
    expect(Math.abs(subscription!.trialEndsAt.getTime() - expectedTrialEnd)).toBeLessThan(5000);

    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("calling getOrCreateOrganizationId again for the same user returns the same org, no duplicate Subscription", async () => {
    const user = await createTestUser(randomUUID().slice(0, 8));

    const first = await getOrCreateOrganizationId(user);
    const second = await getOrCreateOrganizationId(user);

    expect(second).toBe(first);
    const subscriptions = await prisma.subscription.count({ where: { organizationId: first } });
    expect(subscriptions).toBe(1);

    await prisma.organization.delete({ where: { id: first } });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("concurrent first-login calls for the same user still produce exactly one Organization and one Subscription", async () => {
    const user = await createTestUser(randomUUID().slice(0, 8));

    const [orgIdA, orgIdB] = await Promise.all([
      getOrCreateOrganizationId(user),
      getOrCreateOrganizationId(user),
    ]);

    expect(orgIdA).toBe(orgIdB);
    const orgCount = await prisma.membership.count({ where: { userId: user.id, role: "OWNER" } });
    expect(orgCount).toBe(1);
    const subscriptionCount = await prisma.subscription.count({ where: { organizationId: orgIdA } });
    expect(subscriptionCount).toBe(1);

    await prisma.organization.delete({ where: { id: orgIdA } });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("createTrialSubscription itself is idempotent — a second call for the same organizationId never overwrites the first row", async () => {
    const org = await prisma.organization.create({
      data: { name: "Idempotency Check Org", slug: testSlug("billing-idempotent", randomUUID().slice(0, 8)) },
    });

    const firstNow = new Date("2026-01-01T00:00:00.000Z");
    await prisma.$transaction((tx) => createTrialSubscription(tx, org.id, firstNow));

    const secondNow = new Date("2026-06-01T00:00:00.000Z");
    await prisma.$transaction((tx) => createTrialSubscription(tx, org.id, secondNow));

    const subscription = await prisma.subscription.findUnique({ where: { organizationId: org.id } });
    expect(subscription?.trialStartedAt.toISOString()).toBe(firstNow.toISOString());

    await prisma.organization.delete({ where: { id: org.id } });
  });

  it("invited users joining an existing org never create a second Subscription for that org", async () => {
    // Simulates acceptInvitationAction's own shape: a Membership upsert
    // into an *existing* organizationId, never calling
    // getOrCreateOrganizationId at all (see src/app/invite/[token]/
    // actions.ts, unchanged by this stage) — this test asserts the
    // invariant that code path depends on: joining an existing org must
    // never touch Subscription.
    const owner = await createTestUser(`owner-${randomUUID().slice(0, 8)}`);
    const organizationId = await getOrCreateOrganizationId(owner);

    const invitedUser = await createTestUser(`invitee-${randomUUID().slice(0, 8)}`);
    await prisma.membership.create({
      data: { userId: invitedUser.id, organizationId, role: "MEMBER" },
    });

    const subscriptionCount = await prisma.subscription.count({ where: { organizationId } });
    expect(subscriptionCount).toBe(1);

    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, invitedUser.id] } } });
  });

  it("two different organizations get fully independent Subscription rows", async () => {
    const userA = await createTestUser(`a-${randomUUID().slice(0, 8)}`);
    const userB = await createTestUser(`b-${randomUUID().slice(0, 8)}`);

    const orgIdA = await getOrCreateOrganizationId(userA);
    const orgIdB = await getOrCreateOrganizationId(userB);

    expect(orgIdA).not.toBe(orgIdB);

    // Mutate org A's subscription and confirm org B's is untouched.
    await prisma.subscription.update({ where: { organizationId: orgIdA }, data: { status: "PAST_DUE" } });

    const subA = await prisma.subscription.findUnique({ where: { organizationId: orgIdA } });
    const subB = await prisma.subscription.findUnique({ where: { organizationId: orgIdB } });
    expect(subA?.status).toBe("PAST_DUE");
    expect(subB?.status).toBe("TRIALING");

    await prisma.organization.deleteMany({ where: { id: { in: [orgIdA, orgIdB] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  });

  it("a failure inside the same transaction that creates the Organization rolls the Organization back too (the atomicity getOrCreateOrganizationId's own coupling depends on)", async () => {
    const slug = testSlug("billing-rollback", randomUUID().slice(0, 8));

    await expect(
      prisma.$transaction(async (tx) => {
        const org = await tx.organization.create({ data: { name: "Should Roll Back", slug } });
        // A real Postgres FK-constraint failure (this userId was never
        // created as an actual User row), not a hand-rolled throw — the
        // same real transactional-rollback guarantee
        // getOrCreateOrganizationId's own Organization + Membership +
        // Subscription coupling (current-user.ts, provisioning.ts) relies
        // on: any failure anywhere inside that one transaction, including
        // one from the createTrialSubscription step, must roll every
        // write in it back together, not leave a partial Organization
        // with no Subscription behind.
        await tx.membership.create({ data: { userId: randomUUID(), organizationId: org.id, role: "OWNER" } });
      }),
    ).rejects.toThrow();

    const orphanedOrg = await prisma.organization.findUnique({ where: { slug } });
    expect(orphanedOrg).toBeNull();
  });
});
