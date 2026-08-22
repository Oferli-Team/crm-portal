import type { BillingNotice } from "@/lib/billing/view-model";

const TONE_STYLES: Record<BillingNotice["tone"], string> = {
  neutral: "border-gray-200 bg-gray-50 text-gray-700",
  info: "border-blue-200 bg-blue-50 text-blue-800",
  success: "border-green-200 bg-green-50 text-green-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  danger: "border-red-200 bg-red-50 text-red-800",
};

/**
 * Billing & Subscriptions Stage 3. Shared renderer for both the Current
 * Plan section's status notice and the page-level access-mode banner — one
 * tone->style map so "danger" always looks the same regardless of which
 * section produced it. Never color-only: warning/danger notices also get
 * role="alert"/aria-live="assertive" so a screen reader announces them
 * without the user needing to perceive color.
 */
export function NoticeBanner({ notice }: { notice: BillingNotice }) {
  const isUrgent = notice.tone === "danger" || notice.tone === "warning";

  return (
    <div
      role={isUrgent ? "alert" : "status"}
      aria-live={isUrgent ? "assertive" : "polite"}
      className={`rounded-md border px-4 py-3 text-sm ${TONE_STYLES[notice.tone]}`}
    >
      {notice.message}
    </div>
  );
}
