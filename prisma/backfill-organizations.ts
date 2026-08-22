import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma, Role } from "../src/generated/prisma/client";

/**
 * Stage 3 multi-tenant backfill.
 *
 * For every existing User this script:
 *   1. Ensures a personal Organization + OWNER Membership exist.
 *   2. Fills organizationId on Client/Project (by direct ownership) and
 *      Task (via its Project's owner).
 *
 * Invoice.organizationId was previously backfilled here too (cross-checking
 * Project owner vs. Client owner), but that column is now a required,
 * schema-enforced field kept consistent with Invoice.project.organizationId
 * by every write path — see migration
 * 20260911090000_repair_invoice_organization_scope, which performed a
 * one-time, self-verifying repair of that column directly and made it
 * NOT NULL. There is nothing left for this script to do for Invoice.
 *
 * Idempotent: an existing OWNER Membership is reused (no duplicate
 * Organizations/Memberships), and every backfill query only ever touches
 * rows where organizationId IS NULL, so already-tagged rows are untouched.
 *
 * Usage:
 *   npx tsx prisma/backfill-organizations.ts            # dry run (default, no writes)
 *   npx tsx prisma/backfill-organizations.ts --apply     # perform the writes
 */

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

interface Counts {
  users: number;
  organizations: number;
  memberships: number;
  clientsNull: number;
  projectsNull: number;
  tasksNull: number;
}

function printCounts(counts: Counts) {
  console.log(`    Users:                ${counts.users}`);
  console.log(`    Organizations:        ${counts.organizations}`);
  console.log(`    Memberships:          ${counts.memberships}`);
  console.log(`    Client.organizationId    NULL: ${counts.clientsNull}`);
  console.log(`    Project.organizationId   NULL: ${counts.projectsNull}`);
  console.log(`    Task.organizationId      NULL: ${counts.tasksNull}`);
}

async function snapshotCounts(): Promise<Counts> {
  const [users, organizations, memberships, clientsNull, projectsNull, tasksNull] =
    await Promise.all([
      prisma.user.count(),
      prisma.organization.count(),
      prisma.membership.count(),
      prisma.client.count({ where: { organizationId: null } }),
      prisma.project.count({ where: { organizationId: null } }),
      prisma.task.count({ where: { organizationId: null } }),
    ]);
  return { users, organizations, memberships, clientsNull, projectsNull, tasksNull };
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-+|-+$)/g, "") || "org"
  );
}

function personalOrgSlugBase(user: { id: string; name: string; email: string }): string {
  const base = slugify(user.name) || slugify(user.email.split("@")[0]);
  // Suffix with a stable slice of the (immutable) user id so the base slug
  // doesn't need to be globally unique on its own — collisions still fall
  // back to uniqueSlug() below.
  return `${base}-${user.id.slice(0, 8)}`;
}

async function uniqueSlug(tx: Prisma.TransactionClient, base: string): Promise<string> {
  let candidate = base;
  let attempt = 1;
  // Extremely unlikely to loop given the id suffix, but stay correct if it does.
  while (await tx.organization.findUnique({ where: { slug: candidate }, select: { id: true } })) {
    attempt += 1;
    candidate = `${base}-${attempt}`;
  }
  return candidate;
}

async function ensureOrganizationForUser(
  user: { id: string; name: string; email: string },
  dryRun: boolean,
): Promise<{ organizationId: string; created: boolean }> {
  const existingOwnerMembership = await prisma.membership.findFirst({
    where: { userId: user.id, role: Role.OWNER },
    select: { organizationId: true },
  });

  if (existingOwnerMembership) {
    return { organizationId: existingOwnerMembership.organizationId, created: false };
  }

  if (dryRun) {
    // Nothing persisted; the id is only a placeholder for downstream dry-run counting.
    return { organizationId: `dry-run:${user.id}`, created: true };
  }

  return prisma.$transaction(async (tx) => {
    const slug = await uniqueSlug(tx, personalOrgSlugBase(user));
    const organization = await tx.organization.create({
      data: { name: `${user.name}'s Workspace`, slug },
    });
    await tx.membership.create({
      data: { userId: user.id, organizationId: organization.id, role: Role.OWNER },
    });
    return { organizationId: organization.id, created: true };
  });
}

async function backfillOwnedEntities(
  userId: string,
  organizationId: string,
  dryRun: boolean,
): Promise<{ clients: number; projects: number; tasks: number }> {
  const clientWhere = { userId, organizationId: null } as const;
  const projectWhere = { ownerId: userId, organizationId: null } as const;
  const taskWhere = { organizationId: null, project: { ownerId: userId } } as const;

  if (dryRun) {
    const [clients, projects, tasks] = await Promise.all([
      prisma.client.count({ where: clientWhere }),
      prisma.project.count({ where: projectWhere }),
      prisma.task.count({ where: taskWhere }),
    ]);
    return { clients, projects, tasks };
  }

  const [clients, projects, tasks] = await prisma.$transaction([
    prisma.client.updateMany({ where: clientWhere, data: { organizationId } }),
    prisma.project.updateMany({ where: projectWhere, data: { organizationId } }),
    prisma.task.updateMany({ where: taskWhere, data: { organizationId } }),
  ]);
  return { clients: clients.count, projects: projects.count, tasks: tasks.count };
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  console.log(`Mode: ${dryRun ? "DRY RUN (no writes will be made)" : "APPLY (writing changes)"}\n`);

  console.log("Before:");
  const before = await snapshotCounts();
  printCounts(before);

  const users = await prisma.user.findMany({ select: { id: true, name: true, email: true } });

  let organizationsCreated = 0;
  let membershipsCreated = 0;
  let clientsUpdated = 0;
  let projectsUpdated = 0;
  let tasksUpdated = 0;

  for (const user of users) {
    const { organizationId, created } = await ensureOrganizationForUser(user, dryRun);
    if (created) {
      organizationsCreated += 1;
      membershipsCreated += 1;
    }

    const owned = await backfillOwnedEntities(user.id, organizationId, dryRun);
    clientsUpdated += owned.clients;
    projectsUpdated += owned.projects;
    tasksUpdated += owned.tasks;
  }

  console.log("\nRun summary:");
  console.log(`  Users processed:        ${users.length}`);
  console.log(`  Organizations created:  ${organizationsCreated}`);
  console.log(`  Memberships created:    ${membershipsCreated}`);
  console.log(`  Clients updated:        ${clientsUpdated}`);
  console.log(`  Projects updated:       ${projectsUpdated}`);
  console.log(`  Tasks updated:          ${tasksUpdated}`);

  const after: Counts = dryRun
    ? {
        users: before.users,
        organizations: before.organizations + organizationsCreated,
        memberships: before.memberships + membershipsCreated,
        clientsNull: before.clientsNull - clientsUpdated,
        projectsNull: before.projectsNull - projectsUpdated,
        tasksNull: before.tasksNull - tasksUpdated,
      }
    : await snapshotCounts();

  console.log(`\n${dryRun ? "After (projected)" : "After"}:`);
  printCounts(after);

  if (dryRun) {
    console.log("\nDry run only — no changes were written. Re-run with --apply to persist changes.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
