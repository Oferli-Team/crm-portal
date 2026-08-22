import Link from "next/link";

/**
 * Scoped to this one route segment (Next.js's own nested not-found
 * mechanism — the same one src/app/not-found.tsx already uses at the
 * root, just one level deeper) rather than falling through to the root
 * 404: that page's "Go to dashboard" link and tenant-facing copy don't
 * fit a Platform Admin identity that has no personal organization
 * context to return to.
 */
export default function OrganizationNotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="text-sm font-medium text-gray-500">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-gray-900">Organization not found</h1>
      <p className="mt-2 max-w-sm text-sm text-gray-600">
        This organization doesn&apos;t exist, or its id is invalid.
      </p>
      <Link
        href="/platform-admin/organizations"
        className="mt-6 rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
      >
        Back to Organizations
      </Link>
    </div>
  );
}
