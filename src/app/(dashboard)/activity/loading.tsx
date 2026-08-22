import { Skeleton } from "@/components/ui/skeleton";

// A timeline-shaped skeleton — the existing ListPageSkeleton is a table
// layout and doesn't fit this page's grouped-by-day list structure.
export default function ActivityLoading() {
  return (
    <div>
      <Skeleton className="h-7 w-32" />
      <Skeleton className="mt-2 h-4 w-64" />
      <Skeleton className="mt-1 h-3 w-96" />

      <div className="mt-6 h-24 rounded-lg border border-gray-200 bg-white" />

      <div className="mt-6 space-y-8">
        {Array.from({ length: 2 }).map((_, groupIndex) => (
          <div key={groupIndex}>
            <Skeleton className="h-4 w-40" />
            <div className="mt-2 overflow-hidden rounded-lg border border-gray-200 bg-white">
              {Array.from({ length: 4 }).map((_, rowIndex) => (
                <div key={rowIndex} className="border-b border-gray-100 p-4 last:border-0">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="mt-2 h-3 w-1/3" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
