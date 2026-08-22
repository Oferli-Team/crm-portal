/**
 * Customer Setup Wizard (Stage 6.2). Rendered by the page itself (never
 * `error.tsx` — Next.js redacts Server Component error messages in
 * production before they'd reach a client error boundary; see
 * src/app/(dashboard)/analytics/page.tsx's own doc comment for the
 * identical reasoning) for a non-OWNER identity. Deliberately plain, and
 * deliberately does not name or preview any field on this page — payment
 * details are the one genuinely sensitive concern this stage adds.
 */
export function PaymentAccessDenied() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <div
        role="alert"
        className="flex flex-col items-center justify-center rounded-lg border border-dashed border-gray-300 py-16 text-center"
      >
        <h1 className="text-lg font-semibold text-gray-900">Access denied</h1>
        <p className="mt-2 max-w-sm text-sm text-gray-600">
          Payment details are only available to the organization owner.
        </p>
      </div>
    </div>
  );
}
