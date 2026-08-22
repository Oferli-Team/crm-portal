import { EmptyState } from "@/components/ui/empty-state";

/**
 * Analytics Stage 2. Shown in place of the Overview grid only when an
 * organization genuinely has zero clients/projects/tasks/invoices/
 * attachments (a brand-new organization) — every other section (Growth,
 * Completion, Billing, Onboarding) still renders normally underneath,
 * since each of those already has its own well-defined zero/empty
 * rendering (a 0% completion rate, a "No prior data" growth indicator,
 * a real LEGACY/TRIAL plan label) rather than needing a second empty
 * state of its own.
 */
export function AnalyticsEmptyState() {
  return (
    <EmptyState
      title="No activity yet"
      description="Once you add clients, projects, or invoices, your organization's overview will appear here."
    />
  );
}
