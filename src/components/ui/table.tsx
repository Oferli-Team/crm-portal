import { ReactNode } from "react";

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        {children}
      </table>
    </div>
  );
}

export function TableHead({ children }: { children: ReactNode }) {
  return <thead className="bg-gray-50">{children}</thead>;
}

export function TableHeaderCell({
  children,
  align = "left",
  className = "",
}: {
  children: ReactNode;
  align?: "left" | "right";
  /**
   * Additive, optional — every existing call site across the app already
   * works unchanged. Exists so a page can hide a lower-priority column at
   * narrower breakpoints (e.g. `className="hidden md:table-cell"`) using
   * this same `<table>` markup at every viewport, rather than introducing
   * a second, parallel mobile-only component (see the Organization
   * Explorer list page for the first real usage).
   */
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`px-4 py-3 font-medium text-gray-500 ${
        align === "right" ? "text-right" : "text-left"
      } ${className}`}
    >
      {children}
    </th>
  );
}

export function TableBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-gray-200">{children}</tbody>;
}

export function TableRow({ children }: { children: ReactNode }) {
  return <tr className="transition-colors hover:bg-gray-50">{children}</tr>;
}

export function TableCell({
  children,
  align = "left",
  emphasis = false,
  className = "",
}: {
  children: ReactNode;
  align?: "left" | "right";
  emphasis?: boolean;
  /** Same additive, optional responsive-visibility escape hatch as TableHeaderCell's own — see its doc comment. Must match whichever cell(s) hide the corresponding TableHeaderCell, or a row's columns will misalign. */
  className?: string;
}) {
  return (
    <td
      className={`px-4 py-3 align-middle ${
        align === "right" ? "text-right" : "text-left"
      } ${emphasis ? "font-medium text-gray-900" : "text-gray-600"} ${className}`}
    >
      {children}
    </td>
  );
}
