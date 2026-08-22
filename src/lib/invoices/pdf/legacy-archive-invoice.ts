import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { assertCanAccessPaymentDetails, OrganizationSetupAccessError } from "@/lib/organization-setup/authorization";
import { getCompanyProfile } from "@/lib/organization-setup/company-profile";
import { getPaymentDetails } from "@/lib/organization-setup/payment-details";
import { createActivity } from "@/lib/activity/create-activity";
import { buildInvoiceUpdatedMetadata } from "@/lib/activity/invoice-metadata";
import { calculateInvoiceTotals, type InvoiceCalculationInput } from "@/lib/invoices/calculations";
import { isSupportedInvoiceCurrency } from "@/lib/invoices/currencies";
import type {
  LegacyArchiveInput,
  LegacyArchiveResult,
  LegacyArchiveErrorCode,
} from "@/lib/invoices/lifecycle";
import { classifyInvoiceArchival } from "./classify-archival";
import {
  buildIssuerSnapshotV1,
  buildRecipientSnapshotV1,
  parseIssuerSnapshot,
  parseRecipientSnapshot,
  type InvoiceIssuerSnapshotV1,
} from "./snapshot-types";
import {
  buildInvoicePdfViewModel,
  toRendererIssuerPresentation,
  toRendererRecipientPresentation,
  type InvoicePdfIssuerPresentation,
} from "./view-model";
import { renderInvoicePdfBuffer } from "./document";
import { validatePdfBuffer } from "./buffer-validation";
import {
  buildInvoicePdfStoragePath,
  uploadInvoicePdfObject,
  removeInvoicePdfObject,
  type InvoicePdfObjectIdentity,
  type InvoicePdfUploadResult,
} from "./storage";
import { resolveInvoiceLogo, type ResolvedInvoiceLogo } from "./logo";
import { compensateArchiveUpload } from "./archive-compensation";

/**
 * Invoice System Official Slice 3, Legacy Archive — the retroactive,
 * OWNER-only archival service for an already-non-DRAFT invoice whose
 * classifyInvoiceArchival() kind is exactly "legacy_eligible"
 * (docs/invoicing-architecture.md §4.6/§8.3). Structurally mirrors
 * issue-invoice.ts's own pipeline (authorize -> scoped read -> build
 * immutable artifacts in memory -> ledger before upload -> upload ->
 * one short final transaction -> post-compensation on failure), reusing
 * every rendering/snapshot/Storage/ledger/compensation primitive
 * unchanged, but is NOT a DRAFT -> SENT finalization:
 *
 *  - `status` is never written — the row keeps whatever non-DRAFT status
 *    it already had (SENT/PAID/OVERDUE/CANCELLED).
 *  - `paidAt`/`issueDate`/`dueDate`/`invoiceNumber`/`currency`/
 *    `documentVersion`/`amount` are never written.
 *  - Snapshots are built from CURRENTLY AVAILABLE OrganizationProfile/
 *    OrganizationPaymentDetails/Client data — there is no historical
 *    snapshot to recover for a row that predates this system, and the
 *    confirmation UI discloses this before the action is ever taken.
 *  - Activity uses the existing UPDATED action with a single logical
 *    changedFields marker ("legacyArchive") — never STATUS_CHANGED,
 *    since no status transition occurs.
 *
 * TRUSTED BOUNDARY: `input.actor` must be built entirely from server-side
 * session/membership resolution (getCurrentMembership()) by the caller (the
 * Server Action) — nothing here ever reads a cookie, header, or FormData
 * value itself. OWNER access is independently re-checked here regardless of
 * what the Server Action already verified.
 *
 * NEVER RETURNED: pdfStoragePath, the Storage bucket name, raw
 * database/Storage errors, snapshot contents, or PDF bytes — see
 * LegacyArchiveResult's own definition in lifecycle.ts for the complete
 * closed result shape.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isCanonicalIso(raw: string): boolean {
  const date = new Date(raw);
  return !Number.isNaN(date.getTime()) && date.toISOString() === raw;
}

/**
 * Thrown only when the final transaction's own guarded Invoice update
 * matches zero rows — the row is no longer legacy_eligible (already
 * archived by a concurrent winner), its status changed since the PDF was
 * rendered, or its updatedAt no longer matches. Mapped to the public
 * CONFLICT error code. Never escapes this module.
 */
