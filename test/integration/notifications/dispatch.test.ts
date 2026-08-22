import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/enums";
import { createActivity } from "@/lib/activity/create-activity";
import { buildRoleChangedMetadata, buildInvitationAcceptedMetadata } from "@/lib/activity/team-metadata";
import { buildInvoiceStatusChangedMetadata } from "@/lib/activity/invoice-metadata";
import { changeRoleAction, removeMemberAction } from "@/app/(dashboard)/team/actions";
import { acceptInvitationAction } from "@/app/invite/[token]/actions";
import { acceptClientInvitationAction } from "@/app/portal/invite/[token]/actions";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, setMockAuthUser, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal, resetNavigationMock } from "../../support/navigation-mock";
import { testEmail } from "../../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../../support/env";

// Notification.metadata is deliberately checked by EXACT key set (not just
// spot-checked values) in every scenario below — that's what proves the
// allowlist in src/lib/notifications/notification-metadata.ts drops fields
// like memberEmail/token that the corresponding Activity.metadata builder
// does include, rather than a passthrough of the whole object.

describe("notification fan-out from Activity", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(() => {
    resetAuthMock();
    resetNavigationMock();
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("ROLE_CHANGED creates exactly one Notification, to the affected member, with an allowlisted metadata shape", async () => {
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { userId_organizationId: { userId: fixtures.member.id, organizationId: fixtures.orgA.id } },
    });
    actAs(fixtures.owner, fixtures.orgA.id);

    await changeRoleAction(membership.id, Role.ADMIN);

    const activity = await prisma.activity.findFirstOrThrow({
      where: { entityId: membership.id, action: "ROLE_CHANGED" },
    });
    const notifications = await prisma.notification.findMany({ where: { activityId: activity.id } });

    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("ROLE_CHANGED");
    expect(notifications[0].recipientId).toBe(fixtures.member.id);
    expect(notifications[0].organizationId).toBe(fixtures.orgA.id);
    expect(Object.keys(notifications[0].metadata as object).sort()).toEqual(["actorName", "from", "to"].sort());
    expect((notifications[0].metadata as Record<string, unknown>).from).toBe("MEMBER");
    expect((notifications[0].metadata as Record<string, unknown>).to).toBe("ADMIN");

    await prisma.notification.deleteMany({ where: { activityId: activity.id } });
    await prisma.activity.deleteMany({ where: { entityId: membership.id } });
    await prisma.membership.update({ where: { id: membership.id }, data: { role: Role.MEMBER } });
  });

  it("a no-op role change (same role) creates 0 Activity rows and 0 Notifications", async () => {
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { userId_organizationId: { userId: fixtures.member.id, organizationId: fixtures.orgA.id } },
    });
    actAs(fixtures.owner, fixtures.orgA.id);

    const activityCountBefore = await prisma.activity.count({ where: { entityId: membership.id } });
    const result = await changeRoleAction(membership.id, Role.MEMBER);
    const activityCountAfter = await prisma.activity.count({ where: { entityId: membership.id } });

    expect(result.error).toBeNull();
    expect(activityCountAfter).toBe(activityCountBefore);
    const notifications = await prisma.notification.findMany({
      where: { recipientId: fixtures.member.id, entityId: membership.id },
    });
    expect(notifications).toHaveLength(0);
  });

  it("the dispatcher excludes the actor from a rule's own recipients, even if the rule computed them as one", async () => {
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { userId_organizationId: { userId: fixtures.member.id, organizationId: fixtures.orgA.id } },
    });

    const activity = await prisma.$transaction((tx) =>
      createActivity(tx, {
        organizationId: fixtures.orgA.id,
        actorId: fixtures.member.id,
        entityType: "MEMBERSHIP",
        entityId: membership.id,
        action: "ROLE_CHANGED",
        metadata: buildRoleChangedMetadata(fixtures.member, "MEMBER", "ADMIN", fixtures.member.name),
        // A rule would never legitimately compute this in real code (the UI
        // blocks self-role-changes), but the dispatcher's actor-exclusion
        // must hold regardless of what a rule hands it.
        notificationContext: { affectedUserId: fixtures.member.id },
      }),
    );

    const notifications = await prisma.notification.findMany({ where: { activityId: activity.id } });
    expect(notifications).toHaveLength(0);

    await prisma.activity.delete({ where: { id: activity.id } });
  });

  it("OWNERSHIP_TRANSFERRED notifies only the new owner, never the previous owner/actor, with no duplicates", async () => {
    const adminMembership = await prisma.membership.findUniqueOrThrow({
      where: { userId_organizationId: { userId: fixtures.admin.id, organizationId: fixtures.orgA.id } },
    });
    actAs(fixtures.owner, fixtures.orgA.id);

    await changeRoleAction(adminMembership.id, Role.OWNER);

    const activity = await prisma.activity.findFirstOrThrow({
      where: { entityId: adminMembership.id, action: "OWNERSHIP_TRANSFERRED" },
    });
    const notifications = await prisma.notification.findMany({ where: { activityId: activity.id } });

    expect(notifications).toHaveLength(1);
    expect(notifications[0].recipientId).toBe(fixtures.admin.id);
    expect(Object.keys(notifications[0].metadata as object).sort()).toEqual(
      ["actorName", "previousOwnerName", "newOwnerName"].sort(),
    );

    await prisma.notification.deleteMany({ where: { activityId: activity.id } });
    await prisma.activity.deleteMany({ where: { entityId: adminMembership.id } });

    // Transfer ownership back via the same action (admin is now OWNER,
    // owner is ADMIN) so later tests in this file see the original fixture
    // roles — restores state exactly like creation.test.ts's own pattern.
    actAs(fixtures.admin, fixtures.orgA.id);
    const ownerMembership = await prisma.membership.findUniqueOrThrow({
      where: { userId_organizationId: { userId: fixtures.owner.id, organizationId: fixtures.orgA.id } },
    });
    await changeRoleAction(ownerMembership.id, Role.OWNER);
    const revertActivity = await prisma.activity.findFirstOrThrow({
      where: { entityId: ownerMembership.id, action: "OWNERSHIP_TRANSFERRED" },
    });
    await prisma.notification.deleteMany({ where: { activityId: revertActivity.id } });
    await prisma.activity.deleteMany({ where: { entityId: ownerMembership.id } });
  });

  it("MEMBER_REMOVED's Notification persists correctly after the Membership row is gone", async () => {
    const disposableUser = await prisma.user.create({
      data: { email: testEmail("notif-removed", TEST_EMAIL_DOMAIN, fixtures.runId), name: "Disposable Removed" },
    });
    const disposableMembership = await prisma.membership.create({
      data: { userId: disposableUser.id, organizationId: fixtures.orgA.id, role: Role.MEMBER },
    });
    actAs(fixtures.owner, fixtures.orgA.id);

    await removeMemberAction(disposableMembership.id);

    const activity = await prisma.activity.findFirstOrThrow({
      where: { entityId: disposableMembership.id, action: "MEMBER_REMOVED" },
    });
    const notifications = await prisma.notification.findMany({ where: { activityId: activity.id } });
    const stillThereMembership = await prisma.membership.findUnique({ where: { id: disposableMembership.id } });

    expect(stillThereMembership).toBeNull();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].recipientId).toBe(disposableUser.id);
    expect(notifications[0].organizationId).toBe(fixtures.orgA.id);
    expect(Object.keys(notifications[0].metadata as object).sort()).toEqual(["actorName", "memberName"].sort());

    await prisma.notification.deleteMany({ where: { activityId: activity.id } });
    await prisma.activity.deleteMany({ where: { entityId: disposableMembership.id } });
    await prisma.user.delete({ where: { id: disposableUser.id } });
  });

  it("INVITATION_ACCEPTED notifies the inviter, not the acceptor", async () => {
    const invitation = await prisma.invitation.create({
      data: {
        organizationId: fixtures.orgA.id,
        email: testEmail(`notif-invite-${randomUUID().slice(0, 8)}`, TEST_EMAIL_DOMAIN, fixtures.runId),
        role: Role.MEMBER,
        token: randomUUID(),
        status: "PENDING",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        invitedById: fixtures.owner.id,
      },
    });
    const authUserId = randomUUID();
    setMockAuthUser({ id: authUserId, email: invitation.email });

    await expect(acceptInvitationAction(invitation.token)).rejects.toThrow(RedirectSignal);

    const activity = await prisma.activity.findFirstOrThrow({
      where: { entityId: invitation.id, action: "INVITATION_ACCEPTED" },
    });
    const notifications = await prisma.notification.findMany({ where: { activityId: activity.id } });

    expect(notifications).toHaveLength(1);
    expect(notifications[0].recipientId).toBe(fixtures.owner.id);
    expect(notifications[0].recipientId).not.toBe(authUserId);
    expect(Object.keys(notifications[0].metadata as object).sort()).toEqual(
      ["actorName", "acceptedUserName", "email", "role"].sort(),
    );

    await prisma.notification.deleteMany({ where: { activityId: activity.id } });
    await prisma.membership.deleteMany({ where: { userId: authUserId } });
    await prisma.activity.deleteMany({ where: { entityId: invitation.id } });
    await prisma.invitation.delete({ where: { id: invitation.id } });
    await prisma.user.deleteMany({ where: { id: authUserId } });
  });

  it("a null invitedById on the accepted invitation creates 0 notifications and no error", async () => {
    const invitation = await prisma.invitation.create({
      data: {
        organizationId: fixtures.orgA.id,
        email: testEmail(`notif-noinviter-${randomUUID().slice(0, 8)}`, TEST_EMAIL_DOMAIN, fixtures.runId),
        role: Role.MEMBER,
        token: randomUUID(),
        status: "PENDING",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        invitedById: null,
      },
    });
    const authUserId = randomUUID();
    setMockAuthUser({ id: authUserId, email: invitation.email });

    await expect(acceptInvitationAction(invitation.token)).rejects.toThrow(RedirectSignal);

    const activity = await prisma.activity.findFirstOrThrow({
      where: { entityId: invitation.id, action: "INVITATION_ACCEPTED" },
    });
    const notifications = await prisma.notification.findMany({ where: { activityId: activity.id } });
    expect(notifications).toHaveLength(0);

    await prisma.membership.deleteMany({ where: { userId: authUserId } });
    await prisma.activity.deleteMany({ where: { entityId: invitation.id } });
    await prisma.invitation.delete({ where: { id: invitation.id } });
    await prisma.user.deleteMany({ where: { id: authUserId } });
  });

  it("a recipient id that doesn't match any User is a silent no-op, not a foreign-key error", async () => {
    const phantomInvitedById = randomUUID();

    const activity = await prisma.$transaction((tx) =>
      createActivity(tx, {
        organizationId: fixtures.orgA.id,
        actorId: fixtures.member.id,
        entityType: "INVITATION",
        entityId: randomUUID(),
        action: "INVITATION_ACCEPTED",
        metadata: buildInvitationAcceptedMetadata(
          { email: "ghost@example.com", role: "MEMBER" },
          "Ghost",
          "Ghost",
        ),
        notificationContext: { invitedById: phantomInvitedById },
      }),
    );

    const notifications = await prisma.notification.findMany({ where: { activityId: activity.id } });
    expect(notifications).toHaveLength(0);

    await prisma.activity.delete({ where: { id: activity.id } });
  });

  it("PORTAL_INVITATION_ACCEPTED notifies the staff inviter", async () => {
    const clientInvitation = await prisma.clientInvitation.create({
      data: {
        clientId: fixtures.clientA.id,
        email: testEmail(`notif-portal-${randomUUID().slice(0, 8)}`, TEST_EMAIL_DOMAIN, fixtures.runId),
        token: randomUUID(),
        status: "PENDING",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        invitedById: fixtures.owner.id,
      },
    });
    const authUserId = randomUUID();
    setMockAuthUser({ id: authUserId, email: clientInvitation.email });

    await expect(acceptClientInvitationAction(clientInvitation.token)).rejects.toThrow(RedirectSignal);

    const activity = await prisma.activity.findFirstOrThrow({
      where: { entityId: authUserId, action: "PORTAL_INVITATION_ACCEPTED" },
    });
    const notifications = await prisma.notification.findMany({ where: { activityId: activity.id } });

    expect(notifications).toHaveLength(1);
    expect(notifications[0].recipientId).toBe(fixtures.owner.id);
    expect(Object.keys(notifications[0].metadata as object).sort()).toEqual(
      ["acceptedUserName", "email", "clientName"].sort(),
    );

    await prisma.notification.deleteMany({ where: { activityId: activity.id } });
    await prisma.activity.deleteMany({ where: { entityId: authUserId } });
    await prisma.portalUser.deleteMany({ where: { id: authUserId } });
    await prisma.clientInvitation.delete({ where: { id: clientInvitation.id } });
  });

  it("INVOICE_STATUS_CHANGED notifies every OWNER/ADMIN in the org (one-to-many), excluding the actor, never cross-org", async () => {
    const activity = await prisma.$transaction((tx) =>
      createActivity(tx, {
        organizationId: fixtures.orgA.id,
        actorId: fixtures.member.id,
        entityType: "INVOICE",
        entityId: fixtures.invoice.id,
        action: "STATUS_CHANGED",
        metadata: buildInvoiceStatusChangedMetadata(
          { invoiceNumber: fixtures.invoice.invoiceNumber },
          "Test Project",
          "DRAFT",
          "SENT",
          fixtures.member.name,
        ),
      }),
    );

    const notifications = await prisma.notification.findMany({ where: { activityId: activity.id } });
    const recipientIds = notifications.map((n) => n.recipientId).sort();

    expect(recipientIds).toEqual([fixtures.admin.id, fixtures.owner.id].sort());
    expect(recipientIds).not.toContain(fixtures.orgBOwner.id);
    for (const n of notifications) {
      expect(Object.keys(n.metadata as object).sort()).toEqual(
        ["invoiceNumber", "from", "to", "projectName"].sort(),
      );
    }

    await prisma.notification.deleteMany({ where: { activityId: activity.id } });
    await prisma.activity.delete({ where: { id: activity.id } });
  });

  it("INVOICE_STATUS_CHANGED excludes the actor even from its one-to-many recipient set", async () => {
    const activity = await prisma.$transaction((tx) =>
      createActivity(tx, {
        organizationId: fixtures.orgA.id,
        actorId: fixtures.owner.id,
        entityType: "INVOICE",
        entityId: fixtures.invoice.id,
        action: "STATUS_CHANGED",
        metadata: buildInvoiceStatusChangedMetadata(
          { invoiceNumber: fixtures.invoice.invoiceNumber },
          "Test Project",
          "SENT",
          "PAID",
          fixtures.owner.name,
        ),
      }),
    );

    const notifications = await prisma.notification.findMany({ where: { activityId: activity.id } });
    expect(notifications.map((n) => n.recipientId)).toEqual([fixtures.admin.id]);

    await prisma.notification.deleteMany({ where: { activityId: activity.id } });
    await prisma.activity.delete({ where: { id: activity.id } });
  });

  it("a non-notifiable Activity (e.g. Client CREATED) creates 0 Notifications", async () => {
    const activity = await prisma.$transaction((tx) =>
      createActivity(tx, {
        organizationId: fixtures.orgA.id,
        actorId: fixtures.owner.id,
        entityType: "CLIENT",
        entityId: fixtures.clientA.id,
        action: "CREATED",
        metadata: { name: fixtures.clientA.name, status: "LEAD", actorName: fixtures.owner.name },
      }),
    );

    const notifications = await prisma.notification.findMany({ where: { activityId: activity.id } });
    expect(notifications).toHaveLength(0);

    await prisma.activity.delete({ where: { id: activity.id } });
  });

  it("recipient cascade: deleting a User deletes their Notification rows", async () => {
    const disposableUser = await prisma.user.create({
      data: { email: testEmail("notif-cascade", TEST_EMAIL_DOMAIN, fixtures.runId), name: "Disposable Cascade" },
    });
    const notification = await prisma.notification.create({
      data: {
        organizationId: fixtures.orgA.id,
        recipientId: disposableUser.id,
        activityId: fixtures.activity.id,
        type: "ROLE_CHANGED",
        metadata: {},
      },
    });

    await prisma.user.delete({ where: { id: disposableUser.id } });

    const stillThere = await prisma.notification.findUnique({ where: { id: notification.id } });
    expect(stillThere).toBeNull();
  });

  it("an artificially broken Notification insert rolls back the business mutation and the Activity row with it", async () => {
    const disposableUser = await prisma.user.create({
      data: { email: testEmail("notif-atomic", TEST_EMAIL_DOMAIN, fixtures.runId), name: "Disposable Atomic" },
    });
    const disposableMembership = await prisma.membership.create({
      data: { userId: disposableUser.id, organizationId: fixtures.orgA.id, role: Role.MEMBER },
    });

    await expect(
      prisma.$transaction(async (tx) => {
        // The business mutation this Activity would normally document.
        await tx.membership.update({ where: { id: disposableMembership.id }, data: { role: Role.ADMIN } });

        // A real Activity + a real, successfully-inserted Notification —
        // this is the "previously-created Notification row" the forced
        // failure below must also roll back.
        await createActivity(tx, {
          organizationId: fixtures.orgA.id,
          actorId: fixtures.owner.id,
          entityType: "MEMBERSHIP",
          entityId: disposableMembership.id,
          action: "ROLE_CHANGED",
          metadata: buildRoleChangedMetadata(disposableUser, "MEMBER", "ADMIN", fixtures.owner.name),
          notificationContext: { affectedUserId: disposableUser.id },
        });

        // Artificially break a second Notification insert on the same tx —
        // a well-formed but nonexistent recipientId is a real Postgres-level
        // foreign-key violation, not a client-side validation error,
        // exercising the actual rollback path a genuinely failing insert
        // would take.
        await tx.notification.create({
          data: {
            organizationId: fixtures.orgA.id,
            recipientId: randomUUID(),
            type: "ROLE_CHANGED",
            metadata: {},
          },
        });
      }),
    ).rejects.toThrow();

    // PGlite's single pooled connection (see src/lib/prisma.ts's max: 1
    // under PGLITE_TEST_DB) is left with a desynced response queue after an
    // interactive transaction aborts mid-way — every query issued on it
    // afterward silently receives the PREVIOUS query's result. Forcing a
    // fresh connection sidesteps that PGlite/pg-adapter quirk; it doesn't
    // affect what's being verified, since everything below reads
    // already-committed-or-rolled-back state from a clean connection.
    await prisma.$disconnect();

    const membershipAfter = await prisma.membership.findUniqueOrThrow({ where: { id: disposableMembership.id } });
    expect(membershipAfter.role).toBe(Role.MEMBER); // unchanged — mutation rolled back

    const activities = await prisma.activity.findMany({ where: { entityId: disposableMembership.id } });
    expect(activities).toHaveLength(0); // rolled back

    const notifications = await prisma.notification.findMany({ where: { recipientId: disposableUser.id } });
    expect(notifications).toHaveLength(0); // the earlier, successfully-inserted Notification rolled back too

    await prisma.membership.delete({ where: { id: disposableMembership.id } });
    await prisma.user.delete({ where: { id: disposableUser.id } });
  });
});
