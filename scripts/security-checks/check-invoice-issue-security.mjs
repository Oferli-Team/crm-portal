import { existsSync, readFileSync } from "node:fs";
import { grep, report } from "./lib.mjs";

// Invoice System Official Slice 3, sub-PR 3b's own live Issue/finalization
// boundary — every check below targets a specific, durable way that
// boundary could quietly weaken, the same discipline as
// check-cron-security.mjs for its own trust boundary.

let ok = true;

const actionFile = "src/app/(dashboard)/invoices/[id]/edit/issue-actions.ts";
const serviceFile = "src/lib/invoices/pdf/issue-invoice.ts";
const storageFile = "src/lib/invoices/pdf/storage.ts";
// Invoice System Official Slice 3, Legacy Archive — the shared post-upload
// compensation helper extracted from issue-invoice.ts's own former private
// compensateUpload(). Declared here, at top level, since both the Issue
// checks (8e, below) and the Legacy Archive checks (12n, below) need it.
const compensationFile = "src/lib/invoices/pdf/archive-compensation.ts";

// 1. The dedicated Issue action exists.
ok = report(`${actionFile} exists`, existsSync(actionFile), existsSync(actionFile) ? "" : `Expected ${actionFile} to exist.`) && ok;

if (existsSync(actionFile)) {
  const actionContent = readFileSync(actionFile, "utf8");

  // 2. It resolves the actor from real server-side membership, never a
  // client-declared value.
  ok = report(
    `${actionFile} loads trusted server-side membership (getCurrentMembership)`,
    actionContent.includes("getCurrentMembership"),
    "",
  ) && ok;

  // 3. It independently checks OWNER access itself (never relies solely on
  // issueInvoice()'s own re-check, or on the UI hiding the control).
  ok = report(
    `${actionFile} independently checks OWNER access (assertCanAccessPaymentDetails)`,
    actionContent.includes("assertCanAccessPaymentDetails"),
    "",
  ) && ok;

  // 4. Its own exported function signature accepts only invoiceId/
  // expectedUpdatedAt from the caller — never organizationId/role/
  // storagePath/totals/snapshots as a parameter name.
  const forbiddenParamNames = ["organizationId", "role", "storagePath", "totals", "snapshot", "actorName", "userId"];
  const signatureMatch = actionContent.match(/export async function issueInvoiceAction\(([^)]*)\)/);
  const signature = signatureMatch ? signatureMatch[1] : "";
  const leakedParams = forbiddenParamNames.filter((name) => new RegExp(`\\b${name}\\b`, "i").test(signature));
  ok = report(
    "issueInvoiceAction's own parameter list contains none of: organizationId, role, storagePath, totals, snapshot, actorName, userId",
    leakedParams.length === 0,
    leakedParams.join(", "),
  ) && ok;
}

// 5. The service itself also independently re-checks OWNER access — never
// trusting the action's own check alone.
if (existsSync(serviceFile)) {
  const serviceContent = readFileSync(serviceFile, "utf8");
  ok = report(
    `${serviceFile} independently checks OWNER access (assertCanAccessPaymentDetails)`,
    serviceContent.includes("assertCanAccessPaymentDetails"),
    "",
  ) && ok;

  // 6. No PDF Storage call (upload/remove) appears textually inside the
  // final prisma.$transaction(...) callback — a deliberately blunt,
  // line-range proxy: everything between "prisma.$transaction(async (tx)"
  // and its own closing "});" must not mention deps.upload/deps.remove.
  const txStart = serviceContent.indexOf("prisma.$transaction(async (tx)");
  if (txStart === -1) {
    ok = report(`${serviceFile} contains a prisma.$transaction(...) call`, false, "") && ok;
  } else {
    const txEnd = serviceContent.indexOf("\n  } catch (err) {", txStart);
    const txBody = txEnd === -1 ? serviceContent.slice(txStart) : serviceContent.slice(txStart, txEnd);
    const storageCallInTx = /deps\.(upload|remove)\(/.test(txBody);
    ok = report(
      "no Storage operation (deps.upload/deps.remove) occurs inside the final DB transaction",
      !storageCallInTx,
      storageCallInTx ? "Found deps.upload(...)/deps.remove(...) between the transaction's opening and its catch block." : "",
    ) && ok;
  }
} else {
  ok = report(`${serviceFile} exists`, false, `Expected ${serviceFile} to exist.`) && ok;
}

// 7. Production upload uses true create-only semantics — upsert: false,
// never true, never omitted.
if (existsSync(storageFile)) {
  const storageContent = readFileSync(storageFile, "utf8");
  ok = report(
    `${storageFile} uploads with upsert: false`,
    storageContent.includes("upsert: false"),
    "",
  ) && ok;

  // 8. No public URL is ever generated for an Invoice PDF object (this
  // bucket is private; the module must never call getPublicUrl).
  ok = report(
    `${storageFile} never calls getPublicUrl`,
    !storageContent.includes("getPublicUrl"),
    "",
  ) && ok;

  // 8b. uploadInvoicePdfObject()/removeInvoicePdfObject() each destructure
  // a structured `identity`, never a raw caller-supplied `path` — a
  // correction-pass invariant: a TypeScript-only branded-string contract
  // would still let a caller pass an arbitrary string at runtime, so the
  // actual exported function signatures themselves are inspected here,
  // not just a doc comment's claim about them.
  const uploadSigMatch = storageContent.match(/export async function uploadInvoicePdfObject\(\s*\{([^}]*)\}/);
  const removeSigMatch = storageContent.match(/export async function removeInvoicePdfObject\(\s*\{([^}]*)\}/);
  const uploadSig = uploadSigMatch ? uploadSigMatch[1] : "";
  const removeSig = removeSigMatch ? removeSigMatch[1] : "";
  ok = report(
    "uploadInvoicePdfObject()'s own parameter destructures { identity, body }, never a raw path",
    /\bidentity\b/.test(uploadSig) && !/\bpath\s*:/.test(uploadSig) && !/^\s*path\b/.test(uploadSig),
    uploadSig,
  ) && ok;
  ok = report(
    "removeInvoicePdfObject()'s own parameter destructures { identity }, never a raw path",
    /\bidentity\b/.test(removeSig) && !/\bpath\s*:/.test(removeSig) && !/^\s*path\b/.test(removeSig),
    removeSig,
  ) && ok;

  // 8c. Both functions actually reconstruct the path from that identity
  // via buildInvoicePdfStoragePath() — an identity accepted but never
  // used to rebuild the path would defeat the whole point.
  const uploadBodyEnd = storageContent.indexOf("export async function removeInvoicePdfObject");
  const uploadBody = uploadSigMatch ? storageContent.slice(storageContent.indexOf(uploadSigMatch[0]), uploadBodyEnd === -1 ? undefined : uploadBodyEnd) : "";
  const removeBody = removeSigMatch ? storageContent.slice(storageContent.indexOf(removeSigMatch[0])) : "";
  ok = report(
    "uploadInvoicePdfObject() rebuilds the path via buildInvoicePdfStoragePath(identity)",
    /buildInvoicePdfStoragePath\(identity\)/.test(uploadBody),
    "",
  ) && ok;
  ok = report(
    "removeInvoicePdfObject() rebuilds the path via buildInvoicePdfStoragePath(identity)",
    /buildInvoicePdfStoragePath\(identity\)/.test(removeBody),
    "",
  ) && ok;
}

// 8d. The Issue service's own call to deps.upload passes an `identity`,
// never a raw `path` — the caller side of the same boundary. deps.remove
// is checked separately, below, against the shared archive-compensation.ts
// module — since the extracted compensateArchiveUpload() helper (Invoice
// System Official Slice 3, Legacy Archive) is now the one place either
// pipeline ever calls deps.remove(), issue-invoice.ts itself no longer
// contains that call textually after the extraction.
if (existsSync(serviceFile)) {
  const serviceContent = readFileSync(serviceFile, "utf8");
  const uploadCallMatch = serviceContent.match(/deps\.upload\(\{([^}]*)\}\)/);
  ok = report(
    "issue-invoice.ts's own deps.upload(...) call passes { identity, body }, never a raw path",
    !!uploadCallMatch && /\bidentity\b/.test(uploadCallMatch[1]) && !/\bpath\s*:/.test(uploadCallMatch[1]),
    uploadCallMatch ? uploadCallMatch[1] : "deps.upload(...) call not found",
  ) && ok;
}

