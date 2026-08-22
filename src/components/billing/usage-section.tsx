import type { UsageRowViewModel } from "@/lib/billing/view-model";
import { UsageRow } from "./usage-row";

export function UsageSection({ rows }: { rows: UsageRowViewModel[] }) {
  return (
    <section aria-labelledby="billing-usage-heading" className="rounded-lg border border-gray-200 bg-white p-5">
      <h2 id="billing-usage-heading" className="text-base font-semibold text-gray-900">
        Usage
      </h2>
      <div className="mt-4 grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
        {rows.map((row) => (
          <UsageRow key={row.key} row={row} />
        ))}
      </div>
    </section>
  );
}
