import { ReactNode } from "react";
import { InboxIcon } from "@/components/ui/icons";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="mt-10 flex flex-col items-center justify-center rounded-lg border border-dashed border-gray-300 py-16 text-center">
      <InboxIcon className="h-10 w-10 text-gray-300" />
      <p className="mt-4 text-sm font-medium text-gray-900">{title}</p>
      <p className="mt-1 text-sm text-gray-500">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
