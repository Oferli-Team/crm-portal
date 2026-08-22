import Link from "next/link";
import { ClientForm } from "@/components/clients/client-form";
import { createClientAction } from "./actions";

export default function NewClientPage() {
  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Add client</h1>
        <Link href="/clients" className="text-sm text-gray-600 hover:underline">
          Cancel
        </Link>
      </div>
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <ClientForm action={createClientAction} />
      </div>
    </div>
  );
}
