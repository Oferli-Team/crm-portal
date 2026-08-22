import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/enums";
import { inviteMemberAction, changeRoleAction, removeMemberAction } from "@/app/(dashboard)/team/actions";
import { inviteClientPortalUserAction } from "@/app/(dashboard)/clients/[id]/edit/portal-access-actions";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { testEmail } from "../../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../../support/env";

// Not a snapshot suite — every assertion checks a specific real field
// (action, entityType, actorId, and named metadata keys) against a real
// Activity row a real mutation actually wrote, never the whole object.

function inviteForm(email: string): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("role", "MEMBER");
  return fd;
}

describe("every mutation writes the correct Activity row", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(() => {
    resetAuthMock();
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("inviteMemberAction writes an INVITATION_SENT Activity with the right entityType/actor/metadata", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const email = testEmail("activity-invite", TEST_EMAIL_DOMAIN, fixtures.runId);

    await inviteMemberAction({ error: null }, inviteForm(email));

    const invitation = await prisma.invitation.findFirstOrThrow({ where: { email } });
    const activity = await prisma.activity.findFirstOrThrow({
      where: { entityId: invitation.id, action: "INVITATION_SENT" },
    });

    expect(activity.entityType).toBe("INVITATION");
    expect(activity.organizationId).toBe(fixtures.orgA.id);
    expect(activity.actorId).toBe(fixtures.owner.id);
    const metadata = activity.metadata as Record<string, unknown>;
    expect(metadata.email).toBe(email);
    expect(metadata.role).toBe("MEMBER");
    expect(metadata.actorName).toBe(fixtures.owner.name);

    await prisma.activity.deleteMany({ where: { entityId: invitation.id } });
    await prisma.invitation.delete({ where: { id: invitation.id } });
  });

  it("inviteClientPortalUserAction writes a PORTAL_INVITATION_SENT Activity", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const email = testEmail("activity-portal-invite", TEST_EMAIL_DOMAIN, fixtures.runId);
    const fd = new FormData();
    fd.set("email", email);

    await inviteClientPortalUserAction(fixtures.clientA.id, { error: null }, fd);

    const invitation = await prisma.clientInvitation.findFirstOrThrow({ where: { email } });
    const activity = await prisma.activity.findFirstOrThrow({
      where: { entityId: invitation.id, action: "PORTAL_INVITATION_SENT" },
    });

    expect(activity.entityType).toBe("PORTAL_USER");
    expect(activity.organizationId).toBe(fixtures.orgA.id);
    expect(activity.actorId).toBe(fixtures.owner.id);
    const metadata = activity.metadata as Record<string, unknown>;
    expect(metadata.email).toBe(email);
    expect(metadata.clientName).toBe(fixtures.clientA.name);

    await prisma.activity.deleteMany({ where: { entityId: invitation.id } });
    await prisma.clientInvitation.delete({ where: { id: invitation.id } });
  });

  it("changeRoleAction writes a ROLE_CHANGED Activity with from/to", async () => {
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { userId_organizationId: { userId: fixtures.member.id, organizationId: fixtures.orgA.id } },
    });
    actAs(fixtures.owner, fixtures.orgA.id);

    await changeRoleAction(membership.id, Role.ADMIN);

    const activity = await prisma.activity.findFirstOrThrow({
      where: { entityId: membership.id, action: "ROLE_CHANGED" },
    });
    expect(activity.entityType).toBe("MEMBERSHIP");
    expect(activity.actorId).toBe(fixtures.owner.id);
    const metadata = activity.metadata as Record<string, unknown>;
    expect(metadata.from).toBe("MEMBER");
    expect(metadata.to).toBe("ADMIN");

    // Restore fixture state for any later test relying on member being MEMBER.
    await prisma.membership.update({ where: { id: membership.id }, data: { role: Role.MEMBER } });
    await prisma.activity.deleteMany({ where: { entityId: membership.id } });
  });

  it("removeMemberAction writes a MEMBER_REMOVED Activity, then restores the fixture membership", async () => {
    // Use a disposable membership so we don't lose fixtures.member permanently.
    const disposableUser = await prisma.user.create({
      data: { email: testEmail("disposable-member", TEST_EMAIL_DOMAIN, fixtures.runId), name: "Disposable Member" },
    });
    const disposableMembership = await prisma.membership.create({
      data: { userId: disposableUser.id, organizationId: fixtures.orgA.id, role: Role.MEMBER },
    });
    actAs(fixtures.owner, fixtures.orgA.id);

    await removeMemberAction(disposableMembership.id);

    const activity = await prisma.activity.findFirstOrThrow({
      where: { entityId: disposableMembership.id, action: "MEMBER_REMOVED" },
    });
    expect(activity.entityType).toBe("MEMBERSHIP");
    expect(activity.actorId).toBe(fixtures.owner.id);
    const metadata = activity.metadata as Record<string, unknown>;
    expect(metadata.memberEmail).toBe(disposableUser.email);

    await prisma.activity.deleteMany({ where: { entityId: disposableMembership.id } });
    await prisma.user.delete({ where: { id: disposableUser.id } });
  });
});
