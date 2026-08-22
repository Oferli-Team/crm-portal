export const PAGE_SIZE = 10;

export type SortDir = "asc" | "desc";

export type RawSearchParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export function parseSearchParam(value: string | string[] | undefined): string {
  return firstValue(value).trim();
}

export function parsePageParam(value: string | string[] | undefined): number {
  const n = Number(firstValue(value));
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export function parseEnumParam<T extends string>(
  value: string | string[] | undefined,
  allowed: readonly T[],
): T | undefined {
  const v = firstValue(value);
  return (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

/**
 * Sort params are encoded as a single "field:direction" value (e.g.
 * "createdAt:desc") so the whole sort choice is one <select>, not two.
 */
export function parseSortParam<T extends string>(
  value: string | string[] | undefined,
  allowedFields: readonly T[],
  fallback: `${T}:${SortDir}`,
): { field: T; dir: SortDir; combined: string } {
  const raw = firstValue(value) || fallback;
  const [fieldRaw, dirRaw] = raw.split(":");
  const fallbackField = fallback.split(":")[0] as T;
  const field = (allowedFields as readonly string[]).includes(fieldRaw)
    ? (fieldRaw as T)
    : fallbackField;
  const dir: SortDir = dirRaw === "asc" ? "asc" : "desc";
  return { field, dir, combined: `${field}:${dir}` };
}

export function getOffset(page: number): number {
  return (page - 1) * PAGE_SIZE;
}

export function getTotalPages(total: number): number {
  return Math.max(Math.ceil(total / PAGE_SIZE), 1);
}