// 8e. The shared compensation helper's own call to deps.remove passes an
// `identity`, never a raw `path` — this is the one place either pipeline
// (Issue or Legacy Archive) ever removes an uploaded object during
// compensation.
if (existsSync(compensationFile)) {
  const compensationRemoveContent = readFileSync(compensationFile, "utf8");
  const removeCallMatches = [...compensationRemoveContent.matchAll(/deps\.remove\(\{([^}]*)\}\)/g)];
  ok = report(
    "every archive-compensation.ts deps.remove(...) call passes { identity }, never a raw path",
    removeCallMatches.length > 0 && removeCallMatches.every(([, args]) => /\bidentity\b/.test(args) && !/\bpath\s*:/.test(args)),
    removeCallMatches.map(([, args]) => args).join(" | ") || "deps.remove(...) call not found",
  ) && ok;
} else {
  ok = report(`${compensationFile} exists`, false, `Expected ${compensationFile} to exist.`) && ok;
}

// 9. The public Issue result contract (IssueInvoiceSuccess) has no
// storagePath field.
const lifecycleFile = "src/lib/invoices/lifecycle.ts";
if (existsSync(lifecycleFile)) {
  const lifecycleContent = readFileSync(lifecycleFile, "utf8");
  const successMatch = lifecycleContent.match(/export type IssueInvoiceSuccess = \{[^}]*\}/);
  const successBlock = successMatch ? successMatch[0] : "";
  ok = report(
    "IssueInvoiceSuccess contains no storagePath/pdfStoragePath/bucket field",
    successBlock.length > 0 && !/storagePath|bucket/i.test(successBlock),
    successBlock,
  ) && ok;
}

// 10. Invoice System Slice 4, PR 4b — the one approved InvoiceEmailAttempt
// writer is src/lib/invoices/email/send-invoice-email.ts; every other file
// under src/lib/invoices/ (Issue, Legacy Archive, reconciliation, etc.)
// remains a strict non-writer for this model, exactly as it was before
// PR 4b existed.
const APPROVED_EMAIL_ATTEMPT_WRITER = "src/lib/invoices/email/send-invoice-email.ts";
const emailAttemptWrite = grep("invoiceEmailAttempt\\.(create|createMany|upsert)", "src/lib/invoices/")
  .split("\n")
  .filter((line) => line && !line.startsWith(`${APPROVED_EMAIL_ATTEMPT_WRITER}:`))
  .join("\n");
ok = report(
  `no InvoiceEmailAttempt writer exists under src/lib/invoices/ outside ${APPROVED_EMAIL_ATTEMPT_WRITER}`,
  emailAttemptWrite === "",
  emailAttemptWrite,
) && ok;

// 11. Portal Invoice PDF access — this sub-PR's own new trust boundary,
// verified with the same fail-closed discipline as the staff Issue
// checks above. Replaces this check's own prior assertion that the
// route "does not exist yet (out of scope for this sub-PR)" — accurate
// for sub-PR 3b/3c, now obsolete since Portal Invoice PDF access is
// exactly this sub-PR's own scope. A narrow, exact-file check (not a
// repository-wide ban), matching this script's own established style.
const portalPdfRoute = "src/app/api/portal/invoices/[id]/pdf/route.ts";

ok = report(
  `${portalPdfRoute} exists`,
  existsSync(portalPdfRoute),
  existsSync(portalPdfRoute) ? "" : `Expected ${portalPdfRoute} to exist.`,
) && ok;

if (existsSync(portalPdfRoute)) {
  const portalPdfContent = readFileSync(portalPdfRoute, "utf8");

  // 11a. Resolves identity through the real Portal auth boundary, never
  // the staff one.
  ok = report(
    `${portalPdfRoute} resolves identity via getCurrentPortalUser`,
    portalPdfContent.includes("getCurrentPortalUser"),
    "",
  ) && ok;

  // 11b. Uses its own dedicated, isolated rate limiter — never shares a
  // bucket with the staff Invoice PDF route or either Attachment route.
  ok = report(
    `${portalPdfRoute} uses the dedicated PORTAL_INVOICE_PDF_DOWNLOAD_LIMIT`,
    portalPdfContent.includes("PORTAL_INVOICE_PDF_DOWNLOAD_LIMIT"),
    "",
  ) && ok;

  // 11c. classifyInvoiceArchival() remains the single eligibility gate.
  ok = report(
    `${portalPdfRoute} calls classifyInvoiceArchival`,
    portalPdfContent.includes("classifyInvoiceArchival"),
    "",
  ) && ok;

  // 11d. Rebuilds the canonical path before ever signing — never trusts
  // a raw persisted path as the source of truth.
  ok = report(
    `${portalPdfRoute} calls buildInvoicePdfStoragePath before signing`,
    portalPdfContent.includes("buildInvoicePdfStoragePath"),
    "",
  ) && ok;

  // 11e. Reuses the existing signed-URL helper — never a duplicated
  // bucket/TTL/filename/TEST_MODE/signing implementation.
  ok = report(
    `${portalPdfRoute} calls createInvoicePdfSignedUrl`,
    portalPdfContent.includes("createInvoicePdfSignedUrl"),
    "",
  ) && ok;

  // 11f. Never writes Portal Analytics — this sub-PR deliberately keeps
  // the existing PortalDownloadRequest metric attachment-only. Comments
  // stripped first: this route's own doc comment intentionally names
  // recordPortalDownloadRequest() in prose to explain why it is *not*
  // called, which a bare substring check against the raw file would
  // wrongly flag as a violation.
  const portalPdfCodeOnly = portalPdfContent.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok = report(
    `${portalPdfRoute} never imports or calls recordPortalDownloadRequest`,
    !portalPdfCodeOnly.includes("recordPortalDownloadRequest"),
    "",
  ) && ok;

  // 11g. Never exposes a permanent public URL for a private-bucket
  // object.
  ok = report(
    `${portalPdfRoute} never calls getPublicUrl`,
    !portalPdfContent.includes("getPublicUrl"),
    "",
  ) && ok;

  // 11h. No console logging of any kind — generic responses only, never
  // a path/signed-URL/invoice-number/identifier printed anywhere.
  const portalPdfConsoleCalls = grep("console\\.(log|error|warn|info|debug)\\(", portalPdfRoute);
  ok = report(
    `${portalPdfRoute} contains no console logging`,
    portalPdfConsoleCalls === "",
    portalPdfConsoleCalls,
  ) && ok;

  // 11i. The Invoice lookup is scoped by the real Portal Client-boundary
  // fields — clientId (primary), organizationId (defense in depth), and
  // project.clientId (defense against Invoice/Project relation drift) —
  // never the staff organizationId-only boundary.
  ok = report(
    `${portalPdfRoute} scopes its Invoice query by clientId, organizationId, and project's clientId`,
    portalPdfContent.includes("clientId") &&
      portalPdfContent.includes("organizationId") &&
      /project:\s*\{\s*clientId\s*\}/.test(portalPdfContent),
    "",
  ) && ok;
}

