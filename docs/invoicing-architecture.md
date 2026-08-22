# Invoice System — Architecture (Approved Target Design)

**This document describes APPROVED TARGET BEHAVIOR, not already-implemented
behavior**, except where a section is explicitly labeled **CURRENT STATE**.
Every schema field, model, query, pipeline step, and UI behavior described
outside a CURRENT STATE section is **TARGET / UNIMPLEMENTED** as of this
document's publication — no schema change, migration, application code,
dependency, test, PDF, email, or lifecycle behavior described here exists on
`main` yet. This is the sole deliverable of Slice 0; every later slice
(§14) builds on the decisions recorded here, and none of them should start
without this document being read and agreed on first. Historical framing:
the TARGET / UNIMPLEMENTED language below records this document's original
Slice 0 design state and is not a current implementation-status claim; for
authoritative current implementation status, see §1 and §14.

Grounded in a full read of current `main` source (`prisma/schema.prisma`,
every `src/app/(dashboard)/invoices/**` and `src/app/portal/(app)/invoices/**`
file, `src/lib/client-portal/queries.ts`, `src/lib/validation/invoice.ts`,
`src/lib/activity/invoice-metadata.ts`, `src/lib/search/search-invoices.ts`,
`src/lib/email/resend-client.ts`, `src/lib/storage/attachments-storage.ts`,
`src/lib/organization-setup/{company-profile,payment-details}.ts`,
`src/lib/rate-limit/limits.ts`, `scripts/security-checks/*.mjs`), the original
Invoice System investigation, its corrected design report, and the final
product decisions recorded in this document's own §2–§4. PR #63 (merged as
`41452bd7391700f1b73063b4a8e16864d0e3de84`) — the `Invoice.organizationId`
prerequisite repair — is reflected as CURRENT STATE throughout; it shipped
before this document and is not part of the target design it describes.

---

## 0. How to read this document

- **CURRENT STATE** (§1) — what exists on `main` today, verified directly
  against source. Never aspirational.
- **APPROVED TARGET DESIGN** (§3–§13) — the agreed shape of the finished
  feature. Nothing in these sections is built yet unless a sentence says so
  explicitly (e.g. "already the case today").
- **IMPLEMENTATION SLICES** (§14) — the dependency-ordered plan for turning
  target design into shipped code, one small reviewable PR at a time.
- **EXPLICIT NON-GOALS** (§2.2) — scoped out of v1 deliberately, not
  overlooked.
