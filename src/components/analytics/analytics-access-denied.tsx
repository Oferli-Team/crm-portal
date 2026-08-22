/**
 * Analytics Stage 2. Rendered by the page itself (never `error.tsx` — see
 * that file and analytics/page.tsx's own doc comment for why) for a
 * MEMBER identity. Deliberately plain: no "contact your owner" CTA, no
 * mention of what's actually on the page — just enough to explain the
 * block without hinting at anything beyond the role names already
 * visible elsewhere in the app (e.g. the Team page).
 */
export function AnalyticsAccessDenied() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div
        role="alert"
        className="flex flex-col items-center justify-center rounded-lg border border-dashed border-gray-300 py-16 text-center"
      >
        <h1 className="text-lg font-semibold text-gray-900">Access denied</h1>
        <p className="mt-2 max-w-sm text-sm text-gray-600">
          Analytics is only available to organization owners and admins.
        </p>
      </div>
    </div>
  );
}