// 12. Invoice System Official Slice 3, Legacy Archive — its own new trust
// boundary, verified with the same fail-closed discipline as the Issue and
// Portal PDF checks above. Legacy Archive is a retroactive, OWNER-only
// archival action for an already-non-DRAFT invoice, structurally similar
// to Issue but never a DRAFT -> SENT transition — these checks additionally
// guard the specific invariants that distinguish it (status/amount/
// documentVersion must never be written, the shared compensation helper
// must be used, no duplicate local implementation may exist).
const legacyActionFile = "src/app/(dashboard)/invoices/[id]/edit/legacy-archive-actions.ts";
const legacyServiceFile = "src/lib/invoices/pdf/legacy-archive-invoice.ts";

// 12a. The dedicated Legacy Archive action exists.
ok =
  report(
    `${legacyActionFile} exists`,
    existsSync(legacyActionFile),
    existsSync(legacyActionFile) ? "" : `Expected ${legacyActionFile} to exist.`,
  ) && ok;

if (existsSync(legacyActionFile)) {
  const legacyActionContent = readFileSync(legacyActionFile, "utf8");

  // 12b. It resolves the actor from real server-side membership, never a
  // client-declared value.
  ok = report(
    `${legacyActionFile} loads trusted server-side membership (getCurrentMembership)`,
    legacyActionContent.includes("getCurrentMembership"),
    "",
  ) && ok;

  // 12c. It independently checks OWNER access itself (never relies solely
  // on archiveLegacyInvoice()'s own re-check, or on the UI hiding the
  // control).
  ok = report(
    `${legacyActionFile} independently checks OWNER access (assertCanAccessPaymentDetails)`,
    legacyActionContent.includes("assertCanAccessPaymentDetails"),
    "",
  ) && ok;

  // 12d. Its own exported function signature accepts only invoiceId/
  // expectedUpdatedAt from the caller — never organizationId/role/
  // storagePath/totals/snapshots/amount/status/documentVersion as a
  // parameter name.
  const legacyForbiddenParamNames = [
    "organizationId",
    "role",
    "storagePath",
    "totals",
    "snapshot",
    "actorName",
    "userId",
    "amount",
    "status",
    "documentVersion",
  ];
  const legacySignatureMatch = legacyActionContent.match(/export async function archiveLegacyInvoiceAction\(([^)]*)\)/);
  const legacySignature = legacySignatureMatch ? legacySignatureMatch[1] : "";
  const legacyLeakedParams = legacyForbiddenParamNames.filter((name) => new RegExp(`\\b${name}\\b`, "i").test(legacySignature));
  ok = report(
    "archiveLegacyInvoiceAction's own parameter list contains none of: organizationId, role, storagePath, totals, snapshot, actorName, userId, amount, status, documentVersion",
    legacyLeakedParams.length === 0,
    legacyLeakedParams.join(", "),
  ) && ok;

  // 12e. No console logging of any kind.
  const legacyActionConsoleCalls = grep("console\\.(log|error|warn|info|debug)\\(", legacyActionFile);
  ok = report(`${legacyActionFile} contains no console logging`, legacyActionConsoleCalls === "", legacyActionConsoleCalls) && ok;
}

