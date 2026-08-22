import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AutoSubmitSelect } from "@/components/list/auto-submit-select";

type SelectOption = { value: string; label: string };

export function SearchFilterBar({
  basePath,
  searchValue,
  searchPlaceholder,
  filters = [],
  sort,
  hasActiveParams = false,
}: {
  basePath: string;
  searchValue: string;
  searchPlaceholder: string;
  filters?: {
    name: string;
    label: string;
    value: string;
    options: SelectOption[];
  }[];
  sort?: {
    value: string;
    options: SelectOption[];
  };
  hasActiveParams?: boolean;
}) {
  return (
    <form
      method="GET"
      action={basePath}
      className="mt-6 flex flex-wrap items-end gap-4 rounded-lg border border-gray-200 bg-white p-4"
    >
      <div className="min-w-48 flex-1">
        <label htmlFor="q" className="block text-sm font-medium text-gray-700">
          Search
        </label>
        <Input
          id="q"
          name="q"
          type="search"
          defaultValue={searchValue}
          placeholder={searchPlaceholder}
        />
      </div>

      {filters.map((filter) => (
        <div key={filter.name} className="w-40">
          <label
            htmlFor={filter.name}
            className="block text-sm font-medium text-gray-700"
          >
            {filter.label}
          </label>
          <AutoSubmitSelect id={filter.name} name={filter.name} defaultValue={filter.value}>
            {filter.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </AutoSubmitSelect>
        </div>
      ))}

      {sort && (
        <div className="w-44">
          <label htmlFor="sort" className="block text-sm font-medium text-gray-700">
            Sort by
          </label>
          <AutoSubmitSelect id="sort" name="sort" defaultValue={sort.value}>
            {sort.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </AutoSubmitSelect>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit">Search</Button>
        {hasActiveParams && (
          <Link
            href={basePath}
            className="rounded text-sm text-gray-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
          >
            Clear
          </Link>
        )}
      </div>
    </form>
  );
}
