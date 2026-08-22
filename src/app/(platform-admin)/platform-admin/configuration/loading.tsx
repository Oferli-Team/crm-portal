import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the Organization Details loading skeleton — one card per DetailSection. Branding + Email + Billing + Domain + Legal + Deployment + Environment as of D6, the final Phase D section — this page's shape is now stable. */
export default function PlatformAdminConfigurationLoading() {
  return (
    <div className="space-y-8">
      <div>
        <Skeleton className="h-7 w-40" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>

      {Array.from({ length: 7 }, (_, sectionIndex) => (
        <div key={sectionIndex} className="rounded-lg border border-gray-200 bg-white p-6">
          <Skeleton className="h-5 w-40" />
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i}>
                <Skeleton className="h-3 w-24" />
                <Skeleton className="mt-2 h-4 w-36" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
