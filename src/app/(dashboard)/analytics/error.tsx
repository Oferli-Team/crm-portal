"use client";

import { useEffect } from "react";

/**
 * Analytics Stage 2. Only ever reached for a genuine, unexpected failure
 * (a real "unavailable data" case — e.g. a database error) — the
 * "access denied" state is handled inline by page.tsx itself, before any
 * error would reach this boundary (see that file's own doc comment for
 * why). Mirrors src/app/(dashboard)/error.tsx's own shape.
 */
export default function AnalyticsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-gray-300 py-16 text-center">
        <h2 className="text-lg font-semibold text-gray-900">Analytics is unavailable right now</h2>
        <p className="mt-2 max-w-sm text-sm text-gray-600">We couldn&apos;t load your analytics data. Please try again.</p>
        <button
          type="button"
          onClick={() => reset()}
          className="mt-4 rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