class LegacyArchiveConflictError extends Error {}

/**
 * Thrown only when the guarded ledger PENDING_UPLOAD -> REFERENCED
 * transition (inside the same transaction, immediately after the Invoice
 * update above already matched exactly one row) matches zero rows — an
 * internal invariant failure distinct from an ordinary optimistic-
 * concurrency conflict. Mapped to the public ARCHIVE_FAILED error code,
 * never CONFLICT. Never escapes this module.
 */
class LedgerTransitionInvariantError extends Error {}

export type LegacyArchiveDeps = {
  now: () => Date;
  generateArchiveId: () => string;
  resolveLogo: typeof resolveInvoiceLogo;
  render: typeof renderInvoicePdfBuffer;
  upload: typeof uploadInvoicePdfObject;
  remove: typeof removeInvoicePdfObject;
  /**
   * Internal-only test/crash-simulation boundary — called exactly once,
   * after the PDF object has been successfully uploaded and before the
   * final DB transaction opens. The production default is a no-op. This
   * is a plain dependency-injection argument, never a FormData field,
   * query parameter, environment flag, public route, or UI control — it
   * cannot be triggered by any request. Deliberately NOT wrapped in a
   * try/catch by this module, so an injected throw propagates out of
   * `archiveLegacyInvoice()` itself uncaught, exactly like a process
   * actually disappearing before its own ordinary error handling (and
   * compensation) could ever run — mirrors issue-invoice.ts's own
   * afterUploadBeforeFinalize contract exactly.
   */
  afterUploadBeforeFinalize: () => Promise<void> | void;
};

const defaultDeps: LegacyArchiveDeps = {
  now: () => new Date(),
  generateArchiveId: () => randomUUID(),
  resolveLogo: resolveInvoiceLogo,
  render: renderInvoicePdfBuffer,
  upload: uploadInvoicePdfObject,
  remove: removeInvoicePdfObject,
  afterUploadBeforeFinalize: () => {},
};

function fail(error: LegacyArchiveErrorCode): LegacyArchiveResult {
  return { ok: false, error };
}

