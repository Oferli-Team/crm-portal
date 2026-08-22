import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { assertCanAccessPaymentDetails, OrganizationSetupAccessError } from "@/lib/organization-setup/authorization";
import { getCompanyProfile } from "@/lib/organization-setup/company-profile";
import { getPaymentDetails } from "@/lib/organization-setup/payment-details";
import { createActivity } from "@/lib/activity/create-activity";
import { buildInvoiceStatusChangedMetadata } from "@/lib/activity/invoice-metadata";
import { deliverNotificationEmails } from "@/lib/notifications/email/deliver-notification-email";
import { calculateInvoiceTotals, type InvoiceCalculationInput } from "@/lib/invoices/calculations";
import type { IssueInvoiceInput, IssueInvoiceResult, IssueInvoiceErrorCode } from "@/lib/invoices/lifecycle";
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
 * Invoice System Official Slice 3, sub-PR 3b — the authoritative, OWNER-only
 * DRAFT -> SENT Issue/finalization service. Section references below are
 * this sub-PR's own implementation prompt.
 *
 * TRUSTED BOUNDARY: `input.actor` must be built entirely from server-side
 * session/membership resolution (getCurrentMembership()) by the caller (the
 * Server Action) — nothing here ever reads a cookie, header, or FormData
 * value itself. OWNER access is independently re-checked here regardless of
 * what the Server Action already verified (§7's own "never rely only on
 * hidden UI").
 *
 * NEVER RETURNED: pdfStoragePath, the Storage bucket name, raw
 * database/Storage errors, snapshot contents, or PDF bytes — see
 * IssueInvoiceResult's own definition in lifecycle.ts for the complete
 * closed result shape.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isCanonicalIso(raw: string): boolean {
  const date = new Date(raw);
  return !Number.isNaN(date.getTime()) && date.toISOString() === raw;
}

/**
 * Thrown only when the final transaction's own guarded Invoice update
 * matches zero rows — a genuine optimistic-concurrency conflict (a
 * concurrent edit, delete, or a second simultaneous Issue attempt won the
 * race). Mapped to the public CONFLICT error code. Never escapes this
 * module.
 */
class InvoiceUpdateConflictError extends Error {}

/**
 * Thrown only when the guarded ledger PENDING_UPLOAD -> REFERENCED
 * transition (inside the same transaction, immediately after the Invoice
 * update above already matched exactly one row) matches zero rows — an
 * internal invariant failure distinct from an ordinary optimistic-
 * concurrency conflict (the ledger row this same request created moments
 * earlier is not in the state this request itself left it in). Mapped to
 * the public FINALIZATION_FAILED error code, never CONFLICT. Never escapes
 * this module.
 */
class LedgerTransitionInvariantError extends Error {}

export type IssueInvoiceDeps = {
  now: () => Date;
  generateArchiveId: () => string;
  resolveLogo: typeof resolveInvoiceLogo;
  render: typeof renderInvoicePdfBuffer;
  upload: typeof uploadInvoicePdfObject;
  remove: typeof removeInvoicePdfObject;
  deliverEmails: typeof deliverNotificationEmails;
  /**
   * Internal-only test/crash-simulation boundary — called exactly once,
   * after the PDF object has been successfully uploaded and before the
   * final DB transaction opens. The production default is a no-op. This
   * is a plain dependency-injection argument, never a FormData field,
   * query parameter, environment flag, public route, or UI control — it
   * cannot be triggered by any request. An integration test that wants to
   * model a real process crash at this exact boundary injects an override
   * that throws; deliberately NOT wrapped in a try/catch by this module,
   * so that throw propagates out of `issueInvoice()` itself uncaught,
   * exactly like a process actually disappearing before its own ordinary
   * error handling (and compensation) could ever run.
   */
  afterUploadBeforeFinalize: () => Promise<void> | void;
};

const defaultDeps: IssueInvoiceDeps = {
  now: () => new Date(),
  generateArchiveId: () => randomUUID(),
  resolveLogo: resolveInvoiceLogo,
  render: renderInvoicePdfBuffer,
  upload: uploadInvoicePdfObject,
  remove: removeInvoicePdfObject,
  deliverEmails: deliverNotificationEmails,
  afterUploadBeforeFinalize: () => {},
};

function fail(error: IssueInvoiceErrorCode): IssueInvoiceResult {
  return { ok: false, error };
}

export async function issueInvoice(
  input: IssueInvoiceInput,
  overrides: Partial<IssueInvoiceDeps> = {},
): Promise<IssueInvoiceResult> {
  const deps: IssueInvoiceDeps = { ...defaultDeps, ...overrides };
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
      discountType: true,
      discountValue: true,
      taxRatePercent: true,
      taxLabel: true,
      issueDate: true,
      dueDate: true,
      notes: true,
      documentVersion: true,
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
  if (invoice.status !== "DRAFT") return fail("NOT_DRAFT");
  // Early fast-fail — avoids wasted render/upload work for a request that's
  // already doomed. The final transaction's own guarded updateMany (step E)
  // is the authoritative re-check against a race that happens DURING the
  // render/upload window below, never substituted by this early check alone.
  if (invoice.updatedAt.getTime() !== expectedDate.getTime()) return fail("STALE_VERSION");

  // A fresh binding with its own already-non-null static type — narrowing
  // from the `if (!invoice) ...` check above does not persist into the
  // nested closures declared further down (buildViewModel), since
  // TypeScript's control-flow analysis does not carry narrowing across
  // function boundaries. This `const` sidesteps that entirely rather than
  // repeating a non-null assertion at every closure call site.
  const draftInvoice = invoice;

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
        // genuinely null `subtotal`, which Slice 1's own migration defines
        // as equal to `amount` for exactly that legacy case.
        : { mode: "flat", amount: invoice.subtotal ?? invoice.amount },
    discount:
      invoice.discountType === "NONE"
        ? { type: "NONE" }
        : { type: invoice.discountType, value: invoice.discountValue ?? "0" },
    taxRatePercent: invoice.taxRatePercent,
  };

  const calculation = calculateInvoiceTotals(calculationInput);
  if (!calculation.ok) return fail("SNAPSHOT_INVALID");
  // Same reasoning as `draftInvoice` above — a fresh binding whose own
  // static type is already the narrowed "ok: true" variant, safe to read
  // from inside a nested closure without repeating the narrowing there.
  const successfulCalculation = calculation;

  const recipientSnapshot = buildRecipientSnapshotV1(invoice.client);
  const parsedRecipient = parseRecipientSnapshot(recipientSnapshot);
  if (!parsedRecipient.ok) return fail("SNAPSHOT_INVALID");
  const rendererRecipient = toRendererRecipientPresentation(parsedRecipient.snapshot);

  // Payment/company-profile data is read only after the OWNER check above —
  // getPaymentDetails() itself performs no role check of its own (see its
  // own doc comment); this is the one call site explicitly reviewed and
  // approved to read it, precisely because Issue is OWNER-only end to end.
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
      documentStatus: "SENT",
      invoiceNumber: draftInvoice.invoiceNumber,
      issueDate: draftInvoice.issueDate,
      dueDate: draftInvoice.dueDate,
      currency: draftInvoice.currency,
      calculation: successfulCalculation,
      discountType: draftInvoice.discountType,
      discountValue: draftInvoice.discountValue,
      taxRatePercent: draftInvoice.taxRatePercent,
      taxLabel: draftInvoice.taxLabel,
      notes: draftInvoice.notes,
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
    // Issue — degrade to a no-logo PDF and retry exactly once. Never
    // persist provenance for bytes that never actually made it into the
    // successful PDF, and never upload the failed first render.
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
    identity = { organizationId: actor.organizationId, invoiceId: invoice.id, documentVersion: invoice.documentVersion, archiveId };
    path = buildInvoicePdfStoragePath(identity);
  } catch {
    // A malformed generated archive identity (or a path-construction
    // failure derived from it) is caught before any DB write or upload is
    // ever attempted — no partial ledger row, no partial Storage object.
    return fail("FINALIZATION_FAILED");
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
    return fail("FINALIZATION_FAILED");
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
    return fail("FINALIZATION_FAILED");
  }
  if (!stillOwned) return fail("FINALIZATION_FAILED");

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

  // Internal-only crash-simulation boundary (see IssueInvoiceDeps's own
  // doc comment) — deliberately NOT wrapped in try/catch. Production's
  // default is a no-op; a throw here from an injected test override
  // propagates out of this function entirely uncaught.
  await deps.afterUploadBeforeFinalize();

  // --- E. Final short transaction ------------------------------------------
  const now = deps.now();
  const nextUpdatedAt = new Date(Math.max(now.getTime(), expectedDate.getTime() + 1));

  type CommitOutcome = { ok: true; finalizedAt: Date; notificationIds: string[] } | { ok: false; error: "CONFLICT" | "FINALIZATION_FAILED" };

  let commitOutcome: CommitOutcome;
  try {
    commitOutcome = await prisma.$transaction(async (tx) => {
      const updateResult = await tx.invoice.updateMany({
        where: {
          id: invoice.id,
          organizationId: actor.organizationId,
          project: { organizationId: actor.organizationId },
          client: { organizationId: actor.organizationId },
          status: "DRAFT",
          updatedAt: expectedDate,
        },
        data: {
          status: "SENT",
          finalizedAt: now,
          pdfGeneratedAt: now,
          pdfStoragePath: path,
          issuerSnapshot: parsedIssuerForPersistence.snapshot as unknown as Prisma.InputJsonValue,
          recipientSnapshot: parsedRecipient.snapshot as unknown as Prisma.InputJsonValue,
          subtotal: calculation.subtotal,
          discountAmount: calculation.discountAmount,
          taxAmount: calculation.taxAmount,
          amount: calculation.total,
          updatedAt: nextUpdatedAt,
        },
      });
      if (updateResult.count === 0) throw new InvoiceUpdateConflictError();

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

      const activity = await createActivity(tx, {
        organizationId: actor.organizationId,
        actorId: actor.userId,
        entityType: "INVOICE",
        entityId: invoice.id,
        action: "STATUS_CHANGED",
        metadata: buildInvoiceStatusChangedMetadata(
          { invoiceNumber: invoice.invoiceNumber },
          invoice.project.name,
          "DRAFT",
          "SENT",
          actor.userName,
        ),
      });

      return { ok: true, finalizedAt: now, notificationIds: activity.notificationIds };
    });
  } catch (err) {
    commitOutcome = err instanceof InvoiceUpdateConflictError ? { ok: false, error: "CONFLICT" } : { ok: false, error: "FINALIZATION_FAILED" };
  }

  if (!commitOutcome.ok) {
    // No Storage operation runs inside the transaction above — compensation
    // always happens out here, after it has already failed/rolled back.
    await compensateArchiveUpload(deps, identity.archiveId, identity, deps.now());
    return fail(commitOutcome.error);
  }

  // --- G. Post-commit delivery ----------------------------------------------
  // The real deliverNotificationEmails() is documented to never throw (see
  // its own header comment) — but an injected `deps.deliverEmails` must
  // never be trusted to uphold that either (the exact same reasoning
  // retry-notification-deliveries.ts's own sendEmail try/catch already
  // applies). The Invoice is already finalized at this point; a delivery
  // failure must never surface as an Issue failure.
  try {
    await deps.deliverEmails(commitOutcome.notificationIds);
  } catch {
    // Best-effort — swallowed. The finalized Invoice is already committed.
  }

  return { ok: true, invoiceId: invoice.id, finalizedAt: commitOutcome.finalizedAt };
}
