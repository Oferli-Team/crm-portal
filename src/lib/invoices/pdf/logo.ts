import "server-only";
import { createHash } from "node:crypto";
import { TEST_MODE } from "@/lib/test-mode";
import { testStorageRead } from "@/lib/storage/test-storage";
import { LOGO_BUCKET } from "@/lib/storage/logo-config";
import { extractLogoStoragePathFromPublicUrl } from "@/lib/storage/logo-files";
import type { AllowedLogoContentType, InvoiceLogoProvenanceV1 } from "./snapshot-types";

/**
 * Invoice System Slice 3, sub-PR 3b — server-only Invoice PDF logo
 * resolution. Returns a matched pair: the persisted provenance record
 * (Slice 3a's InvoiceLogoProvenanceV1) and the exact bytes it describes —
 * the two are always built from the same read, in this same function, so
 * they can never independently drift. Never fetches an arbitrary URL:
 * only ever the org's own already-validated Storage path, reconstructed
 * from the trusted server-side NEXT_PUBLIC_SUPABASE_URL, never the raw
 * stored logoUrl string reused verbatim.
 *
 * Any failure (no logo configured, invalid URL/path, wrong origin/bucket,
 * fetch failure/timeout, redirect, invalid MIME, MIME/byte-signature
 * mismatch, oversized body) resolves to `{ included: false, reason }` +
 * null bytes — never throws, never fails the Issue operation on its own.
 */

const ALLOWED_LOGO_CONTENT_TYPES: readonly AllowedLogoContentType[] = ["image/png", "image/jpeg", "image/webp"];
const MAX_LOGO_BYTES = 2 * 1024 * 1024; // matches src/lib/storage/logo-config.ts's MAX_LOGO_SIZE_BYTES
const FETCH_TIMEOUT_MS = 5000;

function isAllowedContentType(value: string | null | undefined): value is AllowedLogoContentType {
  return !!value && (ALLOWED_LOGO_CONTENT_TYPES as readonly string[]).includes(value);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Real magic-byte signature validation, checked against the claimed
 * content type — never trusted merely because a Content-Type header or a
 * TEST_MODE-stored contentType string says so. This is a first line of
 * defense only (a genuine header/format check, not a full image decode —
 * this module never parses pixel data): it catches arbitrary bytes
 * mislabelled as an image outright, before they can ever reach the PDF
 * renderer. A structurally corrupt-but-signature-passing image is still
 * possible; issue-invoice.ts's own render-failure retry (never involving
 * this module) is the second line of defense for that residual case.
 */
function hasValidImageSignature(data: Buffer, contentType: AllowedLogoContentType): boolean {
  if (contentType === "image/png") {
    return data.length >= PNG_SIGNATURE.length && data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  }
  if (contentType === "image/jpeg") {
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  }
  // WebP: a RIFF container whose form type (bytes 8-11) is "WEBP".
  return (
    data.length >= 12 &&
    data.subarray(0, 4).toString("latin1") === "RIFF" &&
    data.subarray(8, 12).toString("latin1") === "WEBP"
  );
}

/** organizations/<organizationId>/logo/<uuid>.<png|jpg|jpeg|webp> — matches buildLogoStoragePath()'s own exact shape. */
function isOwnedLogoPath(path: string, organizationId: string): boolean {
  const pattern = new RegExp(
    `^organizations/${organizationId}/logo/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(png|jpe?g|webp)$`,
    "i",
  );
  return pattern.test(path);
}

export type ResolvedInvoiceLogo = {
  provenance: InvoiceLogoProvenanceV1;
  bytes: { data: Buffer; contentType: AllowedLogoContentType } | null;
};

const NO_LOGO: ResolvedInvoiceLogo = { provenance: { included: false, reason: "no_logo_configured" }, bytes: null };

function fetchFailed(): ResolvedInvoiceLogo {
  return { provenance: { included: false, reason: "fetch_failed" }, bytes: null };
}

function invalidContent(): ResolvedInvoiceLogo {
  return { provenance: { included: false, reason: "invalid_content" }, bytes: null };
}

function finalize(data: Buffer, contentType: string, path: string): ResolvedInvoiceLogo {
  if (!isAllowedContentType(contentType)) return invalidContent();
  if (data.length === 0 || data.length > MAX_LOGO_BYTES) return invalidContent();
  if (!hasValidImageSignature(data, contentType)) return invalidContent();

  const sha256 = createHash("sha256").update(data).digest("hex");
  return {
    provenance: { included: true, bucket: "logos", path, contentType, sha256 },
    bytes: { data, contentType },
  };
}

export async function resolveInvoiceLogo({
  organizationId,
  logoUrl,
}: {
  organizationId: string;
  logoUrl: string | null;
}): Promise<ResolvedInvoiceLogo> {
  if (!logoUrl) return NO_LOGO;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return fetchFailed();

  const path = extractLogoStoragePathFromPublicUrl({ publicUrl: logoUrl, supabaseUrl, bucket: LOGO_BUCKET });
  if (!path || !isOwnedLogoPath(path, organizationId)) return invalidContent();

  if (TEST_MODE) {
    const object = testStorageRead(LOGO_BUCKET, path);
    if (!object) return fetchFailed();
    return finalize(object.body, object.contentType, path);
  }

  const canonicalUrl = `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/${LOGO_BUCKET}/${path}`;

  let response: Response;
  try {
    response = await fetch(canonicalUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "manual" });
  } catch {
    return fetchFailed();
  }

  // "manual" makes a redirect resolve to an opaqueredirect response
  // (status 0, no readable headers) rather than being followed — treated
  // as a hard failure, never followed.
  if (response.type === "opaqueredirect" || !response.ok) {
    return fetchFailed();
  }

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? null;
  if (!isAllowedContentType(contentType)) return invalidContent();

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader && Number(contentLengthHeader) > MAX_LOGO_BYTES) return invalidContent();

  if (!response.body) return fetchFailed();

  // Bounded/streaming read — stops and rejects as soon as more than
  // MAX_LOGO_BYTES has actually been received, regardless of what (or
  // whether) a Content-Length header claimed.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_LOGO_BYTES) {
          await reader.cancel();
          return invalidContent();
        }
        chunks.push(value);
      }
    }
  } catch {
    return fetchFailed();
  }

  return finalize(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), contentType, path);
}
