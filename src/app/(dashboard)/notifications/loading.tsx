import { Skeleton } from "@/components/ui/skeleton";

// A flat-list-shaped skeleton — tabs + a row of rows, unlike /activity's
// day-grouped timeline skeleton and unlike ListPageSkeleton's table columns.
export default function NotificationsLoading() {
  return (
    <div>
      <Skeleton className="h-7 w-40" />
      <Skeleton className="mt-2 h-4 w-72" />

      <div className="mt-6 flex items-center justify-between gap-3">
        <div className="flex gap-2">
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-8 w-24" />
        </div>
        <Skeleton className="h-8 w-32" />
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border border-gray-200 bg-white">
        {Array.from({ length: 6 }).map((_, rowIndex) => (
          <div key={rowIndex} className="border-b border-gray-100 p-4 last:border-0">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="mt-2 h-3 w-1/3" />
            <Skeleton className="mt-2 h-3 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
