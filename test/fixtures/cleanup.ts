import { prisma } from "@/lib/prisma";
import { createClient } from "@supabase/supabase-js";
import { testStoragePrefix } from "../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../support/env";

const ATTACHMENTS_BUCKET = "attachments";

/**
 * Deletes every row this run created, plus its Storage objects and Supabase
 * Auth users — always call this in an `afterAll`/`finally`, even after a
 * failing test. Scopes strictly by runId (via the `-{runId}` slug suffix and
 * `-{runId}@{domain}` email suffix from test/support/run-id.ts) so it can
 * never touch a fixture from a different run or any non-test data.
 *
 * Deletes in FK-safe child-before-parent order rather than relying on the
 * schema's own cascades — a generic helper like this one should stay
 * correct even if a future migration changes an onDelete behavior.
 *
 * Storage/Auth admin operations use `@supabase/supabase-js` directly, not
 * this app's own `src/lib/storage/*`/`src/lib/email/*` modules — those are
 * guarded by `import "server-only"`, which throws outside Next's own build,
 * exactly like it does for any plain Node/Vitest process.
 */
export async function cleanupTestRun(runId: string): Promise<void> {
  const emailSuffix = `-${runId}@${TEST_EMAIL_DOMAIN}`;
  const slugSuffix = `-${runId}`;

  const users = await prisma.user.findMany({
    where: { email: { endsWith: emailSuffix } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);

  const organizations = await prisma.organization.findMany({
    where: { slug: { endsWith: slugSuffix } },
    select: { id: true },
  });
  const organizationIds = organizations.map((o) => o.id);

  const clients = await prisma.client.findMany({
    where: {
      OR: [
        { name: { endsWith: slugSuffix } },
        { organizationId: { in: organizationIds } },
        { userId: { in: userIds } },
      ],
    },
    select: { id: true },
  });
  const clientIds = clients.map((c) => c.id);

  const portalUsers = await prisma.portalUser.findMany({
    where: { email: { endsWith: emailSuffix } },
    select: { id: true },
  });
  const portalUserIds = portalUsers.map((p) => p.id);

  const projects = await prisma.project.findMany({
    where: { clientId: { in: clientIds } },
    select: { id: true },
  });
  const projectIds = projects.map((p) => p.id);

  // --- Storage objects (best-effort — DB rows are the source of truth). ---
  const attachments = await prisma.attachment.findMany({
    where: { organizationId: { in: organizationIds } },
    select: { storagePath: true },
  });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (attachments.length > 0 && supabaseUrl && serviceRoleKey) {
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await admin.storage.from(ATTACHMENTS_BUCKET).remove(attachments.map((a) => a.storagePath));
    // Belt-and-suspenders: also sweep the run's own storage prefix, in case
    // any object was created outside the normal Attachment-row flow.
    const prefixListing = await admin.storage.from(ATTACHMENTS_BUCKET).list(testStoragePrefix(runId));
    if (prefixListing.data && prefixListing.data.length > 0) {
      await admin.storage
        .from(ATTACHMENTS_BUCKET)
        .remove(prefixListing.data.map((f) => `${testStoragePrefix(runId)}/${f.name}`));
    }
  }

  // --- Supabase Auth users (best-effort, mirrors the DB User rows). ---
  if (supabaseUrl && serviceRoleKey) {
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    for (const id of [...userIds, ...portalUserIds]) {
      await admin.auth.admin.deleteUser(id).catch(() => undefined);
    }
  }

  // --- DB rows, child-before-parent. ---
  await prisma.attachment.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.activity.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.clientInvitation.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.task.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.invoice.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.project.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.invitation.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.portalUser.deleteMany({ where: { id: { in: portalUserIds } } });
  await prisma.membership.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}