- **EXTERNAL VERIFICATION GATES** (§15) — facts this document could not
  verify from inside this repository (a third-party API's real limits, a
  not-yet-installed dependency's real behavior) that a later slice must
  confirm before relying on them, rather than freezing a guess into the
  architecture as fact.

---

## 1. CURRENT STATE

### 1.1 Schema

`Invoice` (`prisma/schema.prisma`) is a **flat-amount** model — no line
items, no discount, no tax, no PDF, no email history:

```prisma
model Invoice {
  id            String        @id @default(uuid()) @db.Uuid
  invoiceNumber String
  status        InvoiceStatus @default(DRAFT)
  amount        Decimal       @db.Decimal(10, 2)
  currency      String        @default("USD")
  notes         String?
  issueDate     DateTime      @default(now())
  dueDate       DateTime?
  paidAt        DateTime?
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt

  clientId String @db.Uuid
  client   Client @relation(fields: [clientId], references: [id], onDelete: Restrict)
  projectId String  @db.Uuid
  project   Project @relation(fields: [projectId], references: [id], onDelete: Restrict)

  organizationId String       @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)

  @@unique([clientId, invoiceNumber])
  @@index([status]) @@index([dueDate]) @@index([projectId]) @@index([organizationId])
}

enum InvoiceStatus { DRAFT SENT PAID OVERDUE CANCELLED }
```

`amount` is `Decimal(10,2)` — max representable value **99,999,999.99**
(10 total digits, 2 after the decimal point). `currency` defaults `"USD"`,
free text, **never exposed or editable in the staff UI** — no form field
reads or writes it. `issueDate` defaults to `now()` at creation and is
**never touched again by any UI** — there is no issue-date input anywhere.

### 1.2 Create / edit / delete / status behavior

- **Create** (`src/app/(dashboard)/invoices/new/actions.ts`): staff pick a
  Project (`clientId` is always server-derived from it, never a form
  field); status may be set to **any** value directly at creation — no
  restriction to `DRAFT`. `paidAt` is stamped at create time only if
  `status === "PAID"`.
- **Edit** (`src/app/(dashboard)/invoices/[id]/edit/actions.ts`): **every
  field is editable in every status today**, including `PAID`/`CANCELLED`
  — there is no immutability concept anywhere in the current
  implementation. Changing the Project is allowed (re-verified server-side
  against the caller's org); `clientId` is re-derived from the new Project.
- **`paidAt` — the exact 4-case rule the target design must preserve**:
  not‑PAID→PAID stamps a fresh `paidAt`; PAID→not‑PAID clears it to
  `null`; PAID→PAID and not‑PAID→not‑PAID are both explicit no-ops (the
  key is omitted from the update, not overwritten with the same value).
- **`OVERDUE` is manual-only** — no code anywhere compares `dueDate` to
  `now()` to auto-derive it; the dashboard query's own comment states this
  explicitly ("a real OVERDUE status, not a re-derived `dueDate < now`
  check").
- **Delete** (`src/app/(dashboard)/invoices/actions.ts`): any invoice can
  be deleted regardless of status today — no `DRAFT`-only restriction
  exists.
- **No separate detail/view page exists** —
  `src/app/(dashboard)/invoices/[id]/edit/page.tsx` is the *only* per-invoice
  route; list rows link straight to `/edit`, which doubles as both view
  and edit for every status.
- **Activity**: `CREATED`/`UPDATED`/`STATUS_CHANGED`/`DELETED` — only
  `STATUS_CHANGED` fans out to a `Notification`
  (`NotificationType.INVOICE_STATUS_CHANGED`). No invoice-specific
  `ActivityAction` exists (no `SENT`/`ARCHIVED`-style value) — everything
  uses these four generic actions. A pure resubmit of identical values
  creates zero Activity rows.
- **Validation** (`src/lib/validation/invoice.ts`): `invoiceNumber`,
  `projectId` required; `amount` kept as a **raw string** end to end
  (never converted to a JS float for storage — only `Number(amountRaw)`
  for the `>0`/`NaN` check); `status`, `dueDate`, `notes` optional/validated.
  No `currency`/`issueDate` field is parsed at all.

### 1.3 Portal — the DRAFT visibility problem (RESOLVED, Slice 5a/PR #89)

**Status: resolved.** At the time this section was originally written,
`src/lib/client-portal/queries.ts`'s `OPEN_INVOICE_STATUSES` **still
included `"DRAFT"`**:
```ts
const OPEN_INVOICE_STATUSES: readonly InvoiceStatus[] = ["DRAFT", "SENT", "OVERDUE"];
```
with three real, then-currently-live leak points:

1. `getPortalInvoice(clientId, organizationId, invoiceId)` — **no status
   filter at all**; a DRAFT invoice's full detail page was reachable by
   anyone who could reach/guess its id.
2. `getPortalInvoices(clientId, organizationId, filter)` — the `"all"`
   filter (the default tab, no `?status=`) applied no status filter; the
   `"open"` filter included `DRAFT` via `OPEN_INVOICE_STATUSES`.
3. `getPortalOverview(clientId, organizationId)` — `recentInvoices`
   (no status filter) and `openInvoicesAgg` (via `OPEN_INVOICE_STATUSES`,
   folding a DRAFT's amount into the portal's `outstandingAmount` KPI).

**All three were fixed exactly as §10 specifies, by official Slice 5a
(PR #89):** a new `VISIBLE_PORTAL_STATUSES` (`SENT`/`OVERDUE`/`PAID`/
`CANCELLED`) is now applied to `getPortalInvoice`/`getPortalInvoices`/
`getPortalOverview`, and `OPEN_INVOICE_STATUSES` no longer includes
`DRAFT`. A `DRAFT` invoice is genuinely unreachable through any Portal
surface today (proven at the E2E layer, not merely absent from a list).
The historical description above is preserved for provenance; §10 below
is the target design this fix now matches exactly.

### 1.4 Absent today

No `InvoiceLineItem`, no discount/tax fields, no PDF generation of any
kind, no send-by-email flow, no `InvoiceEmailAttempt`/delivery-history
model, no `internalNotes`, no finalization/immutability concept, no Client
billing-address/tax-ID fields. Zero PDF-capable dependency exists in
`package.json` (production or dev). The `resend` npm SDK is **not**
installed — `src/lib/email/resend-client.ts` sends via a raw
`fetch(...)` POST to `https://api.resend.com/emails`.

### 1.5 Existing infrastructure this design reuses (already built, already correct)

- **Attachments** (`src/lib/storage/attachments-storage.ts`,
  `attachments-config.ts`): private `attachments` Supabase Storage bucket;
  `AttachmentEntityType` already includes `INVOICE`; `application/pdf` is
  already in the upload allowlist; `buildAttachmentStoragePath()` produces
  an immutable, UUID-validated path
  (`organizations/<orgId>/<entityType>/<entityId>/<attachmentId>/<file>`);
  `uploadAttachmentObject()` hardcodes `upsert: false` with an explicit
  "a collision here is always a bug" comment; uploads (not just downloads)
  are fully intercepted under `TEST_MODE` via an in-memory store, no real
  Storage call.
- **Attachment download route pattern**
  (`src/app/api/{,portal/}attachments/[id]/download/route.ts`): auth
  resolve → rate limit → scoped `findFirst` → `createAttachmentSignedUrl()`
  (60s TTL, clamped) → `307` redirect. Never streams/proxies bytes.
- **Business identity** (`src/lib/organization-setup/company-profile.ts`,
  `getCompanyProfile(organizationId)`): `legalName`, `country`, `currency`,
  `timezone`, `supportEmail`, `website`, `phone`, `taxId`, `brandColor`,
  `streetAddress`/`city`/`state`/`postalCode`, `logoUrl` — one row per
  Organization, **lazily created, may not exist**, read-only for any
  member (no role gate). The schema's own comment on `legalName`
  anticipates this exact use ("e.g. for future invoice/contract copy").
- **Payment details** (`src/lib/organization-setup/payment-details.ts`,
  `getPaymentDetails(organizationId)`): `bankName`, `accountHolder`,
  `accountNumber`, `swiftBic`, `paymentInstructions?` — one row per
  Organization, **may not exist**, OWNER-write-gated, read-unrestricted.
- **Email** (`src/lib/email/resend-client.ts`):
  ```ts
  export type SendEmailInput = { to: string; from: string; subject: string; html: string; text: string };
  export type SendEmailResult = { ok: true } | { ok: false; reason: "not_configured" | "provider_error" | "network_error" };
  export async function sendEmailViaResend(input: SendEmailInput): Promise<SendEmailResult>
  ```
  `TEST_MODE` short-circuits to `{ok:true}` before any `fetch`. The
  response body is **never parsed today** (only `response.ok` is
  checked) — capturing a provider message id (§9) is a real, additive
  extension.
- **Actor/audit-FK convention** — established, repeated verbatim 4× in the
  schema (`Task.assigneeId`, `Activity.actorId`, `Attachment.uploadedById`,
  `Comment.authorId`): `User?` + `onDelete: SetNull`, "no action deletes a
  User today, but this shouldn't vanish or block the delete just because
  of who did the action — stays as an actor-less historical row." This is
  the exact precedent `InvoiceEmailAttempt.requestedByUserId` follows
  (§4.3).
- **Currency validation precedent**
  (`src/lib/validation/company-profile.ts:31`):
  `const VALID_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));`
  — a complete, real, already-proven-in-this-codebase ISO-4217-equivalent
  allowlist, reused (duplicated per this codebase's own stated
  per-module-copy convention) for `Invoice.currency` (§6).
- **Rate limits** (`src/lib/rate-limit/limits.ts`): `attachment-download`
  120/hr per staff user, `portal-attachment-download` 120/hr per portal
  user — the shape new `invoice-pdf-download`/`portal-invoice-pdf-download`
  limits should mirror.

### 1.6 PR #63 — the `Invoice.organizationId` repair (merged, on `main`)

- `Invoice.organizationId` is now **required** (`String @db.Uuid`),
  `onDelete: Restrict` (was nullable/`SetNull`).
- Every real create/update path (`new/actions.ts`, `[id]/edit/actions.ts`)
  now writes it, re-derived from the same already-verified `Project` on
  every write — never trusted from form input.
- Every Invoice read path uses `organizationId` as the primary tenant
  predicate, with `project: { organizationId }` (and, for Search,
  `client: { organizationId }`) retained as defense in depth.
- The three Analytics paths that previously silently undercounted
  (`organization-metrics.ts` `totalInvoices`, `completion-metrics.ts`,
  `time-series.ts`'s Invoice activity series) needed **no code change** —
  they already queried the column directly and became correct once the
  data/schema were repaired.
- Migration `20260911090000_repair_invoice_organization_scope` exists in
  source control on `main` (guarded, self-verifying, and **deliberately
  contains no explicit top-level `BEGIN`/`COMMIT`**). Atomic rollback on
  failure was reproduced by hand against **this repository's exact
  toolchain** — Prisma 7.9.1, applied via a real `prisma migrate deploy`
  subprocess against a PGlite-backed Postgres instance — not against any
  other Prisma version, real Postgres server, or deployment environment;
  the migration file's own header comment documents that specific
  reproduction. This is evidence for *this* migration in *this*
  toolchain, not a general claim that every Prisma/PostgreSQL/deployment
  combination behaves identically. A real deployment against any actual
  target database remains a separate, controlled operator step (§1.6,
  §12) that should confirm this behavior in that environment rather than
  assume it.
- **This migration has not been applied to any external/staging/production
  database by the PR #63 merge task** — merging into source control and
  deploying to a real database are separate, deliberately un-conflated
  steps (§12.5 restates this). This remains an accurate description of
  what the PR #63 merge task itself did. **Operational status recorded in
  this 2026-08-18 documentation refresh:** this migration — along with
  `20260910090000` (introduced by PR #60, predating this one),
  `20260912090000` (PR #65), and `20260913090000` (PR #73) — had each
  been merged into source control as application code without its own
  migration ever being operationally applied to the real database. On
  2026-08-17, after PR #73 merged, the production database was discovered
  to be exactly these four migrations behind, causing a real, confirmed
  production incident (`P2022` failures on `/dashboard`/`/clients`) —
  PR #73's merge is what surfaced the drift as a live incident, not what
  caused the drift itself. This was diagnosed and resolved that same day
  through a controlled backup/`prisma migrate deploy`/status/schema-
  verification operator sequence — **all 26 repository migrations,
  including this one, are now confirmed applied to the one verified
  production database** (no claim is made about staging or any other
  environment). See `GPT_PROJECT_CONTEXT.md`'s "Production migration
  incident and resolution" for the full account.
- Portal DRAFT visibility (§1.3) was explicitly **out of scope** for PR
  #63 — it was fixed later, by official Slice 5a (PR #89); see §1.3.

---

## 2. APPROVED V1 PRODUCT SCOPE

### 2.1 In scope

Itemized **and** legacy flat invoices (unified, not two code paths);
optional Client billing identity; deterministic `Decimal`-based
calculations; one invoice-level discount (percentage or fixed); one
exclusive invoice-level tax; an explicit issue/finalization lifecycle;
an immutable archived PDF; authenticated staff and portal downloads;
email with the archived PDF attached; email-attempt history with real
idempotency; corrected portal visibility; a cancel-and-duplicate
correction flow; full unit/integration/E2E coverage.

### 2.2 EXPLICIT NON-GOALS

Paddle/payment collection on invoices; automatic tax compliance/a tax
jurisdiction engine; inclusive tax or multiple tax components; credit
notes; recurring/subscription invoices; automatic `OVERDUE` derivation
from `dueDate`; public unauthenticated invoice links; a PDF re-archive
UI (the `documentVersion` field is reserved for a future, rare,
operator-only maintenance action — not built in v1); multiple currencies
inside one invoice; invoice-download analytics (no new
`PortalDownloadRequest`-style persistence — that model is explicitly
Attachment-only per its own security-check allowlist); any
accounting-ledger/general-ledger behavior (this is an invoicing tool, not
a bookkeeping system).

---

## 3. APPROVED TARGET DESIGN — Lifecycle Contract

### 3.1 Transition matrix

| From ＼ To | DRAFT | SENT (*"Issued"*) | PAID | OVERDUE | CANCELLED |
|---|---|---|---|---|---|
| **DRAFT** | — | ✅ finalizes (§8) | ❌ | ❌ | ❌ forbidden |
| **SENT** | ❌ | — (resend) | ✅ | ✅ | ✅ |
| **OVERDUE** | ❌ | ✅ (undo) | ✅ | — | ✅ |
| **PAID** | ❌ | ✅ (undo mistaken PAID) | — | ❌ forbidden | ❌ forbidden |
| **CANCELLED** | ❌ | ❌ | ❌ | ❌ | — (terminal) |

- **Creation is `DRAFT` only.** Direct creation in any other status is
  forbidden (a change from CURRENT STATE §1.2, which allows any status at
  creation).
- **`DRAFT → CANCELLED` is forbidden** — abandoning a draft that was never
  issued is a plain delete, not a cancellation of a real document.
- **A `DRAFT` may be deleted.** A non-`DRAFT` invoice may **never** be
  deleted — every finalized invoice is a permanent historical record.
- **`PAID → OVERDUE`/`CANCELLED` directly is forbidden** — correcting a
  mistaken `PAID` mark must go through `SENT`/Issued first (an explicit,
  single "undo" step, not a silent multi-hop transition).
- **`CANCELLED` is terminal.**
- **`paidAt`** preserves the exact CURRENT STATE §1.2 four-case rule on
  every transition where it applies (stamped fresh on `→PAID`, cleared on
  `PAID→`, untouched otherwise) — unchanged by finalization/immutability.
- **`OVERDUE` remains manually controlled** — no auto-derivation from
  `dueDate`, unchanged from CURRENT STATE §1.2 (a possible future,
  separate, out-of-scope slice).
- **The `InvoiceStatus` enum value stays `SENT`** — zero schema/migration
  churn for a label change. The **UI label is "Issued."** **"Issued" means
  the invoice has been finalized, assigned an immutable archived document
  (§8), and made available for controlled delivery/access** — it does
  **not** claim the document was transmitted or delivered to the client.
  Email provider acceptance and actual delivery are separate,
  independently-tracked facts (§9) — an email-free Issue action (a manual
  status change, or an Issue with no email ever attempted) is a fully
  valid way to reach `SENT`, and "Issued" remains accurate for it without
  implying anything about transmission.

### 3.2 Corrections after issue

**Cancel + Duplicate-as-new-DRAFT** is the only correction mechanism in
v1 — credit notes are explicitly out of scope (§2.2). Staff cancel the
`SENT`/`PAID`/`OVERDUE` invoice, then use an explicit "Duplicate" action
that pre-fills a fresh `DRAFT` (new id, all financial fields editable
again) from the cancelled invoice's content. **The duplicate's
`invoiceNumber` is pre-filled with a suggestion** (the original number
plus a `-R1` revision suffix) **but is never silently auto-submitted** —
staff must explicitly confirm or edit it before the duplicate can be
saved (this is also the safety net for the invoice-numbering-uniqueness
migration in §4.5/§12).

### 3.3 What freezes at finalization

Every field visible on the archived PDF, and nothing that isn't:

- `invoiceNumber`, `currency`, `issueDate`, `dueDate`
- `projectId`/`clientId` (the project/client reference)
- every `InvoiceLineItem` (description, quantity, unitPrice, lineTotal,
  position/order)
- `discountType`/`discountValue`/`taxRatePercent`/`taxLabel`
- `subtotal`/`discountAmount`/`taxAmount`/`amount` (the totals)
- `notes` (client-visible)
- `issuerSnapshot`/`recipientSnapshot` (§7)

**`internalNotes` is staff-only** — never rendered to the PDF, never
emailed, never shown to a portal identity — and **remains editable in
every status**, including after finalization. This is the escape hatch
for ongoing internal commentary without violating document immutability.

---

## 4. APPROVED TARGET DESIGN — Data Model (TARGET / UNIMPLEMENTED)

Every schema fragment below is a **proposal**, not applied to
`prisma/schema.prisma`. No migration file is included in this document
(§12 covers the migration *strategy*, not its SQL).

### 4.1 `Invoice` additions

```prisma
model Invoice {
  // ...existing fields unchanged (id, invoiceNumber, status, amount,
  //     currency, notes, issueDate, dueDate, paidAt, createdAt, updatedAt,
  //     clientId, client, projectId, project, organizationId, organization)...

  internalNotes String?   // staff-only, never rendered to client/PDF/email, always editable

  discountType   InvoiceDiscountType @default(NONE)
  discountValue  Decimal?            @db.Decimal(10, 2)
  taxRatePercent Decimal?            @db.Decimal(5, 2)
  taxLabel       InvoiceTaxLabel     @default(TAX)

  subtotal       Decimal @db.Decimal(10, 2) @default(0)  // IMPLEMENTED — Slice 5b/PR #90, migration 20260915090000; NOT NULL/default-0 shown here is the live schema, not a future target
  discountAmount Decimal @db.Decimal(10, 2) @default(0)  // IMPLEMENTED — Slice 5b/PR #90, same migration
  taxAmount      Decimal @db.Decimal(10, 2) @default(0)  // IMPLEMENTED — Slice 5b/PR #90, same migration
  // amount (existing column, unchanged meaning) = subtotal - discountAmount + taxAmount
  // — remains the sole canonical total every Dashboard/Analytics/Search/Portal query reads.
  // Deferred, expand-phase state (Slice 1 through Slice 5a): these three
  // columns were nullable, with no database default, so an old app
  // version mid-rolling-deploy could still insert a row before the
  // dual-write path existed everywhere. Slice 5b's own migration verified
  // (count-only guard, no backfill) that every row already had a real
  // value before applying this NOT NULL/DEFAULT 0 contract.

  finalizedAt        DateTime?  // set exactly once, by the successful DRAFT -> SENT archive/finalization commit (§8.1) — never by any other transition, never before the PDF archive exists
  issuerSnapshot      Json?     // { schemaVersion: 1, ... } — §7, written in the same transaction as finalizedAt
  recipientSnapshot   Json?     // { schemaVersion: 1, ... } — §7, written in the same transaction as finalizedAt

  pdfStoragePath  String?   @unique   // e.g. organizations/<orgId>/invoice-pdf/<invoiceId>/<documentVersion>/<archiveId>/invoice.pdf
  pdfGeneratedAt  DateTime?
  documentVersion Int       @default(1)  // reserved for a future re-archive action; not used in v1

  lineItems     InvoiceLineItem[]
  emailAttempts InvoiceEmailAttempt[]

  @@unique([organizationId, invoiceNumber])  // IMPLEMENTED — Slice 5c/PR #91, migration 20260916090000, applied and verified in production; see §4.5/§12 for the migration design from [clientId, invoiceNumber]
}

enum InvoiceDiscountType { NONE PERCENTAGE FIXED }
enum InvoiceTaxLabel { TAX VAT GST }
```

No separate "calculation/itemization discriminator" column is needed to
distinguish flat invoices from itemized ones — **`lineItems.length === 0`
is itself that discriminator.** The calculation service (§5) accepts
either a `lineItems` array or a flat `amount` as its subtotal source
through one unified contract, so no extra schema flag is needed for that
axis. `lineItems.length === 0` alone does **not**, however, distinguish a
*pre-feature legacy* invoice from a *new, deliberately flat* one — §4.6
defines the exact rule for that.

### 4.2 `InvoiceLineItem`

```prisma
model InvoiceLineItem {
  id        String  @id @default(uuid()) @db.Uuid
  invoiceId String  @db.Uuid
  invoice   Invoice @relation(fields: [invoiceId], references: [id], onDelete: Cascade)

  description String
  quantity    Decimal @db.Decimal(10, 3)   // strictly > 0
  unitPrice   Decimal @db.Decimal(10, 2)   // >= 0 (zero is a legal "comped" line)
  lineTotal   Decimal @db.Decimal(10, 2)   // server-derived, re-persisted on every DRAFT save
  position    Int                          // server-assigned, contiguous 0..n-1 on every save

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([invoiceId, position])
}
```

**Positions are always server-assigned and contiguous** — on every DRAFT
save, the Server Action re-numbers `position = 0, 1, 2, ...` from the
*submitted array order*, never trusting a client-supplied position
integer. The entire line-item set is replaced atomically on every save
(delete-all + re-create inside the same transaction as the parent
`Invoice` update) rather than diffed/patched by id — this both satisfies
the `@@unique([invoiceId, position])` constraint by construction (no
gaps, no duplicates, ever) and structurally prevents any "attach another
invoice's line item" risk, since no line item is ever referenced or moved
by id from client input.

### 4.3 `InvoiceEmailAttempt`

```prisma
model InvoiceEmailAttempt {
  id        String  @id @default(uuid()) @db.Uuid
  invoiceId String  @db.Uuid
  invoice   Invoice @relation(fields: [invoiceId], references: [id], onDelete: Cascade)

  recipientEmail String                       // snapshot of Client.email at THIS attempt's moment, not read live later
  status         InvoiceEmailAttemptStatus @default(PENDING)   // PENDING | ACCEPTED | FAILED | UNKNOWN

  idempotencyKey    String  @unique            // one stable UUID per Send/Resend UI operation — §9.2
  providerMessageId String?                    // Resend's opaque id — diagnostics only, never logged
  failureReason     String?                    // fixed, sanitized category only — never a raw provider error

  requestedByUserId String? @db.Uuid           // nullable — matches the established actor/audit-FK convention (§1.5)
  requestedByUser   User?   @relation(fields: [requestedByUserId], references: [id], onDelete: SetNull)

  attemptedAt        DateTime  @default(now())  // created/attempted timestamp — set once, never rewritten
  updatedAt          DateTime  @updatedAt        // bumped on every state change (PENDING -> ACCEPTED/FAILED/UNKNOWN) — audits *when* a transition happened, not just the current status
  providerAcceptedAt DateTime?                   // set ONLY on a transition to ACCEPTED — NOT a delivery timestamp, provider acceptance only, see §9.1. Never set for FAILED/UNKNOWN.

  @@index([invoiceId, attemptedAt])
  @@index([invoiceId, status, attemptedAt])   // supports the stale-PENDING/UNKNOWN recovery query, §9.2
}
enum InvoiceEmailAttemptStatus { PENDING ACCEPTED FAILED UNKNOWN }
```

Named `InvoiceEmailAttempt`, not `...Delivery` — a successful Resend API
response proves the provider *accepted* the send, never that the message
was actually *delivered* (§9.1). A separate raw-SQL Postgres **partial
unique index** enforces "at most one `PENDING` attempt per invoice" —
not expressible in Prisma's schema DSL directly:
```sql
CREATE UNIQUE INDEX "invoice_email_attempt_one_pending"
  ON "InvoiceEmailAttempt" ("invoiceId")
  WHERE status = 'PENDING';
```

### 4.4 `Client` optional billing fields

```prisma
model Client {
  // ...existing fields unchanged (name, email?, phone?, company?, ...)...
  billingLegalName String?   // fallback order: billingLegalName ?? company ?? name
  taxId            String?
  streetAddress    String?   // matches OrganizationProfile's own exact field naming
  city             String?
  state            String?
  postalCode       String?
  country          String?
}
```

All optional, all nullable — **never block existing Client creation**.
`company` (existing field) already serves as the billing company name;
`billingLegalName` exists only for the rarer case where a formal legal
invoicing name differs from the informal CRM display name/company
(e.g. "Acme" vs. "Acme Corporation, LLC"). Address field naming
deliberately matches `OrganizationProfile`'s own exact convention
(`streetAddress`/`city`/`state`/`postalCode`), not a new `addressLine1/2`
scheme. Validation length caps should match whatever cap convention
`OrganizationProfile`'s equivalent fields already use. Every existing
`Client` row has these fields `null` by default — **no backfill is
possible or attempted** (there is no source-of-truth data to backfill
from); the PDF "Bill To" block simply omits address/tax-ID lines when
absent, exactly like `OrganizationPaymentDetails` being entirely absent
is already handled gracefully today.

### 4.5 Invoice numbering — target and migration risk

**Target: `@@unique([organizationId, invoiceNumber])`** — the conventional
issuer-level numbering invariant. **Status: implemented (Slice 5c, PR
#91).** Migration `20260916090000_invoice_number_unique_per_organization`
replaced `@@unique([clientId, invoiceNumber])` with this target exactly,
preserving case-sensitive comparison. The migration was gated on a real
production **collision preflight** (§12.4/§12.5) run immediately before
deploy: all three blocking conditions (duplicate `(organizationId,
invoiceNumber)` groups, blank/whitespace numbers, Invoice/Project/Client
ownership inconsistency) returned zero — no collision was found, so no
rename decision was ever required. The migration itself never renames or
repairs — it aborts loudly on any blocking condition, count-only, exactly
as designed below. The historical fallback plan described in the rest of
this section (preserving `[clientId, invoiceNumber]` if a preflight could
not be confidently run) was not needed. **Residual limitation:**
`Invoice.organizationId`/Client ownership consistency is maintained by
the two Invoice writers and this migration's own one-time guard, not by
a permanent composite FK/CHECK constraint — see migration
`20260916090000_invoice_number_unique_per_organization`'s own header
comment for the full reasoning; not duplicated here.

### 4.6 Flat vs. legacy vs. newly-issued classification

No new discriminator field is added merely to label legacy data — the
existing durable state (`finalizedAt`, `pdfStoragePath`, `status`,
`lineItems.length`) is sufficient to classify every invoice exactly:

| Classification | Definition |
|---|---|
| **Flat invoice** | Zero persisted `InvoiceLineItem` rows (`lineItems.length === 0`) — regardless of when it was created. A brand-new `DRAFT` created deliberately flat is fully supported and, when issued through the Slice 3 pipeline, receives the **same** immutable archive as an itemized invoice. |
| **Itemized invoice** | One or more persisted `InvoiceLineItem` rows. |
| **Legacy unarchived historical invoice** | `status != DRAFT` **and** `finalizedAt IS NULL` **and** `pdfStoragePath IS NULL` — a real invoice created before this finalization system existed, predating `finalizedAt`'s introduction entirely. Eligible for the §8.3 read-only best-effort preview and the explicit "Archive Legacy Invoice" action. |
| **Newly-issued invoice** | `finalizedAt` non-null **and** `pdfStoragePath` non-null — both are written together, in the same DB transaction, by the Slice 3 archive pipeline (§8.1 step 5); there is no code path that sets one without the other. |
| **Invariant-violation / recovery state** | `finalizedAt` non-null **with** `pdfStoragePath IS NULL`. Given the pipeline design above, this should be **structurally unreachable** in normal operation — but classification logic must check for it defensively and treat any observed occurrence as an **error requiring staff attention**, never as "legacy" (a row with `finalizedAt` set was never a pre-feature row — legacy rows have `finalizedAt` permanently `NULL` by construction) and never eligible for a live-preview fallback (§8.1/§8.3). |

This table is what §8.3's legacy-preview logic and §8.2's download routes
check against — never `createdAt`, which the durable state above already
makes unnecessary for this purpose.

---

## 5. APPROVED TARGET DESIGN — Calculation Contract

One centralized, pure calculation function — no I/O, no Prisma import
beyond the `Decimal` type itself:

```ts
// src/lib/invoices/calculations.ts (TARGET — not yet created)
import { Prisma } from "@/generated/prisma/client";
// Prisma.Decimal — the stable, already-in-use public import for this
// generator's output (confirmed live in src/lib/current-user.ts today).
// Never import from the internal @prisma/client/runtime/library path.

type DecimalInput = Prisma.Decimal | string | number;

type SubtotalSource =
  | { mode: "lineItems"; lineItems: { description: string; quantity: DecimalInput; unitPrice: DecimalInput }[] }
  | { mode: "flat"; amount: DecimalInput };   // legacy / non-itemized invoices

type DiscountInput =
  | { type: "NONE" }
  | { type: "PERCENTAGE"; value: DecimalInput }  // 0-100
  | { type: "FIXED"; value: DecimalInput };      // >= 0, must not exceed subtotal

type InvoiceCalculationInput = {
  subtotalSource: SubtotalSource;
  discount: DiscountInput;
  taxRatePercent: DecimalInput | null;  // null = no tax; 0-100
};

type InvoiceCalculationResult =
  | { ok: true; lineItems: { description: string; quantity: Prisma.Decimal; unitPrice: Prisma.Decimal; lineTotal: Prisma.Decimal }[];
      subtotal: Prisma.Decimal; discountAmount: Prisma.Decimal; taxAmount: Prisma.Decimal; total: Prisma.Decimal }
  | { ok: false; error:
      | { code: "EMPTY_LINE_ITEMS" } | { code: "TOO_MANY_LINE_ITEMS" }
      | { code: "ZERO_OR_NEGATIVE_QUANTITY"; index: number } | { code: "NEGATIVE_UNIT_PRICE"; index: number }
      | { code: "EMPTY_DESCRIPTION"; index: number } | { code: "DESCRIPTION_TOO_LONG"; index: number }
      | { code: "DISCOUNT_PERCENTAGE_OUT_OF_RANGE" } | { code: "DISCOUNT_EXCEEDS_SUBTOTAL" }
      | { code: "TAX_RATE_OUT_OF_RANGE" } | { code: "TOTAL_OUT_OF_RANGE" } };

function calculateInvoiceTotals(input: InvoiceCalculationInput): InvoiceCalculationResult
```

**Rules:**
- Never JS floating point for money — `Prisma.Decimal` end to end, `Number()`
  only at the final display boundary.
- `Decimal(10,2)` maximum representable value: **99,999,999.99**
  (10⁸ − 0.01). Every one of `subtotal`/`discountAmount`/`taxAmount`/`total`
  is checked against this ceiling before returning `ok:true` →
  `TOTAL_OUT_OF_RANGE` otherwise, preventing a confusing Postgres-level
  failure from surfacing instead of a clean validation error.
- `quantity`: `Decimal(10,3)`, strictly `> 0` (zero/negative rejected — a
  zero-quantity line is never a real business case).
- `unitPrice`: `Decimal(10,2)`, `>= 0` (zero legal — a visible, itemized
  "comped" line; negative rejected).
- `lineTotal = round(quantity × unitPrice, 2, ROUND_HALF_UP)` —
  **per-line rounding**, not deferred: `value.toDecimalPlaces(2,
  Prisma.Decimal.ROUND_HALF_UP)`. Each line's rounded total is what's
  printed on the PDF row and must match what's summed.
- `subtotal` = sum of the already-rounded, persisted `lineTotal`s (or the
  flat `amount` for a legacy/non-itemized invoice).
- Discount computed on `subtotal`: `PERCENTAGE` →
  `round(subtotal × value/100, 2)`; `FIXED` → `value`, **rejected**
  (`DISCOUNT_EXCEEDS_SUBTOTAL`) if it would exceed `subtotal` — never
  silently clamped.
- **Tax is exclusive, computed after discount**:
  `taxAmount = round((subtotal − discountAmount) × taxRatePercent/100, 2)`,
  `0` if `taxRatePercent` is `null`.
- Discount % and tax % both clamp-validated to `[0, 100]`.
- `total = subtotal − discountAmount + taxAmount`. **Zero total is
  legal** (a fully comped invoice). Negative total is never legal
  (defense-in-depth check, though unreachable given the discount bound).
- Line-item count capped at **200**; `description` trimmed and capped at
  **500 characters**; an empty/whitespace-only description is rejected
  (`EMPTY_DESCRIPTION`), never silently dropped or defaulted.
- **The server always recomputes every total on write and discards any
  client-submitted total** — a client-computed preview may be shown
  instantly in the UI (importing this same pure function directly, no
  network round-trip), but it is never trusted as the value to persist.
- One currency per invoice — line items carry no currency of their own;
  mixing is structurally impossible, not merely validated against.

**Worked examples:**
1. **Normal**: "Design work" qty=10.5hrs @ $85.00 → `$892.50`; "Hosting"
   qty=1 @ $29.99 → `$29.99`. `subtotal = $922.49`. 10% discount →
   `$92.25`. Post-discount `$830.24`. 8.25% tax → `$68.49`. **`total =
   $898.73`**.
2. **Rounding edge (`ROUND_HALF_UP`)**: subtotal `$67.00`, no discount,
   tax `1.5%` → raw tax `= 67.00 × 0.015 = 1.005` exactly → rounds to
   **`$1.01`**, not `$1.00`. `total = $68.01`.
3. **Zero total (legal)**: subtotal `$50.00`, `FIXED` discount `$50.00`
   (equals subtotal, allowed) → `discountAmount = $50.00`, no tax →
   **`total = $0.00`**.
4. **Rejected**: `FIXED` discount `$60.00` on subtotal `$50.00` →
   `DISCOUNT_EXCEEDS_SUBTOTAL`, no total computed.

---

## 6. APPROVED TARGET DESIGN — Currency Contract

Deliberately bounded v1 — **not** universal currency support:

- **Only currencies whose ISO/Intl minor-unit precision is exactly two
  decimal places** are supported for invoice creation. Built from
  `Intl.supportedValuesOf("currency")` (the exact technique already proven
  in `src/lib/validation/company-profile.ts:31` — duplicated per-module,
  matching this codebase's own stated convention) filtered by
  `Intl.NumberFormat(locale, {style:"currency", currency}).resolvedOptions().maximumFractionDigits === 2`.
  **Never** "any 3 uppercase letters."
- **JPY-style zero-decimal and BHD-style three-decimal currencies are out
  of scope for invoice creation in v1** — a real, disclosed, bounded
  limitation (not a silent error): this app's `Decimal(10,2)` money
  columns structurally assume 2 decimal places everywhere.
- **Default**: if `OrganizationProfile.currency` exists and is in the
  supported two-decimal set, it's the new-invoice default. **If it is
  unsupported** (unset, or a 0/3-decimal currency), the form defaults to
  `USD` **with an explicit UI notice** asking the user to choose a
  supported invoice currency — never silently implying the org's own
  currency was used when it wasn't.
- A `DRAFT` invoice **may override** the default (a real, occasional
  need — an org that mostly bills in one currency might invoice a
  specific client differently).
- **Frozen at finalization** (§3.3), like every other PDF-visible field.
- **Display** uses the existing `formatCurrency()`'s `Intl.NumberFormat`
  call — already correct per-currency today, no change needed there.
- Line items carry no currency of their own (§5) — mixing is structurally
  impossible.

---

## 7. APPROVED TARGET DESIGN — Snapshot Contract

**Snapshots must be versioned and validated before use — JSON is not
trusted merely because it came from the database.** `issuerSnapshot`/
`recipientSnapshot` are populated exactly once, **by the same successful
`DRAFT → SENT` archive/finalization transaction that writes
`pdfStoragePath`** (§8.1 step 5 — never earlier, never by any other
transition), read *only* for a non-`DRAFT` invoice's archival render
(§8) — a `DRAFT`'s PDF preview always reads live current data, since
nothing has been promised to a client yet.

**Issuer snapshot** (`{schemaVersion: 1, ...}`, from `OrganizationProfile`
+ `OrganizationPaymentDetails` at that same commit): legal/business
name, address fields, country, tax ID, support email/phone/website where
available, payment receiving details/instructions, brand color if used
in the PDF, and a **source logo reference kept for provenance only** —
the reference does not, by itself, guarantee the logo *image* is
reproducible later (see below).

**Recipient snapshot** (`{schemaVersion: 1, ...}`, from `Client` at that
same commit): resolved billing name = `billingLegalName ?? company ??
name`, email, optional billing address, country, tax ID.

- **Render code parses a versioned, typed shape** — never treats stored
  JSON as trustworthy just because a database wrote it. **An unknown
  `schemaVersion` fails safely** (a clear error, never a best-effort
  guess at rendering unfamiliar fields).
- **The archived PDF itself — not `logoUrl`/template regeneration — is
  the legal visual artifact.** Snapshotting `logoUrl` as a string does
  *not* preserve the logo image if the org later replaces it (nothing in
  this codebase's logo-upload path was found to guarantee an immutable,
  versioned URL the way Attachments do) — and even with a frozen data
  snapshot, a future PDF-template code change would render old data
  through a new template, producing a different document than what was
  actually sent. This is exactly why §8 selects "store the rendered PDF"
  over "regenerate on demand" as the archival mechanism: the snapshot
  protects the *data* that goes into the render; the **stored PDF file**
  is what protects the *rendered result* against both a changed logo and
  a changed template.
- **Secrets, `internalNotes`, and raw provider data never enter a
  snapshot** — only the specific fields enumerated above.

---

## 8. APPROVED TARGET DESIGN — Immutable PDF Archival

**Recommendation: `@react-pdf/renderer`** (one new dependency — zero
PDF-capable package exists today). No Chromium binary, fully
deterministic (no headless-browser timing/flakiness), text nodes render
literally (no HTML-injection surface unlike an HTML-to-PDF approach).
**Dependency/version compatibility with this repo's exact Next.js 16 /
React 19 / Node runtime is an EXTERNAL VERIFICATION GATE for Slice 3
(§15)** — not assumed compatible without checking at implementation time.

### 8.1 Finalization pipeline (`DRAFT → SENT`)

Never holds a DB transaction open across render/upload/network I/O:

1. **Authorize and lock/re-read** the target `DRAFT` invoice
   (organization-scoped).
2. **Validate** its current version/state (still `DRAFT`, not concurrently
   modified) and **build versioned snapshots** (§7) from live
   `OrganizationProfile`/`OrganizationPaymentDetails`/`Client` data.
3. **Render PDF bytes** from that exact immutable input (snapshots +
   `InvoiceLineItem`s + totals) — no further I/O once rendering starts.
4. **Upload** with `upsert: false` to a new, unique, immutable private
   Storage path — `organizations/<orgId>/invoice-pdf/<invoiceId>/<documentVersion>/<archiveId>/invoice.pdf`,
   including a fresh unique archive id so a retry after a partial failure
   can never collide with a prior attempt's path.
5. **In a DB transaction**, re-check status/version is still consistent,
   persist `issuerSnapshot`/`recipientSnapshot`/`pdfStoragePath`/
   `pdfGeneratedAt`, and change `DRAFT → SENT` (`finalizedAt` stamped) —
   this is the single authoritative "the document is finalized" commit,
   matching this codebase's existing precedent (the invitation-email
   pattern: the core DB fact commits regardless of a downstream
   side-effect's outcome).
6. **If the DB commit fails after upload succeeded**, perform a
   compensating Storage deletion of the just-uploaded object.
7. **If that cleanup also fails**, record/report only a fixed, sanitized
   orphan-cleanup condition (never raw error detail, never the Storage
   path itself). The unique archive id from step 4 guarantees this
   specific orphan can never block a future retry — but the object itself
   **remains in Storage, unreferenced, until reconciled** (§8.5); "never
   blocks a retry" is not the same claim as "never needs cleanup."
8. **Only after finalization commits** may email sending begin (§9) — a
   separate, later, independently-retriable step.

For every newly-finalized invoice, **`pdfStoragePath` must exist by the
time `status` becomes `SENT`** — a finalized invoice with a missing
`pdfStoragePath` is an **error/recovery state**, never eligible for a
live-render fallback (see §8.3).

### 8.2 Authenticated downloads

`GET /api/invoices/[id]/pdf` (staff) and `GET /api/portal/invoices/[id]/pdf`
(portal) — mirroring the existing attachment-download route pattern
(§1.5) exactly:
- **Staff**: `getCurrentUserOrganization()` → rate limit → scoped
  `findFirst` (organization-scoped, `project:{organizationId}` defense in
  depth).
- **Portal**: `getCurrentPortalUser()` → rate limit → scoped `findFirst`
  (`organizationId` + `clientId` + `project.clientId`). **A `DRAFT`
  invoice is never available to the portal route** (§10 makes this a
  hard rule for every portal surface, not just PDF).
- **Authorization happens before signed URL generation** — the scoped
  `findFirst` above must succeed before any signed URL is ever requested.
- If `pdfStoragePath` is set: issue a **short-lived signed URL** to that
  stored object and return it as this route's **entire response: a `307`
  redirect (`Location` header only)** — no rendering happens on this GET
  request at all, and **the `307` response itself has no PDF body and no
  `Content-Type: application/pdf`** (a redirect's own response is never
  falsely claimed to be the PDF's body content-type — that header belongs
  to the *stored object's* own metadata, set once at upload time in §8.1,
  and/or to Supabase's own signed-URL response once the client follows
  the redirect, not to this route's `307`). Where applicable, this
  route's own `307` response carries a `Cache-Control: private, no-store`
  policy so the redirect itself is never cached.
- A **safe download filename**
  (`Invoice-<sanitized-invoiceNumber>.pdf`) is requested via Supabase's
  own existing signed-download mechanism/options at signed-URL-generation
  time (the same `download` option the codebase's storage helpers already
  support) — never bolted onto the `307` response as a header.
- **GET is strictly read-only** — no snapshot write, no Storage write, no
  status change, ever, on any GET request, for any invoice in any state.
  **The portal must never receive a mutable, live-regenerated PDF as a
  fallback** for a finalized invoice missing its archive — that's the
  error/recovery state from §8.1, surfaced to staff for remediation, not
  silently papered over for the client.

**Operational status (recorded in the 2026-08-18 documentation refresh
after PR #77, merged as
`b6113c17de78d9d6a86b0911f7a4bac3c8d29ab1`): both halves of this
section are now implemented exactly as designed above.** The staff half
shipped first (sub-PR 3c/PR #75, merged as
`12ce09274de7192ecebd24f0818a9752a8f0dcb0`) — `GET /api/invoices/[id]/pdf`
ships with `getCurrentUserOrganization()` authorization (no additional
role gate — every Membership role may download), a dedicated
`INVOICE_PDF_DOWNLOAD_LIMIT` rate limiter checked before any
Invoice-domain query, `classifyInvoiceArchival()` as the eligibility
gate, an added ledger-consistency proof against `InvoicePdfArchiveObject`
before ever signing (not originally spelled out in this section's own
text, an implementation-time hardening not a design deviation), the
`307`/`Cache-Control: private, no-store`/safe-filename contract exactly
as specified, and strict read-only behavior. **The portal half —
`GET /api/portal/invoices/[id]/pdf` — then shipped in PR #77**, reusing
the staff route's `classifyInvoiceArchival()` classifier, ledger-
consistency proof, canonical-path rebuild, and `createInvoicePdfSignedUrl()`
signing helper unchanged; its own additions are `getCurrentPortalUser()`
authorization, a dedicated isolated `PORTAL_INVOICE_PDF_DOWNLOAD_LIMIT`
rate limiter (120/hour per portal user id, in-memory/per-instance like
every other limiter in this codebase), and a Portal-scoped Invoice
lookup keyed by `clientId`, `organizationId`, and `project: { clientId }`
— **`project.organizationId` is deliberately not a predicate**, since
`Project.organizationId` is nullable (`onDelete: SetNull`) and requiring
it could silently deny a legitimate request on relation drift. The
route deliberately never calls `recordPortalDownloadRequest()` — the
existing Portal Analytics "Download-link requests" metric (see
`docs/analytics-architecture.md`) remains scoped to Attachment downloads
only and is not redefined by this route. Legacy Archive (§8.3) is now
implemented (PR #79, merged as
`9f8a802b0bcf07535706d7dfe1a8733913021d8e`) — see §8.3's own operational
status note below. **Orphan reconciliation (§8.5) is now implemented and
activated too (PR #82/PR #83) — see §8.5's own operational status note
below.** With this, official Invoice System Slice 3 has no remaining
piece.

### 8.3 Legacy invoices

Uses §4.6's exact classification, never `createdAt`:

- Remaining a **flat invoice** (zero `InvoiceLineItem` rows, §4.6) is a
  **permanent, valid, first-class state** — never "pending migration" —
  regardless of whether it's a pre-feature record or a brand-new,
  deliberately flat `DRAFT`.
- The PDF view model renders a **single synthetic "Services" row** from
  the flat `amount` for a flat invoice — **only in the in-memory view
  model that feeds the renderer, never as a persisted `InvoiceLineItem`
  database row.**
- A **legacy unarchived historical invoice** (§4.6's exact predicate:
  `status != DRAFT` **and** `finalizedAt IS NULL` **and**
  `pdfStoragePath IS NULL`) may render a **clearly-labeled, read-only
  best-effort preview** on GET — explicitly disclosed in the UI as
  non-archival and reflecting *currently available* data (live
  `OrganizationProfile`/`Client`, since no snapshot exists for a
  pre-feature invoice). **This preview must be visually/textually
  distinguishable from a genuinely archived download**, and — critically
  — a row failing §4.6's **invariant-violation** check
  (`finalizedAt` set, `pdfStoragePath` null) must **never** be classified
  as legacy and must **never** receive this live-preview fallback: that
  combination can only mean a newly-issued invoice whose archive failed
  to write, which is a bug requiring staff attention, not a benign
  historical record. The portal-facing copy/UI must not conflate the two.
- A separate, explicit **staff "Archive Legacy Invoice" `POST` action**
  lets staff opt a legacy invoice into the same snapshot+archival
  pipeline retroactively, once, on demand — never automatic, never
  triggered by a GET.

**Operational status (recorded in the 2026-08-18 documentation refresh
after PR #79, merged as
`9f8a802b0bcf07535706d7dfe1a8733913021d8e`): this section's retroactive
archival design is now implemented**, as the OWNER-only
`archiveLegacyInvoiceAction`/`archiveLegacyInvoice()` Server Action +
service (a dedicated Server Action, not a Route Handler `POST`, but the
same "explicit, on-demand, never automatic, never triggered by a GET"
contract this section requires), gated by `classifyInvoiceArchival()`
exactly as designed, with financial fields recalculated from persisted
primitives and required to exactly match the persisted `Invoice.amount`
before any write. The retroactively-created snapshot/PDF is retrieved
through the same already-shipped staff/Portal signed-URL routes
described in §8.2 above, unchanged. **The live, best-effort read-only
preview on GET described earlier in this section ("may render...")
remains target design only — PR #79 added no preview route and performs
no work on GET.**

### 8.4 Logo handling

Fetching `OrganizationProfile.logoUrl` for render must enforce: an
**allowed origin/path** (only the org's own already-validated Storage
URL, never a client-supplied override), **image content-type check**,
a **byte cap**, and a **timeout**. On any failure, the PDF renders
**without** a logo rather than failing the whole document. Because the
*stored* PDF (§8.1) freezes whatever was actually rendered at
finalization time, a later logo replacement or fetch failure on some
future *regeneration attempt* can never retroactively alter an
already-archived document.

### 8.5 Orphan reconciliation

**Best-effort compensating deletion (§8.1 step 6) remains the immediate,
first-line response** to an upload-succeeded-but-DB-commit-failed
sequence — that is unchanged. But when the compensating deletion *also*
fails (§8.1 step 7), the uploaded object genuinely remains in Storage,
unreferenced by any `Invoice` row — a real, disclosed leak, not
something the unique-archive-id design eliminates on its own (a fresh
archive id only guarantees the orphan can never *collide with or block* a
future retry; it does not delete the orphan).

**Slice 3 must provide a bounded operational reconciliation mechanism**
for objects under the `invoice-pdf` Storage namespace — either a small,
dedicated job, or integrated into an existing cleanup job if one is
already a suitable fit at implementation time. **No new database model is
introduced for this** — a bounded job comparing two things already
available is sufficient:

- **List** private Storage objects under
  `organizations/*/invoice-pdf/**` older than a **conservative safety
  window** (recommend well beyond any plausible in-flight finalization
  attempt — minutes, not seconds, to avoid racing a legitimate
  in-progress upload).
- **Compare** each against the full set of currently-persisted
  `Invoice.pdfStoragePath` values.
- **Delete only** an object with **no matching `Invoice.pdfStoragePath`
  reference** — an object that *is* referenced (the normal case for every
  successfully finalized invoice) is **never** touched, regardless of its
  age.
- **Idempotent and tenant-safe**: re-running the job changes nothing
  beyond what a first run already reconciled; every comparison stays
  scoped within the `organizations/<orgId>/...` path prefix already
  present in the object key, so no cross-tenant listing/deletion is
  possible.
- **No raw Storage error detail or object path is ever logged** — matches
  this codebase's blanket sanitized-logging convention (§9.2, §11); only
  a fixed, sanitized count/condition may be reported.
- This job's own coverage (§13/§14 Slice 3) must include: an orphan
  correctly identified and removed; a referenced, current archive
  correctly left untouched; an object younger than the safety window left
  untouched (protects a legitimate in-flight upload); re-running the job
  twice is a no-op the second time.

**Operational status (recorded in the 2026-08-21 documentation refresh
after PR #83, merged as
`1b0a8864eebefff6668470c9980f9fff3930b702`): this section's normative
goals — bounded, idempotent, tenant-safe, a referenced archive never
touched regardless of age, a safety window protecting a legitimate
in-flight upload, sanitized-only reporting — are now all implemented and
activated in production, via a mechanism that differs from the literal
Storage-listing design written above.** PR #82 (merged as
`d221a9f8f26e035f5531797f8db2ba8493a07af1`) implemented
`reconcileInvoicePdfArchiveObjects()` and a true zero-write dry-run
sibling (`src/lib/invoices/pdf/reconcile-archive-objects.ts`) — **never a
bucket-wide `list()` call, since the `InvoicePdfArchiveObject` ledger
(added later, by sub-PR 3b/PR #73, after this section was originally
written) makes every reconciliation candidate a bounded, indexed database
query instead.** Each candidate's own exact object is addressed
individually via `probeInvoicePdfObject()`/`removeInvoicePdfObject()` —
never a directory/prefix operation — so the tenant-safety and
never-touch-a-referenced-object guarantees above hold structurally, not
just by convention. The safety window (`SAFETY_WINDOW_MS`, 30 minutes) is
proven, not merely recommended, to exceed the documented maximum Vercel
Function invocation lifetime, closing exactly the "protects a legitimate
in-flight upload" requirement above. A claim-token-based ownership
protocol (never `cleanupLockedAt` equality alone) and a stale-claim lease
(`CLEANUP_LEASE_MS`, 10 minutes) provide the concurrency safety this
section's own bullets assumed a job would need. Only a fixed, bounded
failure category is ever persisted — never a raw Storage/database error,
path, or signed URL — satisfying the "no raw Storage error detail or
object path is ever logged" requirement exactly. PR #82 shipped both the
real and dry-run routes **dormant, with no recurring schedule**; PR #83
then added exactly one `vercel.json` cron entry, scheduling only the real
route once daily at `0 7 * * *` UTC — the dry-run route remains
permanently unscheduled, existing solely for manual, authorized,
pre-activation verification. Activation followed a manual dry-run,
operator review, and one manual real invocation (all HTTP 200, all-zero,
since no candidates existed at the time), and a successful first
automatic scheduled execution was subsequently observed (production
request-log evidence: `2026-08-21T07:57:58.118Z` UTC, HTTP 200, `info`-
level, inside the scheduled hour, no error/timeout/duplicate nearby) —
see `GPT_PROJECT_CONTEXT.md`'s Part 2 "Production activation of bounded
Invoice PDF archival reconciliation/cleanup" subsection for the complete
chronology and its own stated limitation (this evidence proves the
scheduled invocation completed successfully; it does not prove a
non-empty candidate/write path has yet been exercised in production).
**With this, official Invoice System Slice 3 has no remaining piece.**

---

## 9. APPROVED TARGET DESIGN — Email Architecture and Idempotency

Email works for **every** `Client` with `Client.email` set — **portal
access is optional and never a precondition for sending.**

### 9.1 Content and state semantics

- **Attach the already-archived PDF** (never regenerate for an email —
  guarantees a resend always references byte-identical content to the
  original send). Include a portal link in the email body **only if**
  the Client has active portal access — an optional enhancement, never a
  gate on whether the email can be sent at all. **No unauthenticated
  invoice access token is ever created.**
- `sendEmailViaResend()` (§1.5) is extended **additively**:
  ```ts
  export type SendEmailInput = {
    to: string; from: string; subject: string; html: string; text: string;
    attachments?: { filename: string; content: string /* base64 */ }[];  // NEW, optional
  };
  export type SendEmailResult =
    | { ok: true; messageId?: string }   // NEW: messageId, requires parsing the response body (not done today)
    | { ok: false; reason: "not_configured" | "provider_error" | "network_error" };
  ```
  Every existing caller (staff/portal invitations, password reset,
  notification emails) never sets `attachments` — **zero behavioral
  change** for them, TypeScript-safe via the optional field.
- Safe filename, matching the download route's sanitization. A
  **provider-compatible binary/base64 size cap** — base64 encoding
  expands payload size by ~33%, so the conservative *application-level*
  cap must account for that expansion, not just the raw PDF byte count.
- Recipient is **always** `Client.email`, read fresh server-side at send
  time, snapshotted per-attempt into `recipientEmail` — never a
  client-submitted value. Missing `Client.email` blocks send with a
  clear, actionable staff error.
- **Provider acceptance is not delivery.** State names reflect exactly
  what's knowable:
  - **`PENDING`** — the operation was created; no provider result
    recorded yet.
  - **`ACCEPTED`** — the provider accepted the request (a 2xx response
    parsed and confirmed) — **not** proof of inbox delivery.
  - **`FAILED`** — the provider definitively rejected or failed the
    request *before* acceptance (a clean 4xx/5xx, or a `not_configured`/
    `network_error` result the app itself can classify with confidence).
  - **`UNKNOWN`** — the result cannot be established, including a crash
    or timeout during the provider call — **never silently reclassified
    as `FAILED`** just because the outcome is uncertain.

### 9.2 Idempotency and concurrency

**Achievable guarantee, stated precisely: at-least-once attempt recording
and at-least-once provider dispatch — not exactly-once delivery.** This
document does not, and must not, claim exactly-once semantics.

- **Every Send/Resend UI click carries a stable UUID `idempotencyKey`**,
  generated once per logical operation. A **unique DB constraint**
  (`InvoiceEmailAttempt.idempotencyKey`) means a retried request (Server
  Action retry, a double click resubmitting the *same* key) either
  creates one row or reconciles against the existing one — never a
  duplicate. **An intentional "Resend" always generates a brand-new
  key** — a deliberate new operation, never a retry of the old one.
- The **partial unique Postgres index** (§4.3) —
  `WHERE status = 'PENDING'` — is the hard, DB-enforced backstop against
  two concurrent active sends for the same invoice (double-click, two
  browser tabs, two different staff members racing). A client-side
  disabled-button/rate-limit is a **secondary UX control, never the
  safety guarantee** — the database is.
- **A stale `PENDING` row is never silently auto-converted to `FAILED`.**
  After a conservative timeout (recommend 60s), an attempt that never
  resolved becomes **`UNKNOWN`**, not `FAILED` — the message *may* have
  actually gone out; claiming `FAILED` would be dishonest. The UI must
  **explicitly warn** that an `UNKNOWN` attempt may have been accepted by
  the provider. **Retrying from `UNKNOWN` requires explicit staff
  confirmation** (a distinct, deliberate click acknowledging the risk of
  a possible duplicate) and always uses a **new** `idempotencyKey`.
- **If Resend's live API is confirmed (§15) to support a provider-side
  idempotency key/header**, pass the attempt's own `idempotencyKey` as
  that header — a backstop layered *on top of* the DB guarantee, never a
  replacement for it.
- **The one honestly disclosed gap**: a process crash strictly between
  "provider accepted" and "DB row updated to `ACCEPTED`" leaves the row
  `PENDING` → later `UNKNOWN` → a possible staff-confirmed duplicate
  resend. Closing this fully requires a real Resend delivery webhook —
  explicitly out of scope for v1.
- `providerMessageId` may be stored (diagnostics/future idempotency
  correlation) — **not itself a secret**, but never printed in any log
  line regardless, matching this codebase's blanket no-raw-provider-data
  logging convention. Raw provider errors, the recipient address, and PDF
  bytes/base64 content are **never logged**, ever.

**Operational status (recorded in the 2026-08-22 documentation refresh
after PR #87, merged as `e50d3fe081b879078a4774f15c5e5a74158d25b0`): this
section's design is now implemented in full and verified working end to
end in a real production environment — official Invoice System Slice 4
has no remaining piece.** The foundation shipped first, deliberately
unwired (sub-PR 4a/PR #85, merged as
`120d382b283739b9abb238241a4707e7e97a6a65`): the extended
`sendEmailViaResend()`/`checkEmailProviderReadiness()` contract exactly
as specified above, a pure Invoice-PDF byte-download helper, the trusted-
application-origin resolver for the optional Portal link, and a pure
email content view-model. **Sub-PR 4b (PR #86, merged as
`b32e50d486d234de920f0a2ae545e0e248fb0675`) then shipped the live send
path** — the real `InvoiceEmailAttempt` writer, the combined Send/Issue-
&-Send Server Action + service exactly as designed (Send on a `DRAFT`
target invokes Slice 3's own Issue/archive service first, in the same
operation, never a separate finalization path), the full idempotency
design (a fresh UUIDv4 per click, the unique `idempotencyKey` constraint,
and — via a new migration,
`20260914090000_add_invoice_email_attempt_pending_index` — the partial
unique `WHERE status = 'PENDING'` index this section's own §9.2 specifies
as the hard DB-enforced concurrency backstop), the `PENDING`/`ACCEPTED`/
`FAILED`/`UNKNOWN` settlement contract with the 120-second stale-`PENDING`
sweep to `UNKNOWN` (never `FAILED`), and the explicit-acknowledgement/
fresh-`idempotencyKey` resend rule for an `UNKNOWN` attempt. A reproduced
production defect on the Issue/Send buttons themselves (invisible
white-on-white text, unrelated to this section's own send-path design)
was found and corrected by **PR #87** (merged as
`e50d3fe081b879078a4774f15c5e5a74158d25b0`) — see §8.2's own UI notes and
`GPT_PROJECT_CONTEXT.md`'s Part 2 "Button-visibility correction"
subsection for the full root-cause/fix account, which is UI-styling-only
and does not affect any guarantee described in this section. **Production
verification**: the sub-PR 4b migration was backed up, precondition-
checked (zero existing duplicate-`PENDING` rows), and deployed; a real
QA Invoice was issued exactly once through the normal UI and its archived
PDF verified; the first live Send request was correctly rejected
(`EMAIL_NOT_CONFIGURED`, no `InvoiceEmailAttempt` row created) because
the production environment was missing `RESEND_API_KEY` — diagnosed via
a strict read-only Vercel environment-variable metadata audit, never a
value access; the key was then added to Production and the sender
variable updated, the same commit redeployed, and exactly one newly
authorized Send request settled `ACCEPTED`, with exactly one attempt
persisting after a hard reload and exactly one email reaching a
controlled test mailbox with a correct PDF attachment. See
`GPT_PROJECT_CONTEXT.md`'s Part 2 "Invoice System Official Slice 4" and
"Production deployment and first live Invoice-email verification"
subsections for the complete chronology. **Important operational
limitation, not a code defect**: this verification used Resend's own
testing-domain sender and a mailbox associated with the Resend account
itself — this configuration is intentionally test-only and cannot send
to arbitrary real Client addresses. Real-customer rollout requires a
separately verified custom sending domain and an appropriate Production
sender address before this feature is used for any real customer — a
deployment/operational-readiness prerequisite, tracked separately, that
does not reopen this section's own implementation, which is complete and
verified working exactly as designed.

---

## 10. APPROVED TARGET DESIGN — Portal Visibility

| Status | Portal visible? |
|---|---|
| `DRAFT` | **Hidden** — every surface |
| `SENT` ("Issued") | Visible |
| `OVERDUE` | Visible |
| `PAID` | Visible (as history) |
| `CANCELLED` | Visible (as a historical cancelled document) |

**Cross-client and cross-organization access must be indistinguishable
from "not found"** — a 404-equivalent, never a distinguishing error that
would let a portal identity infer the existence of another org/client's
invoice.

**Four current query surfaces require this change** (§1.3):
`getPortalInvoice`, `getPortalInvoices`, `getPortalOverview`'s
`recentInvoices`, and `getPortalOverview`'s open aggregate.

**Target constants:**
```ts
const OPEN_INVOICE_STATUSES: readonly InvoiceStatus[] = ["SENT", "OVERDUE"];  // DRAFT removed
const VISIBLE_PORTAL_STATUSES: readonly InvoiceStatus[] = ["SENT", "OVERDUE", "PAID", "CANCELLED"];
```
`getPortalInvoice`/`getPortalInvoices`("all")/`getPortalOverview`'s
`recentInvoices` all gain a `status: { in: VISIBLE_PORTAL_STATUSES }`
filter; `getPortalOverview`'s open aggregate uses the corrected
`OPEN_INVOICE_STATUSES`. This directly extends to the PDF download route
(§8.2) — a `DRAFT` invoice's PDF is never reachable via the portal route
either.

---

## 11. APPROVED TARGET DESIGN — Security Contract

- **`organizationId`/`clientId`/`projectId` are always server-derived**
  from the verified session — never trusted from `FormData` or a route
  param.
- **No client-submitted totals or email recipient** — the server always
  recomputes `subtotal`/`discountAmount`/`taxAmount`/`total` (§5) and
  always resolves the recipient from `Client.email` (§9) fresh.
- **Line items are always nested writes under an already-authorized
  parent `Invoice`** — never independently addressable by id from client
  input (§4.2).
- **Staff/portal IDOR protection**: every lookup uses a scoped
  `findFirst`/`findMany` (the auth predicate *inside* the query), never
  `findUnique(id)` followed by a separate check.
- **Strict `DRAFT` invisibility to the portal** (§10) across every
  surface, including PDF download.
- **PDF routes**: `private, no-store` headers (§8.2); **GET is strictly
  read-only** — no mutation of any kind, for any invoice, in any state.
- **PDF/logo resource limits**: line-item count (200) and description
  length (500 chars) caps (§5); logo fetch origin/content-type/size/
  timeout limits (§8.4) — both defend against resource exhaustion and
  SSRF.
- **Email PII/provider-error log hygiene**: fixed, sanitized failure
  categories only; never a raw caught error, the recipient address, or
  PDF/base64 content in any log line (§9.2).
- **Decimal serialization**: `.toString()`/`Number()` conversion only at
  the final render/props boundary — a raw Prisma `Decimal` must never
  cross the Server Component → Client Component boundary unconverted
  (matches the existing, correct `toInvoiceSummary()`/`revenue.ts`
  convention).
- **No payment-provider integration of any kind** on invoices (§2.2) —
  this feature never touches Paddle.
- **No portal-analytics-persistence expansion** — no new
  `PortalDownloadRequest`-style invoice-download-event tracking (§2.2);
  that model's exact-allowlist security check (`check-analytics-security.mjs`
  #13) is deliberately not widened by this feature.

**Verification approach**: prefer integration tests for every
authorization invariant above (tenant-scoped `findFirst`/`findMany`
proofs, cross-org/cross-client 404-equivalence, server-derived-totals
proofs) over a static check. **Do not prescribe a brittle Prisma-model
field allowlist** — an allowlist that blocks legitimate future invoice
fields (e.g. a future tax-jurisdiction field) actively fights normal
schema evolution for an ordinary business model; that technique is
correctly reserved for Portal Analytics's unusually severe, deliberately
narrow, by-design privacy invariant (§1.5), not for this feature. **A
narrow log-hygiene static check may be considered only against the exact
new files this feature adds** (the email module, the two PDF routes, the
send action) — the one category ordinary tests/lint/types structurally
cannot verify (TypeScript can't distinguish a safe fixed log string from
an unsafe interpolated one).

---

## 12. APPROVED TARGET DESIGN — Safe Migration / Deployment

**The implementation must never expose incorrect default-zero totals
during a rolling deployment.** An explicit expand → backfill → contract
sequence, not a single blind migration — **with the contract step
explicitly owned, never left ownerless**:

**The §4 schema snippets show the eventual, fully-contracted target
state** (`subtotal`/`discountAmount`/`taxAmount` non-nullable and
defaulted, `Invoice.organizationId`-style `NOT NULL` columns where
applicable). **Slice 1's actual implementation schema may temporarily
keep newly-added calculated/snapshot columns nullable** where rolling
compatibility requires it — the contract to the final, non-nullable
shape shown in §4 is a **separate, later step, owned by Slice 5** (below),
not assumed to land atomically with Slice 1.

1. **Slice 1 — Expand**: additive nullable columns/tables only —
   `InvoiceLineItem`, `InvoiceEmailAttempt`, `Client` billing fields,
   `Invoice`'s discount/tax/subtotal/snapshot/pdf-archival columns. Old
   application code deployed against this schema sees no behavioral
   change (it never reads/writes the new columns).
2. **Slice 1 — Deterministic legacy backfill**, run immediately after
   expand: `subtotal = amount, discountAmount = 0, taxAmount = 0` for
   every pre-existing row — a pure, deterministic copy of an
   already-existing fact, **fabricating no line items**.
3. **Slices 1–4 — Application dual-read/dual-write compatibility**: every
   slice's application code must tolerate both a freshly-expanded schema
   (new columns exist but may be temporarily nullable/unbackfilled) and
   the fully-backfilled state, without ever displaying an inconsistent
   `subtotal: 0` next to a nonzero `amount`; all new saves write correct
   values from the moment each slice ships, and legacy rows get a
   fallback read path (§4.6) rather than being assumed fully populated.
4. **Slice 5 — Verify, then contract**: verify zero remaining
   inconsistency (a hard stop, never a silent partial application —
   mirroring the discipline already proven in migration
   `20260911090000_repair_invoice_organization_scope`, §1.6), **only
   then** apply the `NOT NULL`/constraint changes that bring the schema to
   §4's final target shape. This is the same expand/backfill/**contract**
   split migration `20260911090000...` itself modeled for
   `Invoice.organizationId` — Slice 5 is this feature's own contract step,
   explicitly, not an implicit assumption.
5. **Slice 5 — Real-data collision preflight** before the
   organization-wide invoice-number uniqueness contract (§4.5) —
   abort/report, never silently rename. (If Slice 1 already landed the
   `[organizationId, invoiceNumber]` constraint per §4.5's "lands here or
   is deferred" language, this preflight is Slice 1's responsibility
   instead — whichever slice actually applies that specific constraint
   change owns its own preflight.)
6. **Old/new application version compatibility** across the deploy
   window — the Slice 5 contract-phase migration (`NOT NULL`, constraint
   swaps) must only run once application code guaranteeing correct writes
   (live since Slice 1/2) has been live for a full deploy cycle.
7. **Honest rollback/data-loss consequences**: an additive-only migration
   with zero real usage is losslessly reversible; **the moment any real
   line item, email attempt, or archived-PDF reference has been written,
   a rollback is a genuine, disclosed data-loss event** — this must never
   be described as "reversible" once that data exists. Archived PDF
   *files* in Storage are not cleaned up by a schema rollback and become
   orphaned references (§8.5 covers reconciling those, not schema
   rollback specifically).
8. **Storage orphan cleanup**: best-effort compensating deletion (§8.1
   step 6) remains the immediate first-line response, and a fresh archive
   id (§8.1 step 4) guarantees an orphan can never *block* a future retry
   — but neither of those *removes* an orphan that survives a
   double-failure (§8.1 step 7). **§8.5's bounded reconciliation job is
   the actual cleanup mechanism** — it is not optional, and "no orphan
   scan is ever required" is not an accurate description of this design.

**Operational note, restated**: PR #63's `Invoice.organizationId` repair
migration was merged into source control on `main` but **was not applied
to any external/staging/production database by that merge task** — a
real deployed database still needed the normal, controlled migration
deployment process before that repair (or anything in this document)
would take effect there. This remains an accurate description of what
PR #63's own merge task did. **Operational status recorded in this
2026-08-18 documentation refresh:** that controlled deployment step has
since happened. Migration drift had accumulated because this migration
and three others (introduced by PR #60, PR #65, and PR #73) were each
merged into source control without being operationally applied; on
2026-08-17, after PR #73 merged, the production database was discovered
to be exactly those four migrations behind, causing a real, confirmed
production incident (not caused by PR #73's own merge, only surfaced by
it). That same day, a backup/`prisma migrate deploy`/status/schema-
verification sequence was carried out against the one verified
production Supabase database. **All 26 repository migrations are now
confirmed applied there** (no claim is made about staging or any other
environment) — see `GPT_PROJECT_CONTEXT.md`'s "Production migration
incident and resolution" for the full account. This note is preserved to
document what "merged but not yet deployed" meant at PR #63's own time,
not because that gap still exists today.

---

## 13. Test Matrix (target coverage, explicitly owned per slice)

### 13.1 Slice 2 tests

DRAFT itemized CRUD (create/edit through the real Server Actions, never a
fixture that manufactures totals); `calculateInvoiceTotals()` exhaustively
(§5, all four worked examples plus every error code) and its live
client-side preview; validation (currency allowlist §6, line-item
count/description caps); **no `DRAFT → SENT` transition is possible yet
— proven directly, since Slice 2 ships with no archive capability at
all** (§14 Slice 2 scope); existing legacy non-`DRAFT` invoices' read-only
presentation and status behavior (view-only rendering, no edit form for
frozen fields); delete/cancel/duplicate rules (§3.1/§3.2, including the
invoice-number confirmation UX); `internalNotes` remaining editable in
every status.

### 13.2 Slice 3 tests

Snapshot creation and versioned-parser correctness (§7, including an
unknown-`schemaVersion` failure case); the full render → upload → final
DB commit pipeline (§8.1); the transaction's own concurrency re-check
(a second finalization attempt against an already-non-`DRAFT` invoice is
rejected); compensating delete on DB-commit failure (§8.1 step 6);
**orphan reconciliation** (§8.5: an orphan correctly identified and
removed, a referenced/current archive never touched, an object younger
than the safety window left untouched, re-running the job twice is a
no-op); **the core invariant, proven directly**: `status = SENT` implies
both `finalizedAt` and `pdfStoragePath` are non-null for every
newly-issued invoice (§4.6); **no live-fallback rendering for an
invariant-violation record** (`finalizedAt` set, `pdfStoragePath` null,
§4.6/§8.3); both PDF GET routes proven read-only (zero DB writes on any
GET, for every invoice state) and correctly authorized (staff/portal
IDOR, cross-org/cross-client 404-equivalence, §11); **`DRAFT → SENT`
becomes possible only once this slice's archive capability exists** —
the UI's Issue action stays disabled/unavailable until this slice ships
(§14 Slice 2/3 boundary).

### 13.3 Slice 4 tests

Email `ACCEPTED`/`FAILED`/`UNKNOWN` state transitions; same-
`idempotencyKey` retry behavior and concurrent-send rejection via the
partial unique index (§9.2); no-email block (missing `Client.email`);
Activity/Notification effects unchanged (the existing
`STATUS_CHANGED`→`INVOICE_STATUS_CHANGED` fan-out, §1.2); **the combined
Send behavior, proven directly**: if the target invoice is still `DRAFT`,
Send first invokes the exact same Slice 3 Issue/archive service (never a
separate, divergent finalization path) — email sending only begins after
that Issue commit succeeds, and **if archive/finalization fails, no
`InvoiceEmailAttempt` row is ever created and no email is dispatched**.

### 13.4 Slice 5 tests

**Owns the contract-migration verification** (§12 step 4): the final
`NOT NULL`/constraint changes applied cleanly against fully-backfilled
data, with the same "verify zero inconsistency before altering" discipline
already proven for `20260911090000_repair_invoice_organization_scope`;
the organization-wide invoice-number uniqueness constraint (§4.5), if not
already landed in Slice 1, gated on its own real-data collision preflight.
Portal status visibility for every status in §10's table — list + detail
+ PDF — including a direct proof that `DRAFT` is genuinely unreachable
(404, not merely absent from a list); relation/tenant consistency (line
items always resolve through an already-authorized parent, §11);
immutable-field enforcement after finalization holds across every
lifecycle transition in §3.1, both allowed and forbidden; final,
whole-feature E2E closure.

### 13.5 Cross-cutting E2E (closed out in Slice 5, exercised incrementally as each slice ships)

Itemized `DRAFT` creation + live client-side total preview + edit;
finalize/archive flow; PDF download (staff + portal, header/content
assertions, including the corrected §8.2 redirect-only response
semantics); send/resend (using `TEST_MODE`'s existing email
short-circuit, matching the established precedent for untestable
real-provider paths — `test/e2e/password-reset.spec.ts`); cancel +
duplicate; portal visibility/download across every status in §10's
table; legacy invoice behavior fully unaffected; responsive/accessibility
assertions for the new line-item sub-form, matching this codebase's
existing mobile/tablet-overflow regression-test discipline.

---

## 14. IMPLEMENTATION SLICES

**Prerequisite — `Invoice.organizationId` repair: ✅ COMPLETE (PR #63,
merged as `41452bd7391700f1b73063b4a8e16864d0e3de84`).** Not applied to
any external database by that task (§1.6/§12). **Applied to the verified
production database on 2026-08-17** (recorded in this 2026-08-18
documentation refresh) — see §1.6's operational update.

**Slice status summary (recorded in this documentation-only Slice 5d
closure refresh, after PR #92): Slices 1–5 are all ✅ COMPLETE. No
planned Invoice System slice remains.** Slice 4 — email attachment,
attempt state, idempotency — shipped via sub-PR 4a (PR #85) and sub-PR 4b
(PR #86), was corrected for a reproduced production button-visibility
defect (PR #87), and has since been verified working end to end in a
real production environment, including one real Send request settling
`ACCEPTED` and reaching a controlled test mailbox with a correct PDF
attachment — see §9.2's own operational status note below for the full
chronology. **Slice 5 — Portal DRAFT-visibility (5a/PR #89), the totals
`NOT NULL` contract (5b/PR #90), organization-wide Invoice-number
uniqueness (5c/PR #91), and safe itemized demo-seed closure (5d/PR
#92) — has since shipped in full**, closing this document's own
five-slice plan; see the Slice 5 entry below for the per-sub-PR
breakdown and the archived-seed narrowing rationale.

**Slice 0 — this document.** `docs/invoicing-architecture.md`, committed
before any code. *(This slice.)*

**Slice 1 — expand schema, calculation domain, Client billing identity,
legacy compatibility.**
- *Dependencies*: prerequisite (complete).
- *Scope*: an **expand** migration only — the full §4 schema, but with
  newly-added calculated/snapshot columns kept **temporarily nullable**
  where rolling compatibility requires it (§12), not necessarily §4's
  final contracted shape yet; `Decimal(10,2)/(10,3)` throughout, no
  precision change to the existing `amount` column; the deterministic
  legacy backfill (§12 step 2), run immediately after expand;
  `calculateInvoiceTotals()` (§5); `Client` billing fields + validation,
  including a minimal "Billing details" subsection added to the existing
  `ClientForm` (create + edit) so the seven new fields have a real write
  path from day one — a schema with permanently unwritable columns isn't
  acceptable, and this is the only UI this slice adds; currency
  validation (§6); application code correctly reads/writes the new
  columns from this point on (§12 step 3). The invoice-numbering
  uniqueness migration (§4.5/§12.5) lands here or is deferred per its own
  preflight outcome.
- *Likely files*: `prisma/schema.prisma`, new migration(s),
  `src/lib/invoices/calculations.ts` (new), `src/lib/validation/{invoice,client}.ts`,
  `src/lib/validation/company-profile.ts`-adjacent currency helper,
  `src/components/clients/client-form.tsx` (the Billing details
  subsection).
- *Tests*: unit (calc engine exhaustive), integration (backfill
  correctness, currency validation, Client billing-field write path).
- *Acceptance*: schema validates, migration applies cleanly against the
  real PGlite-backed test harness, `calculateInvoiceTotals()` unit-tested
  exhaustively.
- *Non-goals*: **no *Invoice* UI** (no line-item sub-form, no
  discount/tax/currency/issue-date inputs, no Issue/Send action — see
  §14 Slice 2), no PDF, no email, no lifecycle enforcement yet. The
  Client billing-details subsection above is the sole exception, and is
  not itself invoice UI — it lives on the existing Client form, has no
  invoice-specific behavior, and ships regardless of whether any invoice
  ever references it. No `NOT NULL`/constraint contract — that is Slice
  5's, explicitly (§12).
- *Migration/deployment*: expand + deterministic backfill only (§12
  steps 1-2); owns no contract-phase step.

**Slice 2 — staff itemized UI, DRAFT-only lifecycle enforcement,
read-only issued view, cancel+duplicate. Does NOT finalize anything.**
- *Dependencies*: Slice 1.
- *Scope*: itemized `DRAFT` create/edit UI (line-item sub-form +
  discount/tax/tax-label inputs); the live client-side calculation
  preview plus full server-side validation (§5); `DRAFT`-only creation;
  validation of the §3.1 transition rules for **already-existing**
  non-`DRAFT`/legacy records (e.g. `SENT→PAID`, `PAID→SENT` undo,
  `→CANCELLED`, all still enforceable without an archive pipeline since
  those invoices are already finalized); a **read-only presentation** for
  every existing non-`DRAFT` invoice (labeled "Issued" for `SENT`);
  `internalNotes` behavior (always editable, never rendered externally,
  §3.3); delete restricted to `DRAFT` only; cancel + duplicate-as-new-draft
  with the confirm-the-number UX (§3.2), where applicable to
  already-non-`DRAFT` invoices; **prepares a reusable
  lifecycle/finalization domain-service contract** (the function
  signature/interface Slice 3 will implement against) **without
  implementing its body**.
- **This slice does NOT allow a new `DRAFT → SENT` transition.** It does
  **NOT** write `finalizedAt`, `issuerSnapshot`, `recipientSnapshot`, or
  `pdfStoragePath` under any circumstance. **The Issue action is
  unavailable/disabled in the UI until Slice 3 ships** — there is no
  intermediate state, reachable from any merged `main` in this slice, in
  which a newly-created invoice can become `SENT` without an immutable
  archived PDF (§4.6/§8.1).
- *Likely files*: `src/components/invoices/invoice-form.tsx`,
  `src/app/(dashboard)/invoices/{new,[id]/edit}/actions.ts`,
  `src/app/(dashboard)/invoices/[id]/edit/page.tsx` (read-only branch),
  `src/lib/activity/invoice-metadata.ts`, a new
  `src/lib/invoices/lifecycle.ts`-style contract module (interface only).
- *Tests*: §13.1 in full.
- *Non-goals*: no PDF archive, no email, no "Send"/"Issue" action, no
  `finalizedAt`/snapshot/`pdfStoragePath` writes of any kind.
- *Migration/deployment*: none beyond Slice 1's; dual-read/dual-write
  compatibility maintained (§12 step 3).

**Slice 3 — PDF renderer, archive pipeline, the authoritative Issue
operation, authenticated downloads. Owns every write to
`finalizedAt`/the snapshots/`pdfStoragePath` for newly-issued invoices.**
- *Dependencies*: Slice 2 (consumes its lifecycle/finalization service
  contract; needs the read-only issued view already in place).
- *Scope*: verifies `@react-pdf/renderer` (§15 verification gate) and
  adds it as a dependency; implements the versioned snapshot builder and
  parser (§7); implements the render → upload → compensation pipeline in
  full (§8.1); **implements the actual, authoritative Issue/finalize
  operation** against Slice 2's prepared service contract — **its final
  DB transaction is the only code path anywhere in this feature that
  writes `issuerSnapshot`, `recipientSnapshot`, `pdfStoragePath`,
  `pdfGeneratedAt`, `finalizedAt`, and `status = SENT` together**; the
  two §8.2 read-only, redirect-only GET routes; the §8.3/§4.6
  legacy-preview vs. explicit-archive vs. invariant-violation
  distinction; §8.4 logo handling; §8.5 orphan reconciliation. **Only
  once this slice ships does the staff UI's `DRAFT → SENT`/Issue action
  become enabled** — Slice 2 shipped it disabled.
- *Likely files*: `package.json` (one new dependency), `src/lib/invoices/pdf/*`,
  `src/lib/invoices/lifecycle.ts` (implementation, against Slice 2's
  contract), `src/app/api/{,portal/}invoices/[id]/pdf/route.ts`,
  `src/lib/rate-limit/limits.ts`, an orphan-reconciliation job/script.
- *Tests*: §13.2 in full.
- *Non-goals*: no email attachment yet.
- *Migration/deployment*: none beyond storing new `pdfStoragePath`/
  `pdfGeneratedAt`/`documentVersion` values — schema already expanded in
  Slice 1.

**Slice 4 — email attachment, attempt state, idempotency. Always issues
through Slice 3's service before ever sending.**
- *Dependencies*: Slice 1 (schema), Slice 3 (the authoritative Issue
  operation this slice invokes for a `DRAFT` target, and the archived PDF
  it attaches — a real code dependency, not just ordering).
- *Scope*: `InvoiceEmailAttempt` usage, the extended `sendEmailViaResend()`
  (§9.1), the send/resend action (§9.2's idempotency design in full,
  including the partial unique index and the `UNKNOWN`-state recovery
  UX), portal-access-optional recipient resolution. **The combined Send
  action, explicitly**: if the target invoice is still `DRAFT`, Send
  invokes Slice 3's Issue/archive service first, in the same operation —
  never a separate, divergent finalization path; email sending begins
  only after that Issue commit succeeds; **if archive/finalization
  fails, no `InvoiceEmailAttempt` row is ever created and no email is
  dispatched.**
- *Likely files*: `src/lib/email/resend-client.ts` (additive extension),
  `src/lib/email/invoices.ts` (new), a new send Server Action (calling
  Slice 3's lifecycle service for the DRAFT-target case), a new raw
  migration statement for the partial unique index.
- *Tests*: §13.3 in full.
- *Non-goals*: no delivery webhook (exactly-once is explicitly not
  claimed, §9.2).
- *Migration/deployment*: the partial unique index migration; must be
  additive/expand-only relative to Slice 1's schema.

**Slice 5 — portal visibility/presentation, contract migration, final
security/integration/E2E/seed/docs closure. ✅ COMPLETE.** "5a"/"5b"/
"5c"/"5d" below are informal development-time subdivisions of this one
official slice (PR #89/#90/#91/#92 respectively) — the same convention
already established for "2a"/"2b" and "3a"/"3b"/"3c"; they are not
additional entries in this document's own five-slice count.
- *Dependencies*: all prior slices.
- *Scope, and what shipped*:
  - **5a (PR #89): the full §10 portal-visibility fix, all four query
    surfaces.** See §1.3.
  - **5b (PR #90): the Slice-5 contract migration** (§12 step 4) —
    verification that every backfilled/dual-written column is fully
    consistent, then the `NOT NULL`/`DEFAULT 0` changes that bring
    `subtotal`/`discountAmount`/`taxAmount` to §4's final target shape.
    Applied and verified in production. See §4.1.
  - **5c (PR #91): the organization-wide invoice-number uniqueness
    constraint and its real-data collision preflight** (§4.5/§12.5).
    Applied and verified in production, zero blocking collision counts,
    no deliberate production collision write. See §4.5.
  - **5d (PR #92): seed-data update — narrowed to a safe itemized,
    non-archived demo Invoice**, not the originally-worded "itemized+
    archived" pair. A genuinely archived seed row was rejected: it would
    require either a real external Storage write from an ordinary local
    `prisma/seed.ts` run (a disproportionate new risk this script has
    never carried) or a database-only row that falsely looks archived
    while a real "Download PDF" click would fail — both unacceptable.
    The real itemized+archive+download capability is already shipped,
    production-verified (Slice 3/4), and covered by existing
    integration/E2E tests using this repo's own `TEST_MODE` Storage
    stub — this narrowing is a local-demo-database convenience decision
    only, not a gap in Invoice System functionality.
  - The §11 log-hygiene static check was not separately adopted as its
    own new script — see §14's general note on security-check scope.
  - The full §13 test matrix closure (§13.4) — covered across 5a/5b/5c's
    own migration-contract, integration, and E2E coverage.
  - README Roadmap-item update — the stale "no PDF/email flow" bullet
    was removed as part of this same documentation closure.
  - This document's own finalization — the bounded operational-status
    updates in this closure pass (§1.3, §4.1, §4.5, §14, §15).
- *Non-goals*: the `GPT_PROJECT_CONTEXT.md` refresh is explicitly
  **excluded** from this slice's own official scope — it is instead
  the separate, final documentation-only step described immediately
  below, and was completed alongside this same closure.
- *Migration/deployment*: the contract-phase migration (5b) and the
  organization-wide uniqueness migration (5c) — the two steps every
  earlier slice explicitly deferred to this slice, never left ownerless.
  Both applied to production, in that order, each gated on its own
  read-only preflight and a fresh verified backup.

**Final, separate step (not a slice): a documentation-only
`GPT_PROJECT_CONTEXT.md` refresh**, only after Slice 5 merges. **✅
COMPLETE** — this closure pass updates both `GPT_PROJECT_CONTEXT.md` and
this document together; per each file's own established rule, a
documentation-only commit does not itself move the application-state
baseline (which remains `main` @ `a0b70a35c6371c7478b80ab036da0fda6e4bc31f`,
PR #92).

---

## 15. EXTERNAL VERIFICATION GATES

Facts this document could not verify from inside this repository — a
later slice must confirm these before relying on them as fact, not
freeze a guess into the architecture:

- **`@react-pdf/renderer`'s exact compatibility** with this repo's Next.js
  16 / React 19 / Node runtime, and its current stable version — verify
  immediately before Slice 3 begins.
- **Resend's actual documented attachment size limit, request payload
  shape, and whether its live API supports a client-provided idempotency
  key/header** — no SDK/types are installed in this repo to confirm any
  of this from source; must be checked against Resend's current official
  API documentation immediately before Slice 4 begins. The conservative
  internal size cap (§9.1) must be derived from that real limit, adjusted
  for base64 expansion — not a number invented here. **Resolved by sub-PR
  4a/PR #85**: `sendEmailViaResend()` was extended to send a client-
  provided `Idempotency-Key` header on every request, per §9.2's own
  "layered on top of the DB guarantee, never a replacement for it"
  design — confirmed working end to end by the real production Send
  verified after PR #87 (see §9.2's own operational status note).
- **RESOLVED — real deployed-database collision risk** for the
  `[organizationId, invoiceNumber]` uniqueness migration (§4.5/§12.5).
  The real production collision preflight (§12.5) was run immediately
  before the Slice 5c/PR #91 migration deploy: all three blocking counts
  (duplicate groups, blank/whitespace numbers, ownership inconsistency)
  were zero. The migration then applied cleanly and was catalog-verified
  afterward (new index present and unique, old index absent, collision
  recheck still zero). No deliberate duplicate write was ever
  manufactured against production to prove this — the evidence is the
  real preflight query, the migration's own guard, the migration-contract
  tests, the integration/concurrency tests, the E2E suite, and exact-head
  CI, combined.

---

Stale-document correction made alongside publishing this document:
`docs/search-architecture.md`'s "scoping-convention inconsistency"
paragraph, which described `Invoice.organizationId` as an unreliable
column Search must avoid, is corrected — that claim became false the
moment PR #63 made the column required and canonical. See that file's
own diff for the exact wording; `docs/notifications-architecture.md`
was inspected and found to already be accurate, unchanged.
