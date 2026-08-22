import Link from "next/link";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { prisma } from "@/lib/prisma";
import { InvoiceForm } from "@/components/invoices/invoice-form";
import { EmptyState } from "@/components/ui/empty-state";
import { getCompanyProfile } from "@/lib/organization-setup/company-profile";
import { resolveInvoiceCurrencyDefault, getSupportedInvoiceCurrencies } from "@/lib/invoices/currencies";
import { formatDateOnly } from "@/lib/invoices/date-only";
import { createInvoiceAction } from "./actions";

export default async function NewInvoicePage() {
  // Authentication resolved first, standalone — organizationId is never
  // referenced inside a Promise.all that is still awaiting this.
  const { organizationId } = await getCurrentUserOrganization();

  const [projects, companyProfile] = await Promise.all([
    prisma.project.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, client: { select: { name: true } } },
    }),
    getCompanyProfile(organizationId),
  ]);

  const currencyDefault = resolveInvoiceCurrencyDefault(companyProfile.currency);

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
          Add invoice
        </h1>
        <Link
          href="/invoices"
          className="rounded text-sm text-gray-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
        >
          Cancel
        </Link>
      </div>

      {projects.length === 0 ? (
        <EmptyState
          title="You need a project first"
          description="Invoices must belong to a project. Add one before creating an invoice."
          action={
            <Link
              href="/projects/new"
              className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
            >
              Add project
            </Link>
          }
        />
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <InvoiceForm
            action={createInvoiceAction}
            projects={projects.map((project) => ({
              id: project.id,
              label: `${project.name} — ${project.client.name}`,
            }))}
            currencyOptions={getSupportedInvoiceCurrencies()}
            currencyFallbackNotice={
              currencyDefault.isFallback && currencyDefault.organizationCurrency
                ? `Your organization's currency (${currencyDefault.organizationCurrency}) isn't supported for invoices — defaulted to USD.`
                : undefined
            }
            defaultValues={{
              mode: "flat",
              currency: currencyDefault.currency,
              issueDate: formatDateOnly(new Date()),
              discountType: "NONE",
              taxLabel: "TAX",
            }}
          />
        </div>
      )}
    </div>
  );
}
