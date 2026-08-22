// Fields tracked for change-detection on Client Activity — deliberately a
// subset of the actual Client model. email/phone/company/notes/billing
// fields never leave this module's diff (only their *names*, when they
// change), and notes never appears here at all. Invoice System Slice 1
// (docs/invoicing-architecture.md §4.4) added the seven optional billing-
// identity fields below to this same names-only tracking — taxId/address
// values are exactly the kind of PII this module's own doc comment below
// already promises never to copy into Activity.metadata.
const CLIENT_TRACKED_FIELDS = [
  "name",
  "email",
  "phone",
  "company",
  "status",
  "billingLegalName",
  "taxId",
  "streetAddress",
  "city",
  "state",
  "postalCode",
  "country",
] as const;

type ClientTrackedSnapshot = {
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  status: string;
  billingLegalName: string | null;
  taxId: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
};

export type ClientActivityMetadata = {
  name: string;
  status: string;
  actorName: string;
  /** Only present on UPDATED — field names that changed, never their values. */
  changedFields?: string[];
};

/** Field names (never values) that differ between two Client snapshots. */
export function diffClientFields(
  before: ClientTrackedSnapshot,
  after: ClientTrackedSnapshot,
): string[] {
  return CLIENT_TRACKED_FIELDS.filter((field) => before[field] !== after[field]);
}

/**
 * The only fields ever written into Activity.metadata for a Client event —
 * name and status are already shown everywhere in the UI (list rows,
 * badges), so surfacing them here isn't a new exposure. email, phone,
 * company, and notes are intentionally never included.
 */
export function buildClientActivityMetadata(
  client: Pick<ClientTrackedSnapshot, "name" | "status">,
  actorName: string,
  changedFields?: string[],
): ClientActivityMetadata {
  return {
    name: client.name,
    status: client.status,
    actorName,
    ...(changedFields ? { changedFields } : {}),
  };
}
