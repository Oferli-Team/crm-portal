import { Skeleton } from "@/components/ui/skeleton";

/** Matches BillingPage's real layout: heading, current-plan card, usage grid, plans grid — see this stage's own §12. */
export default function BillingLoading() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="mt-2 h-4 w-64" />

      <div className="mt-6 space-y-6">
        <div className="rounded-lg border border-gray-200 bg-white p-5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-2 h-5 w-24" />
          <Skeleton className="mt-4 h-12 w-full" />
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-5">
          <Skeleton className="h-5 w-24" />
          <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i}>
                <Skeleton className="h-4 w-24" />
                <Skeleton className="mt-2 h-2 w-full" />
              </div>
            ))}
          </div>
        </div>

        <div>
          <Skeleton className="h-5 w-16" />
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="h-48 w-full" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