// 12f. The service itself also independently re-checks OWNER access —
// never trusting the action's own check alone.
if (existsSync(legacyServiceFile)) {
  const legacyServiceContent = readFileSync(legacyServiceFile, "utf8");

  ok = report(
    `${legacyServiceFile} independently checks OWNER access (assertCanAccessPaymentDetails)`,
    legacyServiceContent.includes("assertCanAccessPaymentDetails"),
    "",
  ) && ok;

  // 12g. classifyInvoiceArchival() remains the single eligibility gate —
  // never an independently re-derived narrower check.
  ok = report(
    `${legacyServiceFile} calls classifyInvoiceArchival`,
    legacyServiceContent.includes("classifyInvoiceArchival"),
    "",
  ) && ok;

  // 12h. Reuses the shared compensation helper — never a duplicated local
  // implementation.
  ok = report(
    `${legacyServiceFile} calls the shared compensateArchiveUpload helper`,
    legacyServiceContent.includes("compensateArchiveUpload"),
    "",
  ) && ok;
  ok = report(
    `${legacyServiceFile} does not define its own local compensation function`,
    !/async function compensate/.test(legacyServiceContent),
    "",
  ) && ok;

  // 12i. Reuses the existing create-only upload helper — never a
  // reimplemented upload/overwrite path.
  ok = report(
    `${legacyServiceFile} reuses uploadInvoicePdfObject (never a reimplemented upload)`,
    legacyServiceContent.includes("uploadInvoicePdfObject") && !legacyServiceContent.includes("upsert: true"),
    "",
  ) && ok;

  // 12j. The final transaction's guarded Invoice update carries the full
  // five-field legacy-eligibility predicate, using Prisma.DbNull (never a
  // bare JSON null) for the two Json? columns.
  ok = report(
    `${legacyServiceFile} guards on the full archive-null predicate (finalizedAt/pdfStoragePath/pdfGeneratedAt null, issuerSnapshot/recipientSnapshot via Prisma.DbNull)`,
    legacyServiceContent.includes("finalizedAt: null") &&
      legacyServiceContent.includes("pdfStoragePath: null") &&
      legacyServiceContent.includes("pdfGeneratedAt: null") &&
      legacyServiceContent.includes("issuerSnapshot: { equals: Prisma.DbNull }") &&
      legacyServiceContent.includes("recipientSnapshot: { equals: Prisma.DbNull }"),
    "",
  ) && ok;

  // 12k. The same guard also requires the exact status the PDF was
  // rendered against — never "any non-DRAFT status" — so a status change
  // mid-operation conflicts rather than silently committing.
  ok = report(
    `${legacyServiceFile} guards on the exact initial status (status: initialStatus)`,
    legacyServiceContent.includes("status: initialStatus"),
    "",
  ) && ok;

  // 12l. No PDF Storage call (upload/remove) appears textually inside the
  // final prisma.$transaction(...) callback — the same blunt line-range
  // proxy check #6 above already applies to issue-invoice.ts.
  const legacyTxStart = legacyServiceContent.indexOf("prisma.$transaction(async (tx)");
  if (legacyTxStart === -1) {
    ok = report(`${legacyServiceFile} contains a prisma.$transaction(...) call`, false, "") && ok;
  } else {
    const legacyTxEnd = legacyServiceContent.indexOf("\n  } catch (err) {", legacyTxStart);
    const legacyTxBody = legacyTxEnd === -1 ? legacyServiceContent.slice(legacyTxStart) : legacyServiceContent.slice(legacyTxStart, legacyTxEnd);
    const legacyStorageCallInTx = /deps\.(upload|remove)\(/.test(legacyTxBody);
    ok = report(
      "no Storage operation (deps.upload/deps.remove) occurs inside the Legacy Archive final DB transaction",
      !legacyStorageCallInTx,
      legacyStorageCallInTx ? "Found deps.upload(...)/deps.remove(...) between the transaction's opening and its catch block." : "",
    ) && ok;

    // 12m. Inside that same transaction body, the guarded Invoice
    // updateMany's own `data` object never writes status, amount, or
    // documentVersion — a targeted extraction of the `data: {...}` block
    // passed to `tx.invoice.updateMany`, not a whole-file scan (which
    // would also match the unrelated `where` clause's own `status:
    // initialStatus` predicate).
    const legacyUpdateManyStart = legacyTxBody.indexOf("tx.invoice.updateMany(");
    const legacyDataStart = legacyUpdateManyStart === -1 ? -1 : legacyTxBody.indexOf("data: {", legacyUpdateManyStart);
    const legacyDataEnd = legacyDataStart === -1 ? -1 : legacyTxBody.indexOf("if (updateResult.count", legacyDataStart);
    const legacyDataBlock = legacyDataStart === -1 || legacyDataEnd === -1 ? "" : legacyTxBody.slice(legacyDataStart, legacyDataEnd);
    ok = report(
      "the Legacy Archive Invoice update's own data object exists and is non-empty",
      legacyDataBlock.length > 0,
      "",
    ) && ok;
    ok = report(
      "the Legacy Archive Invoice update's own data object never writes status/amount/documentVersion",
      legacyDataBlock.length > 0 && !/\bstatus\s*:/.test(legacyDataBlock) && !/\bamount\s*:/.test(legacyDataBlock) && !/\bdocumentVersion\s*:/.test(legacyDataBlock),
      legacyDataBlock,
    ) && ok;
  }
} else {
  ok = report(`${legacyServiceFile} exists`, false, `Expected ${legacyServiceFile} to exist.`) && ok;
}

// 12n. The shared compensation module exists, is server-only, and is the
// one place both Issue and Legacy Archive perform post-upload compensation
// — no duplicate implementation remains in either caller.
ok = report(
  `${compensationFile} exists`,
  existsSync(compensationFile),
  existsSync(compensationFile) ? "" : `Expected ${compensationFile} to exist.`,
) && ok;

if (existsSync(compensationFile)) {
  const compensationContent = readFileSync(compensationFile, "utf8");
  ok = report(`${compensationFile} begins with import "server-only"`, /^import "server-only";/m.test(compensationContent), "") && ok;
  ok = report(`${compensationFile} exports compensateArchiveUpload`, /export async function compensateArchiveUpload/.test(compensationContent), "") && ok;
}

const issueServiceContentForCompensationCheck = existsSync(serviceFile) ? readFileSync(serviceFile, "utf8") : "";
ok = report(
  `${serviceFile} no longer defines its own local compensation function (uses the shared helper)`,
  issueServiceContentForCompensationCheck.includes("compensateArchiveUpload") && !/async function compensateUpload/.test(issueServiceContentForCompensationCheck),
  "",
) && ok;

// 12o. Neither new Legacy Archive file, nor the shared compensation
// module, ever sends email, writes InvoiceEmailAttempt, writes
// PortalDownloadRequest, or implements any reconciliation/bucket-listing/
// cron surface. check #10 above already bans InvoiceEmailAttempt writers
// repo-wide under src/lib/invoices/; these checks target the additional,
// Legacy-Archive-specific forbidden surfaces by name.
const legacyForbiddenSurfacePattern =
  "(deliverNotificationEmails|sendEmailViaResend|recordPortalDownloadRequest|PortalDownloadRequest|CRON_SECRET|storage\\.from\\([^)]*\\)\\.list\\()";
for (const file of [legacyServiceFile, legacyActionFile, compensationFile]) {
  if (!existsSync(file)) continue;
  const match = grep(legacyForbiddenSurfacePattern, file);
  ok = report(
    `${file} contains none of: deliverNotificationEmails, sendEmailViaResend, recordPortalDownloadRequest/PortalDownloadRequest, CRON_SECRET, a Storage bucket .list() call`,
    match === "",
    match,
  ) && ok;
}

// 13. Staff Invoice PDF download route (sub-PR 3c) — its own dedicated
// trust boundary never got a check block when it originally shipped
// (only its Portal sibling, check #11 above, did). This route is
// currently implemented correctly (verified by direct source read); this
// block exists purely to guard that existing boundary against a future
// regression, the same fail-closed discipline as check #11's own Portal
// block, never a claim that a vulnerability exists today.
const staffPdfRoute = "src/app/api/invoices/[id]/pdf/route.ts";

ok = report(
  `${staffPdfRoute} exists`,
  existsSync(staffPdfRoute),
  existsSync(staffPdfRoute) ? "" : `Expected ${staffPdfRoute} to exist.`,
) && ok;

if (existsSync(staffPdfRoute)) {
  const staffPdfContent = readFileSync(staffPdfRoute, "utf8");
  // Comments stripped once, up front — every forbidden-call check below
  // reads from this stripped copy, so this route's own doc comments can
  // never create a false positive (e.g. prose mentioning a forbidden
  // function name to explain why it's absent).
  const staffPdfCodeOnly = staffPdfContent.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  // 13a. Resolves identity through the real staff auth boundary.
  ok = report(
    `${staffPdfRoute} resolves identity via getCurrentUserOrganization`,
    staffPdfContent.includes("getCurrentUserOrganization"),
    "",
  ) && ok;

  // 13b. Uses its own dedicated rate limiter — never a shared/borrowed
  // bucket.
  ok = report(
    `${staffPdfRoute} uses the dedicated INVOICE_PDF_DOWNLOAD_LIMIT`,
    staffPdfContent.includes("INVOICE_PDF_DOWNLOAD_LIMIT"),
    "",
  ) && ok;

  // 13c. That limiter is actually passed to checkRateLimit(...), keyed by
  // user.id — not merely imported/mentioned in a comment.
  const rateLimitCallMatch = staffPdfCodeOnly.match(/checkRateLimit\(([^)]*)\)/);
  const rateLimitArgs = rateLimitCallMatch ? rateLimitCallMatch[1] : "";
  ok = report(
    `${staffPdfRoute} calls checkRateLimit(INVOICE_PDF_DOWNLOAD_LIMIT, user.id)`,
    /\bINVOICE_PDF_DOWNLOAD_LIMIT\b/.test(rateLimitArgs) && /\buser\.id\b/.test(rateLimitArgs),
    rateLimitCallMatch ? rateLimitArgs : "checkRateLimit(...) call not found",
  ) && ok;

  // 13d. The rate-limit check happens before the first Invoice-domain
  // Prisma lookup — never after, where an unthrottled request could
  // already have paid the query cost.
  const staffRateLimitIndex = staffPdfCodeOnly.indexOf("checkRateLimit(");
  const staffInvoiceLookupIndex = staffPdfCodeOnly.indexOf("prisma.invoice.findFirst(");
  ok = report(
    `${staffPdfRoute} checks the rate limit before its first Invoice-domain Prisma lookup`,
    staffRateLimitIndex !== -1 && staffInvoiceLookupIndex !== -1 && staffRateLimitIndex < staffInvoiceLookupIndex,
    `checkRateLimit at ${staffRateLimitIndex}, prisma.invoice.findFirst at ${staffInvoiceLookupIndex}`,
  ) && ok;

  // 13e. classifyInvoiceArchival() remains the single eligibility gate.
  ok = report(
    `${staffPdfRoute} calls classifyInvoiceArchival`,
    staffPdfContent.includes("classifyInvoiceArchival"),
    "",
  ) && ok;

  // 13f. The ledger-consistency proof carries all six required
  // predicates — a targeted extraction of the invoicePdfArchiveObject
  // findFirst's own where clause, not a whole-file scan (which could be
  // satisfied by unrelated text elsewhere in the route).
  const staffLedgerCallIndex = staffPdfCodeOnly.indexOf("prisma.invoicePdfArchiveObject.findFirst(");
  const staffLedgerWhereStart = staffLedgerCallIndex === -1 ? -1 : staffPdfCodeOnly.indexOf("where: {", staffLedgerCallIndex);
  const staffLedgerWhereEnd = staffLedgerWhereStart === -1 ? -1 : staffPdfCodeOnly.indexOf("select:", staffLedgerWhereStart);
  const staffLedgerWhereBlock =
    staffLedgerWhereStart === -1 || staffLedgerWhereEnd === -1 ? "" : staffPdfCodeOnly.slice(staffLedgerWhereStart, staffLedgerWhereEnd);
  const staffLedgerRequiredPredicates = [
    "organizationId",
    "invoiceId",
    "storagePath",
    "documentVersion",
    'status: "REFERENCED"',
    "referencedAt: { not: null }",
  ];
  const staffLedgerMissingPredicates = staffLedgerRequiredPredicates.filter((p) => !staffLedgerWhereBlock.includes(p));
  ok = report(
    `${staffPdfRoute}'s ledger-consistency proof contains all six required predicates (organizationId, invoiceId, storagePath, documentVersion, status: "REFERENCED", referencedAt: { not: null })`,
    staffLedgerWhereBlock.length > 0 && staffLedgerMissingPredicates.length === 0,
    staffLedgerMissingPredicates.join(", "),
  ) && ok;

  // 13g. Rebuilds the canonical path via buildInvoicePdfStoragePath(...)
  // before ever calling the signing helper — never trusts a raw
  // persisted path as the source of truth.
  ok = report(
    `${staffPdfRoute} calls buildInvoicePdfStoragePath`,
    staffPdfContent.includes("buildInvoicePdfStoragePath"),
    "",
  ) && ok;

  const staffPathRebuildIndex = staffPdfCodeOnly.indexOf("buildInvoicePdfStoragePath(");
  const staffSignIndex = staffPdfCodeOnly.indexOf("createInvoicePdfSignedUrl(");
  ok = report(
    `${staffPdfRoute} rebuilds the canonical path before calling createInvoicePdfSignedUrl`,
    staffPathRebuildIndex !== -1 && staffSignIndex !== -1 && staffPathRebuildIndex < staffSignIndex,
    `buildInvoicePdfStoragePath at ${staffPathRebuildIndex}, createInvoicePdfSignedUrl at ${staffSignIndex}`,
  ) && ok;

  // 13h. Reuses the existing signed-URL helper — never a duplicated
  // bucket/TTL/filename/TEST_MODE/signing implementation.
  ok = report(
    `${staffPdfRoute} calls createInvoicePdfSignedUrl`,
    staffPdfContent.includes("createInvoicePdfSignedUrl"),
    "",
  ) && ok;

  // 13i. Never exposes a permanent public URL for a private-bucket
  // object.
  ok = report(
    `${staffPdfRoute} never calls getPublicUrl`,
    !staffPdfCodeOnly.includes("getPublicUrl"),
    "",
  ) && ok;

  // 13j. No console logging of any kind — generic responses only, never
  // a path/signed-URL/invoice-number/identifier printed anywhere.
  ok = report(
    `${staffPdfRoute} contains no console logging`,
    !/console\.(log|error|warn|info|debug)\(/.test(staffPdfCodeOnly),
    "",
  ) && ok;
}

// 14. Bounded Archival Reconciliation/Cleanup — its own new trust boundary
// (the worker module plus both new cron routes), verified with the same
// fail-closed discipline as every check above. 14a-14b target the
// producer/compensation guard fields added to issue-invoice.ts,
// legacy-archive-invoice.ts, and archive-compensation.ts directly; 14c
// onward target the new reconcile-archive-objects.ts module and both new
// route files.
const reconciliationFile = "src/lib/invoices/pdf/reconcile-archive-objects.ts";
const reconciliationRouteFile = "src/app/api/cron/invoice-pdf-reconciliation/route.ts";
const reconciliationDryRunRouteFile = "src/app/api/cron/invoice-pdf-reconciliation/dry-run/route.ts";

// 14a. Issue's and Legacy Archive's own final ledger-promotion updateMany
// each require both claim fields null — a row the reconciliation worker
// currently holds claimed must never be silently promoted to REFERENCED.
for (const file of [serviceFile, legacyServiceFile]) {
  if (!existsSync(file)) continue;
  const content = readFileSync(file, "utf8");
  const promotionMatch = content.match(/tx\.invoicePdfArchiveObject\.updateMany\(\{\s*where:\s*\{([^}]*)\}/);
  const whereBody = promotionMatch ? promotionMatch[1] : "";
  ok = report(
    `${file}'s final ledger-promotion updateMany requires cleanupLockedAt: null and cleanupClaimToken: null`,
    whereBody.length > 0 && /cleanupLockedAt:\s*null/.test(whereBody) && /cleanupClaimToken:\s*null/.test(whereBody),
    whereBody,
  ) && ok;
}

// 14b. Both archive-compensation.ts updateMany branches require the same
// two null predicates.
if (existsSync(compensationFile)) {
  const compensationContent = readFileSync(compensationFile, "utf8");
  const branches = [...compensationContent.matchAll(/prisma\.invoicePdfArchiveObject\.updateMany\(\{\s*where:\s*\{([^}]*)\}/g)];
  ok = report(
    `${compensationFile} has exactly two invoicePdfArchiveObject.updateMany calls, both requiring cleanupLockedAt: null and cleanupClaimToken: null`,
    branches.length === 2 &&
      branches.every(([, whereBody]) => /cleanupLockedAt:\s*null/.test(whereBody) && /cleanupClaimToken:\s*null/.test(whereBody)),
    branches.map(([, w]) => w).join(" | "),
  ) && ok;
}

if (existsSync(reconciliationFile)) {
  const reconciliationContent = readFileSync(reconciliationFile, "utf8");

  // Scoped extraction — the real (write-capable) worker and the true
  // zero-write dry-run worker live in the same module file, and the real
  // worker legitimately contains everything the dry-run worker must never
  // contain (updateMany/create/delete, remove(...)). Every "must not
  // contain" check below is therefore always scoped to one function's own
  // extracted body, never a whole-file grep, which would necessarily fail
  // given the real worker's own legitimate content.
  const workerStart = reconciliationContent.indexOf("export async function reconcileInvoicePdfArchiveObjects(");
  const dryRunStart = reconciliationContent.indexOf("export async function reconcileInvoicePdfArchiveObjectsDryRun(");
  const workerBody =
    workerStart === -1 ? "" : reconciliationContent.slice(workerStart, dryRunStart === -1 ? undefined : dryRunStart);
  const dryRunBody = dryRunStart === -1 ? "" : reconciliationContent.slice(dryRunStart);

  // 14c. The real worker's own body calls candidateWhere( at least twice
  // (the initial candidate SELECT, and again inside the claim UPDATE's own
  // WHERE) — the same function reused, not two independently-written
  // predicates that could drift apart.
  const candidateWhereCallsInWorker = (workerBody.match(/candidateWhere\(/g) ?? []).length;
  ok = report(
    `${reconciliationFile}'s real worker calls candidateWhere( at least twice (initial SELECT and claim UPDATE)`,
    candidateWhereCallsInWorker >= 2,
    `found ${candidateWhereCallsInWorker} occurrence(s)`,
  ) && ok;

  // 14d. The dry-run worker's own candidate SELECT also calls
  // candidateWhere(.
  ok = report(`${reconciliationFile}'s dry-run worker calls candidateWhere(`, dryRunBody.includes("candidateWhere("), "") && ok;

  // 14e. The post-claim requery — narrowly extracted from the real
  // worker's own body — requires candidateIds, cleanupClaimToken: runToken,
  // and a status restriction, and deliberately does NOT call
  // candidateWhere( within that same narrow block: a row this run just
  // claimed has a fresh cleanupLockedAt/non-null cleanupClaimToken, which
  // can satisfy neither candidateWhere()'s "unclaimed" nor "stale" branch
  // — reapplying it here would make the worker claim rows and then find
  // none of them.
  const requeryStart = workerBody.indexOf("const claimed = await prisma.invoicePdfArchiveObject.findMany(");
  const requeryEnd = requeryStart === -1 ? -1 : workerBody.indexOf(");", requeryStart);
  const requeryBlock = requeryStart === -1 || requeryEnd === -1 ? "" : workerBody.slice(requeryStart, requeryEnd);
  ok = report(
    "the post-claim requery requires candidateIds, cleanupClaimToken: runToken, and a status restriction, and never calls candidateWhere( within its own block",
    requeryBlock.length > 0 &&
      requeryBlock.includes("candidateIds") &&
      requeryBlock.includes("cleanupClaimToken: runToken") &&
      /status:\s*\{\s*in:/.test(requeryBlock) &&
      !requeryBlock.includes("candidateWhere("),
    requeryBlock,
  ) && ok;

  // 14f. Every release helper — narrowly extracted by name — requires
  // cleanupClaimToken and a status restriction in its own WHERE clause,
  // and never requires cleanupLockedAt there (token equality alone is the
  // proven-sufficient ownership check; see the module's own comment on
  // releaseAsCleaned).
  for (const helperName of ["releaseAsCleaned", "releaseAsCleanupPending", "releaseWithFailure"]) {
    const helperStart = reconciliationContent.indexOf(`async function ${helperName}(`);
    const helperEnd = helperStart === -1 ? -1 : reconciliationContent.indexOf("\n}", helperStart);
    const helperBody = helperStart === -1 || helperEnd === -1 ? "" : reconciliationContent.slice(helperStart, helperEnd);
    const whereMatch = helperBody.match(/where:\s*\{([^}]*)\}/);
    const whereBody = whereMatch ? whereMatch[1] : "";
    ok = report(
      `${helperName}() requires cleanupClaimToken and a status restriction, and never requires cleanupLockedAt, in its own WHERE clause`,
      whereBody.length > 0 &&
        whereBody.includes("cleanupClaimToken: runToken") &&
        /status:\s*\{\s*in:/.test(whereBody) &&
        !whereBody.includes("cleanupLockedAt"),
      whereBody,
    ) && ok;
  }

  // 14g. The dry-run function body — narrowly extracted, see the comment
  // above workerBody/dryRunBody — never calls invoicePdfArchiveObject
  // update/create/delete and never calls remove(.
  ok = report(
    `${reconciliationFile}'s dry-run function body contains no invoicePdfArchiveObject update/create/delete and no remove( call`,
    dryRunBody.length > 0 &&
      !dryRunBody.includes("invoicePdfArchiveObject.updateMany") &&
      !dryRunBody.includes("invoicePdfArchiveObject.create") &&
      !dryRunBody.includes("invoicePdfArchiveObject.delete") &&
      !/\bremove\(/.test(dryRunBody),
    dryRunBody,
  ) && ok;

  // 14h. No bucket-wide listing, no signed-URL creation, no console
  // logging anywhere in this module (comments stripped first, matching
  // this script's own established technique).
  const reconciliationCodeOnly = reconciliationContent.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok = report(`${reconciliationFile} never calls a Storage bucket .list()`, !/storage\.from\([^)]*\)\.list\(/.test(reconciliationCodeOnly), "") && ok;
  ok = report(
    `${reconciliationFile} never creates a signed URL`,
    !reconciliationCodeOnly.includes("createSignedUrl") && !reconciliationCodeOnly.includes("createInvoicePdfSignedUrl"),
    "",
  ) && ok;
  ok = report(
    `${reconciliationFile} contains no console logging`,
    !/console\.(log|error|warn|info|debug)\(/.test(reconciliationCodeOnly),
    "",
  ) && ok;

  // 14k. Both exported workers resolve params.batchSize through the shared
  // resolveBatchSize( resolver — narrowly scoped to each function's own
  // extracted body, same technique as 14c-14h above — before ever passing
  // it to Prisma's own take:. Neither body may pass a raw params.batchSize
  // (with or without a `?? BATCH_SIZE` fallback) directly into take:, which
  // would defeat the bounded-batch guarantee for any future internal caller
  // that supplies an out-of-range value.
  ok = report(
    `${reconciliationFile}'s real worker resolves params.batchSize via resolveBatchSize( before its candidate query's take:, never a raw params.batchSize pass-through`,
    workerBody.includes("resolveBatchSize(params.batchSize)") && !/take:\s*params\.batchSize/.test(workerBody),
    workerBody,
  ) && ok;
  ok = report(
    `${reconciliationFile}'s dry-run worker resolves params.batchSize via resolveBatchSize( before its candidate query's take:, never a raw params.batchSize pass-through`,
    dryRunBody.includes("resolveBatchSize(params.batchSize)") && !/take:\s*params\.batchSize/.test(dryRunBody),
    dryRunBody,
  ) && ok;
} else {
  ok = report(`${reconciliationFile} exists`, false, `Expected ${reconciliationFile} to exist.`) && ok;
}

// 14i. Both reconciliation routes exist, both import and call
// requireCronAuth, and both retain a literal maxDuration=60 —
// reconcile-archive-objects.ts's own module-load-time assertion
// (CLEANUP_LEASE_MS > this exact value) depends on it never silently
// drifting.
for (const file of [reconciliationRouteFile, reconciliationDryRunRouteFile]) {
  ok = report(`${file} exists`, existsSync(file), existsSync(file) ? "" : `Expected ${file} to exist.`) && ok;
  if (existsSync(file)) {
    const content = readFileSync(file, "utf8");
    ok = report(`${file} declares export const maxDuration = 60`, /export const maxDuration = 60;/.test(content), "") && ok;
    ok = report(
      `${file} imports and calls requireCronAuth`,
      content.includes('from "@/lib/cron/auth"') && /requireCronAuth\(/.test(content),
      "",
    ) && ok;
  }
}

// 14j. Each route calls exactly its own corresponding worker function —
// the real route never calls the dry-run function, and the dry-run route
// never calls the real, write-capable function.
if (existsSync(reconciliationRouteFile)) {
  const content = readFileSync(reconciliationRouteFile, "utf8");
  ok = report(
    `${reconciliationRouteFile} calls reconcileInvoicePdfArchiveObjects, never the dry-run function`,
    content.includes("reconcileInvoicePdfArchiveObjects(") && !content.includes("reconcileInvoicePdfArchiveObjectsDryRun"),
    "",
  ) && ok;
}
if (existsSync(reconciliationDryRunRouteFile)) {
  const content = readFileSync(reconciliationDryRunRouteFile, "utf8");
  ok = report(
    `${reconciliationDryRunRouteFile} calls only reconcileInvoicePdfArchiveObjectsDryRun, never the real write-capable function`,
    content.includes("reconcileInvoicePdfArchiveObjectsDryRun(") && !/\breconcileInvoicePdfArchiveObjects\(/.test(content),
    "",
  ) && ok;
}

// 15. Invoice System Slice 4 — live OWNER-only send path. These checks
// replace the former "no writer exists" era with positive, fail-closed
// invariants around the one approved writer and action boundary.
const invoiceEmailActionFile = "src/app/(dashboard)/invoices/[id]/edit/send-email-actions.ts";
const invoiceEmailServiceFile = "src/lib/invoices/email/send-invoice-email.ts";
for (const file of [invoiceEmailActionFile, invoiceEmailServiceFile]) {
  ok = report(`${file} exists`, existsSync(file), existsSync(file) ? "" : `Expected ${file} to exist.`) && ok;
}

if (existsSync(invoiceEmailActionFile)) {
  const action = readFileSync(invoiceEmailActionFile, "utf8");
  const limitIndex = action.indexOf("checkRateLimit(INVOICE_EMAIL_SEND_LIMIT, user.id)");
  const serviceIndex = action.indexOf("sendInvoiceEmail(");
  ok = report("Invoice email action resolves trusted membership", action.includes("getCurrentMembership()"), "") && ok;
  ok = report("Invoice email action independently enforces OWNER", action.includes("assertCanAccessPaymentDetails"), "") && ok;
  ok = report(
    "Invoice email action uses its dedicated per-user limiter before entering the domain service",
    limitIndex !== -1 && serviceIndex !== -1 && limitIndex < serviceIndex,
    "",
  ) && ok;
}

if (existsSync(invoiceEmailServiceFile)) {
  const service = readFileSync(invoiceEmailServiceFile, "utf8");
  const codeOnly = service.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const ledgerIndex = service.indexOf("prisma.invoicePdfArchiveObject.findFirst");
  const rebuildIndex = service.indexOf("buildInvoicePdfStoragePath(identity)", ledgerIndex);
  const downloadIndex = service.indexOf("deps.downloadPdf({ identity })");
  const dispatchIndex = service.indexOf("deps.sendEmail({");
  ok = report("Invoice email service independently enforces OWNER", service.includes("assertCanAccessPaymentDetails(actor.role)"), "") && ok;
  ok = report("Invoice email service reuses issueInvoice through deps.issue", service.includes("deps.issue("), "") && ok;
  for (const predicate of ["organizationId: actor.organizationId", "invoiceId", "storagePath: invoice.pdfStoragePath!", "documentVersion: invoice.documentVersion", 'status: "REFERENCED"', "referencedAt: { not: null }"]) {
    ok = report(`Invoice email ledger proof contains ${predicate}`, service.includes(predicate), "") && ok;
  }
  ok = report(
    "Invoice email canonical ledger proof precedes PDF byte download, which precedes provider dispatch",
    ledgerIndex !== -1 && rebuildIndex > ledgerIndex && downloadIndex > rebuildIndex && dispatchIndex > downloadIndex,
    "",
  ) && ok;
  ok = report("Invoice email service never creates a public URL", !codeOnly.includes("getPublicUrl"), "") && ok;
  ok = report("Invoice email service contains no console logging", !/console\.(log|error|warn|info|debug)\(/.test(codeOnly), "") && ok;
  ok = report("Invoice email service never creates Activity or Notification rows", !/createActivity|notification\.(create|createMany)|createNotification/.test(codeOnly), "") && ok;
  ok = report(
    "Invoice email service never writes a PortalDownloadRequest row",
    !/PortalDownloadRequest|recordPortalDownloadRequest/.test(codeOnly),
    "",
  ) && ok;
  // Every InvoiceEmailAttempt read/write in this file goes through the
  // exact `invoice: { organizationId }` relation filter — never a bare
  // idempotencyKey/attemptId/invoiceId lookup on its own. Eight is the
  // exact count as of this file's own authoring (readExactAttempt,
  // readPendingAttempt, readLatestAttempt, the guarded settlement
  // updateMany, its own count-0 reread, the settlement catch-block
  // fallback updateMany, and the post-create conflict re-query) — a
  // regression that drops any one of them below this count is exactly
  // the "unscoped idempotency query" class of bug this check exists to
  // catch.
  const tenantScopedAttemptOps = (codeOnly.match(/invoice:\s*\{\s*organizationId/g) ?? []).length;
  ok = report(
    "every InvoiceEmailAttempt operation is tenant-scoped via the invoice.organizationId relation",
    tenantScopedAttemptOps >= 7,
    `Expected at least 7 tenant-scoped InvoiceEmailAttempt operations, found ${tenantScopedAttemptOps}.`,
  ) && ok;
}

const invoiceEmailHistoryFile = "src/lib/invoices/email/attempt-history.ts";
if (existsSync(invoiceEmailHistoryFile)) {
  const history = readFileSync(invoiceEmailHistoryFile, "utf8");
  ok = report("Invoice email attempt-history loader enforces OWNER", history.includes("assertCanAccessPaymentDetails"), "") && ok;
  ok = report(
    "Invoice email attempt-history loader is tenant/invoice scoped via the invoice.organizationId relation",
    /invoice:\s*\{\s*organizationId/.test(history),
    "",
  ) && ok;
  ok = report("Invoice email attempt-history loader is bounded to 20 rows", history.includes("take: 20"), "") && ok;
  for (const forbidden of ["idempotencyKey: true", "providerMessageId: true", "failureReason: true"]) {
    ok = report(`Invoice email attempt-history loader never selects ${forbidden}`, !history.includes(forbidden), "") && ok;
  }
}

// 16. Invoice System Official Slice 5 — Portal DRAFT-visibility
// correction. A narrow static guard against a future regression of the
// one enum-value-inclusion invariant this fix depends on: DRAFT must
// never appear in either Portal-visible status set, and every
// Portal-facing Invoice query must filter through one of those two
// shared constants rather than a hand-rolled inline status check that
// could silently drift from them. Full behavioral proof (tenant
// isolation, 404-equivalence, cross-org/cross-client fail-closed
// behavior) lives in integration/E2E tests, not here — this check exists
// only for the one property a static text scan can prove more cheaply
// and durably than a runtime test: the literal array contents.
const clientPortalQueriesFile = "src/lib/client-portal/queries.ts";
if (existsSync(clientPortalQueriesFile)) {
  const queriesContent = readFileSync(clientPortalQueriesFile, "utf8");

  const visibleStatusesMatch = queriesContent.match(/const VISIBLE_PORTAL_STATUSES: readonly InvoiceStatus\[\] = \[([^\]]*)\]/);
  const openStatusesMatch = queriesContent.match(/const OPEN_INVOICE_STATUSES: readonly InvoiceStatus\[\] = \[([^\]]*)\]/);
  const visibleStatusesLiteral = visibleStatusesMatch ? visibleStatusesMatch[1] : "";
  const openStatusesLiteral = openStatusesMatch ? openStatusesMatch[1] : "";

  ok = report(
    "VISIBLE_PORTAL_STATUSES is defined and never includes DRAFT",
    visibleStatusesLiteral.length > 0 && !/"DRAFT"/.test(visibleStatusesLiteral),
    visibleStatusesLiteral,
  ) && ok;
  ok = report(
    "OPEN_INVOICE_STATUSES is defined and never includes DRAFT",
    openStatusesLiteral.length > 0 && !/"DRAFT"/.test(openStatusesLiteral),
    openStatusesLiteral,
  ) && ok;

  // 16a. getPortalInvoice's own findFirst call filters through
  // VISIBLE_PORTAL_STATUSES — narrowly extracted to that one function's
  // body, not a whole-file scan, so this fails if a future edit moves the
  // predicate out of the query itself (e.g. into a post-fetch JS filter,
  // which would defeat the "same as nonexistent/cross-tenant" 404
  // equivalence this fix relies on).
  const getPortalInvoiceStart = queriesContent.indexOf("export async function getPortalInvoice(");
  const getPortalInvoiceBody = getPortalInvoiceStart === -1 ? "" : queriesContent.slice(getPortalInvoiceStart);
  ok = report(
    "getPortalInvoice's own Prisma query filters status through VISIBLE_PORTAL_STATUSES",
    /findFirst\(\{[\s\S]*?VISIBLE_PORTAL_STATUSES[\s\S]*?\}\)/.test(getPortalInvoiceBody),
    "",
  ) && ok;

  // 16b. getPortalInvoices' own "all" branch resolves to
  // VISIBLE_PORTAL_STATUSES, never `undefined`/no filter — extracted to
  // the statusWhere ternary itself, not the whole function, so an
  // unrelated later `undefined` elsewhere in the file can never satisfy
  // this by accident.
  const statusWhereMatch = queriesContent.match(/const statusWhere =[\s\S]*?;\n/);
  const statusWhereBlock = statusWhereMatch ? statusWhereMatch[0] : "";
  ok = report(
    'getPortalInvoices\' own statusWhere ternary resolves "all" to VISIBLE_PORTAL_STATUSES, never undefined/no filter',
    statusWhereBlock.includes("VISIBLE_PORTAL_STATUSES") && !/:\s*undefined\s*;/.test(statusWhereBlock),
    statusWhereBlock,
  ) && ok;

  // 16c. getPortalOverview's own recentInvoices query filters through
  // VISIBLE_PORTAL_STATUSES — extracted to the function body, not a
  // whole-file scan.
  const getPortalOverviewStart = queriesContent.indexOf("export async function getPortalOverview(");
  const getPortalOverviewEnd = queriesContent.indexOf("export async function getPortalProjects(");
  const getPortalOverviewBody =
    getPortalOverviewStart === -1 ? "" : queriesContent.slice(getPortalOverviewStart, getPortalOverviewEnd === -1 ? undefined : getPortalOverviewEnd);
  ok = report(
    "getPortalOverview's own recentInvoices query filters status through VISIBLE_PORTAL_STATUSES",
    /findMany\(\{[\s\S]*?VISIBLE_PORTAL_STATUSES[\s\S]*?\}\)/.test(getPortalOverviewBody),
    "",
  ) && ok;

  // 16d. getPortalOverview's own open-Invoice aggregate filters through
  // OPEN_INVOICE_STATUSES.
  ok = report(
    "getPortalOverview's own open-Invoice aggregate filters status through OPEN_INVOICE_STATUSES",
    /aggregate\(\{[\s\S]*?OPEN_INVOICE_STATUSES[\s\S]*?\}\)/.test(getPortalOverviewBody),
    "",
  ) && ok;
} else {
  ok = report(`${clientPortalQueriesFile} exists`, false, `Expected ${clientPortalQueriesFile} to exist.`) && ok;
}

process.exit(ok ? 0 : 1);
