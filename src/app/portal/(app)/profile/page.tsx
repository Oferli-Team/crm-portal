import { getCurrentPortalUser } from "@/lib/current-portal-user";
import { getPortalClientAttachments } from "@/lib/client-portal/attachments";
import { PortalAttachmentsList } from "@/components/client-portal/portal-attachments-list";

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs font-medium tracking-wide text-gray-500 uppercase">{label}</dt>
      <dd className="mt-1 text-sm text-gray-900">{value}</dd>
    </div>
  );
}

// Read-only by design — a portal contact can never edit their own record
// or the Client's from here; there are no edit actions anywhere on this
// page. Uses only the identity data getCurrentPortalUser() already
// resolved, no separate Prisma query.
export default async function PortalProfilePage() {
  const { portalUser, client, clientId, organizationId } = await getCurrentPortalUser();
  const attachments = await getPortalClientAttachments(clientId, organizationId);

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Profile</h1>
        <p className="mt-1 text-sm text-gray-600">Your Client Portal account details.</p>
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-gray-900">Your details</h2>
        <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" value={portalUser.name} />
          <Field label="Email" value={portalUser.email} />
        </dl>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-gray-900">Client</h2>
        <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Client name" value={client.name} />
          <Field label="Company" value={client.company} />
          <Field label="Email" value={client.email} />
          <Field label="Phone" value={client.phone} />
        </dl>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-gray-900">Shared files</h2>
        <PortalAttachmentsList
          attachments={attachments}
          emptyDescription="Files your team shares with you will appear here."
        />
      </section>
    </div>
  );
}
