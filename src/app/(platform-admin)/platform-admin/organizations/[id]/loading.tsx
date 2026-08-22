import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors settings/billing/loading.tsx's own multi-card shape — matches this page's real layout: header, then five stacked section cards. */
export default function OrganizationDetailLoading() {
  return (
    <div className="space-y-8">
      <div>
        <Skeleton className="h-4 w-28" />
        <Skeleton className="mt-3 h-7 w-56" />
        <Skeleton className="mt-2 h-4 w-32" />
      </div>

      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="rounded-lg border border-gray-200 bg-white p-6">
          <Skeleton className="h-5 w-40" />
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {Array.from({ length: 4 }, (_, j) => (
              <div key={j}>
                <Skeleton className="h-3 w-20" />
                <Skeleton className="mt-2 h-4 w-32" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
