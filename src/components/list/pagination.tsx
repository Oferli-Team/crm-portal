import Link from "next/link";

function buildHref(
  basePath: string,
  params: Record<string, string>,
  page: number,
): string {
  const usp = new URLSearchParams(params);
  usp.set("page", String(page));
  return `${basePath}?${usp.toString()}`;
}

const NAV_BUTTON_CLASS =
  "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2";

export function Pagination({
  basePath,
  params,
  page,
  totalPages,
}: {
  basePath: string;
  params: Record<string, string>;
  page: number;
  totalPages: number;
}) {
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  return (
    <nav
      aria-label="Pagination"
      className="mt-4 flex items-center justify-between text-sm text-gray-600"
    >
      <p>
        Page {page} of {totalPages}
      </p>
      <div className="flex items-center gap-2">
        {hasPrev ? (
          <Link
            href={buildHref(basePath, params, page - 1)}
            className={`${NAV_BUTTON_CLASS} border-gray-300 text-gray-700 hover:bg-gray-50`}
          >
            Previous
          </Link>
        ) : (
          <span
            aria-disabled="true"
            className={`${NAV_BUTTON_CLASS} cursor-not-allowed border-gray-200 text-gray-300`}
          >
            Previous
          </span>
        )}
        {hasNext ? (
          <Link
            href={buildHref(basePath, params, page + 1)}
            className={`${NAV_BUTTON_CLASS} border-gray-300 text-gray-700 hover:bg-gray-50`}
          >
            Next
          </Link>
        ) : (
          <span
            aria-disabled="true"
            className={`${NAV_BUTTON_CLASS} cursor-not-allowed border-gray-200 text-gray-300`}
          >
            Next
          </span>
        )}
      </div>
    </nav>
  );
}
