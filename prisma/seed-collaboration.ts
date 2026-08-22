import type { PrismaClient, Prisma } from "../src/generated/prisma/client";

function daysFromNow(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

/**
 * Sale-Ready Phase E, S1.1 (P1). Extracted alongside prisma/seed-
 * organization.ts for the same reason — a pure, parameterized function
 * (real PrismaClient passed in) that test/integration/seed/demo-
 * collaboration.test.ts can exercise directly against the real
 * PGlite-backed database, independent of prisma/seed.ts's own top-level
 * `main()` side effect.
 *
 * A small, coherent slice of collaboration activity tied directly to the
 * business story a caller supplies — not random test content: two
 * comments on the given project (one @-mentioning the given teammate,
 * using the same structured `@[Name](user:id)` token format the real
 * comment composer produces), and two Notification rows a demo viewer
 * would plausibly already have — one MENTIONED (matching the comment
 * above), one INVOICE_STATUS_CHANGED (matching the given invoice).
 * Deliberately does NOT attempt to replicate the full live dispatch
 * pipeline (createActivity/dispatchNotificationsForActivity) — these are
 * direct rows, the same "skip the Server Action, write the row" pattern
 * prisma/seed.ts already uses for every other table.
 *
 * Deliberately does NOT seed Attachment rows: every Attachment row is a
 * pointer to a real Supabase Storage object, and nothing in this project's
 * seed tooling performs a Storage upload — a seeded row with no real
 * object behind it would 404 or fail its signed-URL check the moment
 * someone opened it in a demo, which is worse than the section simply
 * being empty. Leaving attachments unseeded is a deliberate choice, not
 * an oversight — see this stage's own report.
 */
export async function seedCollaborationDemo(
  prisma: PrismaClient,
  params: {
    organizationId: string;
    ownerId: string;
    ownerName: string;
    memberId: string;
    memberName: string;
    projectId: string;
    invoiceId: string;
    invoiceNumber: string;
  },
): Promise<void> {
  const { organizationId, ownerId, ownerName, memberId, memberName, projectId, invoiceId, invoiceNumber } = params;

  const existing = await prisma.comment.count({ where: { organizationId } });
  if (existing > 0) {
    return;
  }

  const firstComment = await prisma.comment.create({
    data: {
      organizationId,
      authorId: ownerId,
      entityType: "PROJECT",
      entityId: projectId,
      body: `Client approved the homepage wireframes — let's move on to the blog template next. @[${memberName}](user:${memberId}) can you take a first pass this week?`,
      createdAt: daysFromNow(-2),
      updatedAt: daysFromNow(-2),
    },
  });

  await prisma.commentMention.create({
    data: { commentId: firstComment.id, userId: memberId },
  });

  await prisma.comment.create({
    data: {
      organizationId,
      authorId: memberId,
      entityType: "PROJECT",
      entityId: projectId,
      body: "On it — I'll have a draft ready for review by Thursday.",
      createdAt: daysFromNow(-1),
      updatedAt: daysFromNow(-1),
    },
  });

  await prisma.notification.create({
    data: {
      organizationId,
      recipientId: memberId,
      type: "MENTIONED",
      // Matches the real dispatch pipeline's own convention (dispatch-
      // notifications.ts copies Activity.entityType verbatim, and a
      // Comment's own Activity row is always ActivityEntityType.COMMENT —
      // never the parent Project/Task) — entityId is the Comment's own
      // id; the *parent* Project/Task lives only in metadata below.
      entityType: "COMMENT",
      entityId: firstComment.id,
      metadata: {
        actorName: ownerName,
        commentPreview: "Client approved the homepage wireframes — let's move on to the blog template next.",
        parentEntityType: "PROJECT",
        parentEntityId: projectId,
      } satisfies Prisma.InputJsonValue,
      createdAt: daysFromNow(-2),
    },
  });

  await prisma.notification.create({
    data: {
      organizationId,
      recipientId: ownerId,
      type: "INVOICE_STATUS_CHANGED",
      entityType: "INVOICE",
      entityId: invoiceId,
      metadata: {
        invoiceNumber,
        actorName: ownerName,
        from: "SENT",
        to: "PAID",
        projectName: "Mobile App MVP",
      } satisfies Prisma.InputJsonValue,
      createdAt: daysFromNow(-46),
    },
  });
}
