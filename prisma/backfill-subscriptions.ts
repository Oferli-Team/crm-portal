import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { LEGACY_PLAN_KEY } from "../src/lib/billing/plans";

/**
 * Billing & Subscriptions Stage 2 backfill — OPTIONAL and NOT run against
 * any shared/production database as part of this stage (see this stage's
 * own final report). Gives every pre-existing Organization (created
 * before this stage shipped, and therefore never auto-provisioned a trial
 * Subscription row — see src/lib/billing/provisioning.ts, wired into
 * getOrCreateOrganizationId in src/lib/current-user.ts) an explicit LEGACY
 * Subscription row, instead of relying indefinitely on
 * getOrganizationEntitlements()'s own "no row = legacy, full access"
 * fallback (src/lib/billing/access-mode.ts).
 *
 * LEGACY, never TRIAL: these organizations are already using the product
 * today with no limits ever having been enforced against them — starting
 * a 14-day trial clock for them would be a real, disruptive regression the
 * moment it expired, not a neutral default. LEGACY's own limits
 * (src/lib/billing/plans.ts) are a fixed, generous ceiling instead, and
 * its Subscription row uses status ACTIVE (which src/lib/billing/
 * access-mode.ts always maps to FULL_ACCESS unconditionally) — there is
 * no separate "LEGACY" SubscriptionStatus value; reusing ACTIVE is
 * deliberate, matching this stage's own instruction not to add an enum
 * value with no real state-machine use.
 *
 * Idempotent: only ever creates a Subscription row where none exists
 * (`WHERE subscription IS NULL`), batched in transactions, and re-running
 * it after a partial or full prior run only processes whatever is still
 * missing — every `upsert` below has an empty `update`, so it never
 * touches an existing Subscription row even if one somehow already exists
 * for an id in the "missing" batch by the time this runs (e.g. a
 * concurrent first-login auto-provisioned one in between the initial scan
 * and this batch's write).
 *
 * Never touches prisma/backfill-organizations.ts's own domain (creating
 * Organizations for pre-multi-tenant Users) — that script is unrelated,
 * already run, and untouched by this stage.
 *
 * Usage:
 *   npx tsx prisma/backfill-subscriptions.ts            # dry run (default, no writes)
 *   npx tsx prisma/backfill-subscriptions.ts --apply     # perform the writes
 */

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const BATCH_SIZE = 200;

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(
    apply
      ? "Running in APPLY mode — this will write to the database."
      : "Running in DRY RUN mode — no writes will be made. Pass --apply to write.",
  );

  const missing = await prisma.organization.findMany({
    where: { subscription: null },
    select: { id: true, name: true },
  });

  console.log(`Organizations without a Subscription row: ${missing.length}`);

  if (missing.length === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  if (!apply) {
    console.log(`Dry run: would create ${missing.length} LEGACY Subscription row(s). Re-run with --apply to write.`);
    return;
  }

  const now = new Date();
  let created = 0;

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    await prisma.$transaction(
      batch.map((org) =>
        prisma.subscription.upsert({
          where: { organizationId: org.id },
          update: {},
          create: {
            organizationId: org.id,
            planKey: LEGACY_PLAN_KEY,
            status: "ACTIVE",
            // Backdated to the backfill moment — irrelevant for LEGACY
            // rows, since ACTIVE status never consults trialStartedAt/
            // trialEndsAt (see src/lib/billing/access-mode.ts). Set only
            // to satisfy the NOT NULL columns without inventing a special
            // case for this one plan.
            trialStartedAt: now,
            trialEndsAt: now,
          },
        }),
      ),
    );
    created += batch.length;
    console.log(`  ...${created}/${missing.length}`);
  }

  console.log(`Backfill complete: ${created} LEGACY Subscription row(s) created.`);
}

main()
  .catch((err) => {
    console.error("BACKFILL_ERROR:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
