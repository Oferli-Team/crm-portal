import { notFound } from "next/navigation";
import Link from "next/link";
import { getCurrentMembership } from "@/lib/current-user";
import { prisma } from "@/lib/prisma";
import { ClientForm } from "@/components/clients/client-form";
import { updateClientAction } from "./actions";
import { ClientAttachmentsSection } from "./attachments-section";
import { ClientPortalAccessSection } from "./portal-access-section";

export default async function EditClientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { organizationId, membership } = await getCurrentMembership();

  const client = await prisma.client.findFirst({
    where: { id, organizationId },
  });

  if (!client) {
    notFound();
  }

  const boundUpdateClientAction = updateClientAction.bind(null, client.id);

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
          Edit client
        </h1>
        <Link
          href="/clients"
          className="rounded text-sm text-gray-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
        >
          Cancel
        </Link>
      </div>
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <ClientForm
          action={boundUpdateClientAction}
          defaultValues={client}
          submitLabel="Save changes"
          pendingLabel="Saving…"
        />
        <ClientAttachmentsSection clientId={client.id} organizationId={organizationId} />
        <ClientPortalAccessSection clientId={client.id} role={membership.role} />
      </div>
    </div>
  );
}
