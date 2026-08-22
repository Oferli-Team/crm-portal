import type { BillingNotice } from "@/lib/billing/view-model";
import { NoticeBanner } from "./notice-banner";

/**
 * Page-level banner only — this stage's own §11 explicitly forbids any new
 * global middleware/blocker; FULL_ACCESS renders nothing (no alarming
 * banner for the common case), LIMITED_WRITES/READ_ONLY explain what's
 * affected without hiding any page or existing data.
 */
export function AccessModeBanner({ banner }: { banner: BillingNotice | null }) {
  if (!banner) return null;
  return <NoticeBanner notice={banner} />;
}
