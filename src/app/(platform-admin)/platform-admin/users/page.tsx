import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata: Metadata = {
  title: "Users — Platform Admin",
};

/**
 * Sale-Ready Phase C, PR1 (Foundation). Guard-only shell — the real
 * Staff Users / Portal Users lists ship in PR4.
 */
export default function PlatformAdminUsersPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Users</h1>
      <p className="mt-1 text-sm text-gray-600">
        Every staff and Client Portal user, and which organizations they belong to.
      </p>
      <EmptyState
        title="Not built yet"
        description="Users Explorer ships in a later PR (Sale-Ready Phase C, PR4)."
      />
    </div>
  );
}
