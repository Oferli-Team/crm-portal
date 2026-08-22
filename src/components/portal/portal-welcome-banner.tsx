"use client";

import Link from "next/link";
import { useState } from "react";

const HEADING_ID = "portal-welcome-heading";

/**
 * Client Portal welcome banner — Stage 4 (docs/onboarding-architecture.md
 * §17). An ordinary part of the /portal page, never a modal — the same
 * "inline, dismissible" stance the staff Dashboard onboarding card already
 * uses (src/components/onboarding/onboarding-card.tsx), but a genuinely
 * separate, thinner component: no staff onboarding table, no steps, no
 * progress, no Server Action at all. `eligible` is computed server-side by
 * the caller (portal-welcome-eligibility.ts, from the current PortalUser's
 * own `createdAt`) — this component only ever renders or doesn't, it never
 * resolves identity itself.
 *
 * Dismiss is deliberately NOT persisted (docs/onboarding-architecture.md
 * §17 left the choice between a persisted flag and a computed signal open;
 * this stage's own instructions default to zero-migration and explicitly
 * allow a non-persistent dismiss) — clicking "Got it" hides the banner for
 * the rest of this page instance only, via plain component state. No
 * network call, no cookie, no write of any kind. Returning to /portal
 * later (a reload, a new tab, a new day) shows it again as long as
 * `eligible` is still true — an accepted tradeoff of not adding a column
 * for this, not an oversight.
 */
export function PortalWelcomeBanner({
  eligible,
  returnFocusId,
}: {
  eligible: boolean;
  returnFocusId: string;
}) {
  const [dismissed, setDismissed] = useState(false);

  if (!eligible || dismissed) {
    return null;
  }

  function handleDismiss() {
    setDismissed(true);
    // The nearest meaningful landing point once this region is gone —
    // never left to fall back to <body>, the same "focus goes somewhere
    // deliberate" discipline NotificationBell's own close() already
    // follows for its popover.
    document.getElementById(returnFocusId)?.focus();
  }

  return (
    <section aria-labelledby={HEADING_ID} className="rounded-lg border border-gray-200 bg-white p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id={HEADING_ID} className="text-lg font-semibold tracking-tight text-gray-900">
            Welcome to your client portal
          </h2>
          <p className="mt-1 text-sm text-gray-600">Here you can:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-600">
            <li>View shared projects</li>
            <li>Review invoices</li>
            <li>Download files</li>
            <li>Manage your portal profile</li>
          </ul>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss welcome message"
          className="shrink-0 rounded text-sm font-medium text-gray-500 transition-colors hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
        >
          Got it
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href="/portal/projects"
          className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
        >
          View projects
        </Link>
        <Link
          href="/portal/invoices"
          className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
        >
          View invoices
        </Link>
      </div>
    </section>
  );
}
