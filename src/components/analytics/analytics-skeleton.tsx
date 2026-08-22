import { Skeleton } from "@/components/ui/skeleton";

/** One section's worth of card skeletons — matches AnalyticsGrid's own 2/3/4-column responsive breakpoints. */
function SectionSkeleton({ cardCount }: { cardCount: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <Skeleton className="h-5 w-24" />
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: cardCount }, (_, i) => (
          <div key={i} className="rounded-lg border border-gray-200 p-4">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="mt-2 h-7 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Matches AnalyticsPage's real layout: header + range selector, then one skeleton per metric section — see analytics/loading.tsx. */
export function AnalyticsSkeleton() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Skeleton className="h-8 w-32" />
          <Skeleton className="mt-2 h-4 w-64" />
        </div>
        <div className="flex gap-1">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-20" />
          ))}
        </div>
      </div>

      <div className="mt-6 space-y-6">
        <SectionSkeleton cardCount={8} />
        <SectionSkeleton cardCount={3} />
        <SectionSkeleton cardCount={2} />
        <SectionSkeleton cardCount={3} />
        <SectionSkeleton cardCount={3} />
      </div>
    </div>
  );
}