export async function archiveLegacyInvoice(
  input: LegacyArchiveInput,
  overrides: Partial<LegacyArchiveDeps> = {},
): Promise<LegacyArchiveResult> {
  const deps: LegacyArchiveDeps = { ...defaultDeps, ...overrides };
  const { actor, invoiceId, expectedUpdatedAt } = input;

  // --- A. Authorization and early scoped read -------------------------------
  try {
    assertCanAccessPaymentDetails(actor.role);
  } catch (err) {
    if (err instanceof OrganizationSetupAccessError) return fail("FORBIDDEN");
    throw err;
  }

  if (!UUID_PATTERN.test(invoiceId)) return fail("NOT_FOUND");
  if (!isCanonicalIso(expectedUpdatedAt)) return fail("STALE_VERSION");
  const expectedDate = new Date(expectedUpdatedAt);

  const invoice = await prisma.invoice.findFirst({
    where: {
      id: invoiceId,
      organizationId: actor.organizationId,
      project: { organizationId: actor.organizationId },
      client: { organizationId: actor.organizationId },
    },
    select: {
      id: true,
      status: true,
      updatedAt: true,
      invoiceNumber: true,
      currency: true,
      amount: true,
      subtotal: true,
      discountAmount: true,
      taxAmount: true,
      discountType: true,
      discountValue: true,
      taxRatePercent: true,
      taxLabel: true,
      issueDate: true,
      dueDate: true,
      notes: true,
      documentVersion: true,
      finalizedAt: true,
      pdfStoragePath: true,
      pdfGeneratedAt: true,
      issuerSnapshot: true,
      recipientSnapshot: true,
      lineItems: {
        orderBy: { position: "asc" },
        select: { description: true, quantity: true, unitPrice: true },
      },
      project: { select: { name: true } },
      client: {
        select: {
          name: true,
          email: true,
          billingLegalName: true,
          company: true,
          taxId: true,
          streetAddress: true,
          city: true,
          state: true,
          postalCode: true,
          country: true,
        },
      },
    },
  });

  // Cross-org and nonexistent invoice ids are structurally indistinguishable
  // — the same scoped findFirst, the same NOT_FOUND result, either way.
  if (!invoice) return fail("NOT_FOUND");

  // --- The single canonical classification call for this service. ----------
  const classification = classifyInvoiceArchival(invoice);
  if (classification.kind === "draft") return fail("NOT_LEGACY_ELIGIBLE");
  if (classification.kind === "invariant_violation") return fail("INVARIANT_VIOLATION");
  if (classification.kind === "archived") {
    // Idempotent success — a repeat submission after a previously
    // committed success (or an invoice that reached "archived" via the
    // ordinary Issue pipeline) is never re-archived: no new render, no
    // new ledger row, no new Storage object, no new Activity.
    return { ok: true, outcome: "ALREADY_ARCHIVED", invoiceId: invoice.id, finalizedAt: invoice.finalizedAt! };
  }
  // Only "legacy_eligible" reaches here.

  // A structurally unreachable defensive check — classifyInvoiceArchival()
  // already returned above for a genuinely DRAFT row (kind "draft" is only
  // ever returned together with every archive field null, and "draft" was
  // already handled). This exists purely so TypeScript can narrow
  // `invoice.status` to the non-DRAFT union below without an unchecked
  // type assertion.
  if (invoice.status === "DRAFT") return fail("NOT_LEGACY_ELIGIBLE");
  const initialStatus = invoice.status;

  // Early fast-fail — avoids wasted render/upload work for a request
  // that's already doomed. The final transaction's own guarded updateMany
  // (step E) is the authoritative re-check against a race that happens
  // DURING the render/upload window below, never substituted by this
  // early check alone.
  if (invoice.updatedAt.getTime() !== expectedDate.getTime()) return fail("STALE_VERSION");

  if (!isSupportedInvoiceCurrency(invoice.currency)) return fail("UNSUPPORTED_CURRENCY");

  // A fresh binding with its own already-non-null static type — narrowing
  // from the `if (!invoice) ...` check above does not persist into the
  // nested closures declared further down (buildViewModel), since
  // TypeScript's control-flow analysis does not carry narrowing across
  // function boundaries. Mirrors issue-invoice.ts's own `draftInvoice`.
  const legacyInvoice = invoice;

  // --- B. Build immutable artifacts in memory (no DB transaction open) ------

  const calculationInput: InvoiceCalculationInput = {
    subtotalSource:
      invoice.lineItems.length > 0
        ? {
            mode: "lineItems",
            lineItems: invoice.lineItems.map((li) => ({
              description: li.description,
              quantity: li.quantity,
              unitPrice: li.unitPrice,
            })),
          }
        // Flat base is the pre-discount subtotal, never `amount` (already
        // net of discount/tax) — `amount` is only a fallback for a
        // genuinely null `subtotal`, exactly like Issue's own flat-source
        // construction.
        : { mode: "flat", amount: invoice.subtotal ?? invoice.amount },
    discount:
      invoice.discountType === "NONE"
        ? { type: "NONE" }
        : { type: invoice.discountType, value: invoice.discountValue ?? "0" },
    taxRatePercent: invoice.taxRatePercent,
  };

  const calculation = calculateInvoiceTotals(calculationInput);
  if (!calculation.ok) return fail("INVALID_FINANCIAL_STATE");
  // Same reasoning as `legacyInvoice` above — a fresh binding whose own
  // static type is already the narrowed "ok: true" variant, safe to read
  // from inside a nested closure without repeating the narrowing there.
  const successfulCalculation = calculation;

  // --- Financial-consistency gate ------------------------------------------
  // amount is the one never-silently-altered canonical fact (established by
  // the Slice 1 backfill migration's own precedent) — a fresh calculation's
  // total must exactly equal it, and any already-non-null derived field
  // (subtotal/discountAmount/taxAmount) must exactly equal its own
  // calculated counterpart. Exact Prisma.Decimal equality only, never
  // Number()/floating-point comparison. Any mismatch means the historical
  // row and a fresh, authoritative recalculation disagree — this fails
  // closed rather than silently "fixing" (or rendering a PDF that disagrees
  // with) a historical financial fact. This whole gate runs BEFORE any
  // snapshot/render/ledger/Storage work.
  if (!calculation.total.equals(invoice.amount)) return fail("INVALID_FINANCIAL_STATE");

  const subtotalWasNull = invoice.subtotal === null;
  if (invoice.subtotal !== null && !invoice.subtotal.equals(calculation.subtotal)) {
    return fail("INVALID_FINANCIAL_STATE");
  }
  const discountAmountWasNull = invoice.discountAmount === null;
  if (invoice.discountAmount !== null && !invoice.discountAmount.equals(calculation.discountAmount)) {
    return fail("INVALID_FINANCIAL_STATE");
  }
  const taxAmountWasNull = invoice.taxAmount === null;
  if (invoice.taxAmount !== null && !invoice.taxAmount.equals(calculation.taxAmount)) {
    return fail("INVALID_FINANCIAL_STATE");
  }

  const recipientSnapshot = buildRecipientSnapshotV1(invoice.client);
  const parsedRecipient = parseRecipientSnapshot(recipientSnapshot);
  if (!parsedRecipient.ok) return fail("SNAPSHOT_INVALID");
  const rendererRecipient = toRendererRecipientPresentation(parsedRecipient.snapshot);

  // Payment/company-profile data is read only after the OWNER check above —
  // getPaymentDetails() itself performs no role check of its own (see its
  // own doc comment); this is the one call site explicitly reviewed and
  // approved to read it, precisely because Legacy Archive, like Issue, is
  // OWNER-only end to end.
  const [profile, paymentDetails, organization] = await Promise.all([
    getCompanyProfile(actor.organizationId),
    getPaymentDetails(actor.organizationId),
    prisma.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { name: true } }),
  ]);

  let resolvedLogo: ResolvedInvoiceLogo;
  try {
    resolvedLogo = await deps.resolveLogo({ organizationId: actor.organizationId, logoUrl: profile.logoUrl });
  } catch {
    resolvedLogo = { provenance: { included: false, reason: "fetch_failed" }, bytes: null };
  }

  function buildIssuerSnapshot(logo: InvoiceIssuerSnapshotV1["logo"]): InvoiceIssuerSnapshotV1 {
    return buildIssuerSnapshotV1({
      organizationName: organization.name,
      profile: profile.legalName
        ? {
            legalName: profile.legalName,
            country: profile.country,
            taxId: profile.taxId,
            supportEmail: profile.supportEmail,
            phone: profile.phone,
            website: profile.website,
            brandColor: profile.brandColor,
            streetAddress: profile.streetAddress,
            city: profile.city,
            state: profile.state,
            postalCode: profile.postalCode,
          }
        : null,
      paymentDetails,
      logo,
    });
  }

  const primaryIssuerSnapshot = buildIssuerSnapshot(resolvedLogo.provenance);
  const parsedPrimaryIssuer = parseIssuerSnapshot(primaryIssuerSnapshot);
  if (!parsedPrimaryIssuer.ok) return fail("SNAPSHOT_INVALID");

  const primaryRendererIssuer = toRendererIssuerPresentation(parsedPrimaryIssuer.snapshot, resolvedLogo.bytes);
  if (!primaryRendererIssuer.ok) return fail("SNAPSHOT_INVALID");

  function buildViewModel(issuer: InvoicePdfIssuerPresentation) {
    return buildInvoicePdfViewModel({
      // The exact status this row already had at the initial read — never
      // "SENT" — a Legacy Archive PDF must be labeled with the invoice's
      // own real, unchanged status (PAID/OVERDUE/CANCELLED render
      // correctly too; only DRAFT is excluded, already ruled out above).
      documentStatus: initialStatus,
      invoiceNumber: legacyInvoice.invoiceNumber,
      issueDate: legacyInvoice.issueDate,
      dueDate: legacyInvoice.dueDate,
      currency: legacyInvoice.currency,
      calculation: successfulCalculation,
      discountType: legacyInvoice.discountType,
      discountValue: legacyInvoice.discountValue,
      taxRatePercent: legacyInvoice.taxRatePercent,
      taxLabel: legacyInvoice.taxLabel,
      notes: legacyInvoice.notes,
      issuer,
      recipient: rendererRecipient,
    });
  }

  // These are the values actually used for both rendering and persistence
  // — reassigned once, below, only if the primary render attempt fails and
  // a logo-free retry succeeds. Never two independently-built snapshot
  // sets: whichever one is used to render is exactly the one persisted.
  let issuerSnapshotForPersistence = primaryIssuerSnapshot;
  let pdfBuffer: Buffer;

  try {
    pdfBuffer = await deps.render(buildViewModel(primaryRendererIssuer.presentation));
  } catch {
    if (resolvedLogo.bytes === null) {
      // No logo was involved — a render failure here has nothing to do
      // with logo bytes, so there is nothing safe to retry.
      return fail("RENDER_FAILED");
    }

    // Defense in depth: even after logo.ts's own MIME/byte-signature
    // validation, a structurally corrupt-but-signature-passing image can
    // still make the PDF renderer itself fail. Never let that block
    // Legacy Archive — degrade to a no-logo PDF and retry exactly once.
    // Never persist provenance for bytes that never actually made it into
    // the successful PDF, and never upload the failed first render.
    const fallbackIssuerSnapshot = buildIssuerSnapshot({ included: false, reason: "invalid_content" });
    const parsedFallbackIssuer = parseIssuerSnapshot(fallbackIssuerSnapshot);
    if (!parsedFallbackIssuer.ok) return fail("SNAPSHOT_INVALID");

    const fallbackRendererIssuer = toRendererIssuerPresentation(parsedFallbackIssuer.snapshot, null);
    if (!fallbackRendererIssuer.ok) return fail("SNAPSHOT_INVALID");

    try {
      pdfBuffer = await deps.render(buildViewModel(fallbackRendererIssuer.presentation));
    } catch {
      return fail("RENDER_FAILED");
    }

    issuerSnapshotForPersistence = fallbackIssuerSnapshot;
  }

  const validation = validatePdfBuffer(pdfBuffer);
  if (!validation.ok) {
    return fail(validation.reason === "TOO_LARGE" ? "PDF_TOO_LARGE" : "RENDER_FAILED");
  }

  // The exact validated snapshot values actually used to render — the
  // durable contract persists these, never the pre-parse builder output,
  // so persistence can never silently drift from what rendering actually
  // used.
  const parsedIssuerForPersistence = parseIssuerSnapshot(issuerSnapshotForPersistence);
  if (!parsedIssuerForPersistence.ok) return fail("SNAPSHOT_INVALID");

  // No ledger row and no Storage object exist for this attempt at this
  // point — both are created only from here on.

  // --- C. Ledger before upload ------------------------------------------
  let identity: InvoicePdfObjectIdentity;
  let path: string;
  try {
    const archiveId = deps.generateArchiveId();
    // The persisted documentVersion is used exactly as-is — never assumed
    // to be 1, never incremented or rewritten by this action (this is a
    // first archival for this row, not a re-archive). buildInvoicePdfStoragePath()
    // itself throws for a non-positive-integer documentVersion, caught
    // below and mapped to ARCHIVE_FAILED before any DB write or upload is
    // ever attempted.
    identity = { organizationId: actor.organizationId, invoiceId: invoice.id, documentVersion: invoice.documentVersion, archiveId };
    path = buildInvoicePdfStoragePath(identity);
  } catch {
    return fail("ARCHIVE_FAILED");
  }

  try {
    await prisma.invoicePdfArchiveObject.create({
      data: {
        id: identity.archiveId,
        organizationId: actor.organizationId,
        invoiceId: invoice.id,
        documentVersion: invoice.documentVersion,
        storagePath: path,
        status: "PENDING_UPLOAD",
      },
    });
  } catch {
    // Ledger creation itself failed — no upload is ever attempted.
    return fail("ARCHIVE_FAILED");
  }

  // --- D. Upload ----------------------------------------------------------
  // Bounded Archival Reconciliation/Cleanup — ownership recheck immediately
  // before upload. Defense in depth against a producer that stalled between
  // ledger-row creation and this point and has since had this row claimed
  // (or already reconciled) by the reconciliation worker: the primary proof
  // that a live producer cannot still be running by the time a row becomes
  // reconciliation-eligible is SAFETY_WINDOW_MS exceeding this
  // application's own maximum Vercel Function invocation lifetime (see
  // reconcile-archive-objects.ts's own MAX_VERCEL_FUNCTION_DURATION_MS doc
  // comment) — this check does not, by itself, claim to close that TOCTOU.
  let stillOwned: { id: string } | null;
  try {
    stillOwned = await prisma.invoicePdfArchiveObject.findFirst({
      where: { id: identity.archiveId, status: "PENDING_UPLOAD", cleanupLockedAt: null, cleanupClaimToken: null },
      select: { id: true },
    });
  } catch {
    // A thrown/rejected ownership query is never allowed to propagate as a
    // raw exception — deps.upload is never called on this branch either.
    // No compensation is needed (upload was never attempted); the
    // PENDING_UPLOAD ledger row this same call already created remains
    // exactly as-is, durable evidence for a later reconciliation run.
    return fail("ARCHIVE_FAILED");
  }
  if (!stillOwned) return fail("ARCHIVE_FAILED");

  let uploadResult: InvoicePdfUploadResult;
  try {
    uploadResult = await deps.upload({ identity, body: pdfBuffer });
  } catch {
    // An upload adapter that throws/rejects is ambiguous — the write may
    // have partially completed server-side — so it is treated exactly
    // like an ordinary unsuccessful upload, never allowed to escape as a
    // raw exception.
    uploadResult = { ok: false, reason: "upload_failed" };
  }
  if (!uploadResult.ok) {
    // Upload failure can be ambiguous (a network error may have partially
    // completed server-side) — always attempt compensation rather than
    // assuming nothing was written.
    await compensateArchiveUpload(deps, identity.archiveId, identity, deps.now());
    return fail(uploadResult.reason === "storage_not_configured" ? "STORAGE_NOT_CONFIGURED" : "UPLOAD_FAILED");
  }

  // Internal-only crash-simulation boundary (see LegacyArchiveDeps's own
  // doc comment) — deliberately NOT wrapped in try/catch. Production's
  // default is a no-op; a throw here from an injected test override
  // propagates out of this function entirely uncaught. Expected residue:
  // the Invoice remains untouched, the ledger row remains PENDING_UPLOAD,
  // the uploaded object remains present — intentional evidence for the
  // later, separate reconciliation task, not a bug.
  await deps.afterUploadBeforeFinalize();

  // --- E. Final short transaction ------------------------------------------
  const now = deps.now();
  const nextUpdatedAt = new Date(Math.max(now.getTime(), expectedDate.getTime() + 1));

  type CommitOutcome = { ok: true; finalizedAt: Date } | { ok: false; error: "CONFLICT" | "ARCHIVE_FAILED" };

  let commitOutcome: CommitOutcome;
  try {
    commitOutcome = await prisma.$transaction(async (tx) => {
      const updateResult = await tx.invoice.updateMany({
        where: {
          id: invoice.id,
          organizationId: actor.organizationId,
          project: { organizationId: actor.organizationId },
          client: { organizationId: actor.organizationId },
          // The exact status this row had when the PDF was rendered —
          // never just "any non-DRAFT status" — a status change mid-
          // operation (e.g. SENT -> PAID in another tab) must conflict,
          // never silently commit a PDF labeled with a status the row no
          // longer has.
          status: initialStatus,
          updatedAt: expectedDate,
          // The full legacy_eligible predicate, re-proven atomically at
          // commit time — never relying on the earlier pre-render
          // classifier call alone. Prisma.DbNull (not a bare JS null) is
          // required for the two Json? columns to express "this column is
          // SQL NULL" rather than a stored JSON literal null.
          finalizedAt: null,
          pdfStoragePath: null,
          pdfGeneratedAt: null,
          issuerSnapshot: { equals: Prisma.DbNull },
          recipientSnapshot: { equals: Prisma.DbNull },
        },
        data: {
          finalizedAt: now,
          pdfGeneratedAt: now,
          pdfStoragePath: path,
          issuerSnapshot: parsedIssuerForPersistence.snapshot as unknown as Prisma.InputJsonValue,
          recipientSnapshot: parsedRecipient.snapshot as unknown as Prisma.InputJsonValue,
          // Conditional fill only — a field that was already non-null was
          // already proven (above) to exactly equal its own calculated
          // value, so it is deliberately left out of this data object
          // rather than rewritten with an identical value. `amount` is
          // never included here, under any condition.
          ...(subtotalWasNull ? { subtotal: calculation.subtotal } : {}),
          ...(discountAmountWasNull ? { discountAmount: calculation.discountAmount } : {}),
          ...(taxAmountWasNull ? { taxAmount: calculation.taxAmount } : {}),
          updatedAt: nextUpdatedAt,
        },
      });
      if (updateResult.count === 0) throw new LegacyArchiveConflictError();

      // Bounded Archival Reconciliation/Cleanup — cleanupLockedAt/
      // cleanupClaimToken must both be null, i.e. no reconciliation worker
      // currently holds this row's claim. If reconciliation won the race,
      // this update matches zero rows, throwing below rolls back this
      // entire transaction (including the Invoice.updateMany above), and
      // Invoice.pdfStoragePath never becomes visible.
      const ledgerUpdate = await tx.invoicePdfArchiveObject.updateMany({
        where: { id: identity.archiveId, status: "PENDING_UPLOAD", cleanupLockedAt: null, cleanupClaimToken: null },
        data: { status: "REFERENCED", referencedAt: now },
      });
      if (ledgerUpdate.count === 0) throw new LedgerTransitionInvariantError();

      // action: UPDATED, never STATUS_CHANGED — status does not change.
      // changedFields carries exactly one logical marker, never the real
      // persisted archive column names (which would render unreadably in
      // the Activity Timeline) and never any raw snapshot/billing/notes
      // value. No Notification fan-out exists for INVOICE.UPDATED today —
      // this is a staff-internal record-keeping event, not a customer-
      // facing lifecycle change.
      await createActivity(tx, {
        organizationId: actor.organizationId,
        actorId: actor.userId,
        entityType: "INVOICE",
        entityId: invoice.id,
        action: "UPDATED",
        metadata: buildInvoiceUpdatedMetadata(invoice.invoiceNumber, ["legacyArchive"], invoice.project.name, actor.userName),
      });

      return { ok: true, finalizedAt: now };
    });
  } catch (err) {
    commitOutcome = err instanceof LegacyArchiveConflictError ? { ok: false, error: "CONFLICT" } : { ok: false, error: "ARCHIVE_FAILED" };
  }

  if (!commitOutcome.ok) {
    // No Storage operation runs inside the transaction above — compensation
    // always happens out here, after it has already failed/rolled back.
    await compensateArchiveUpload(deps, identity.archiveId, identity, deps.now());
    return fail(commitOutcome.error);
  }

  // No post-commit delivery step exists for this action — unlike Issue,
  // Legacy Archive never sends email and never has a deliverEmails
  // dependency.
  return { ok: true, outcome: "ARCHIVED", invoiceId: invoice.id, finalizedAt: commitOutcome.finalizedAt };
}
