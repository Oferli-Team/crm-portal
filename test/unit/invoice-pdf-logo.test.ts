import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// src/lib/invoices/pdf/logo.ts imports the real "server-only" marker
// package — see test/unit/cron-auth.test.ts's own header comment for the
// identical precedent.
vi.mock("server-only", () => ({}));

const SUPABASE_URL = "https://project.supabase.test";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const LOGO_UUID = "22222222-2222-4222-8222-222222222222";
const OWNED_LOGO_URL = `${SUPABASE_URL}/storage/v1/object/public/logos/organizations/${ORG_ID}/logo/${LOGO_UUID}.png`;

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * A genuine, real, decodable 1x1 transparent PNG — the exact same fixture
 * already proven valid elsewhere in this repo's own test suite
 * (test/e2e/organization-setup.spec.ts's own logo-upload fixture).
 */
const GENUINE_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/**
 * Genuine JPEG (SOI + JFIF APP0 marker) and WebP (RIFF/WEBP container)
 * magic-byte signatures, each followed by a minimal synthetic payload.
 * logo.ts's own signature check only inspects these leading bytes — it
 * never decodes pixel data — so this exercises the real signature-
 * validation boundary genuinely (authentic header structure, not
 * arbitrary text mislabelled as an image) without depending on a
 * fully spec-complete decodable bitstream.
 */
const GENUINE_JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("minimal-jpeg-payload-for-signature-testing")]);
const GENUINE_WEBP_BYTES = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBP", "latin1"),
  Buffer.from("VP8 minimal-payload-for-signature-testing"),
]);

describe("resolveInvoiceLogo — TEST_MODE (zero network)", () => {
  const originalTestMode = process.env.TEST_MODE;
  const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  beforeEach(() => {
    process.env.TEST_MODE = "1";
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalTestMode === undefined) delete process.env.TEST_MODE;
    else process.env.TEST_MODE = originalTestMode;
    if (originalSupabaseUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
    vi.resetModules();
  });

  it("no logo configured (logoUrl null) — included: false, bytes null, no network attempted", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");

    const result = await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: null });
    expect(result).toEqual({ provenance: { included: false, reason: "no_logo_configured" }, bytes: null });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("a valid PNG logo stored in the TEST_MODE bucket resolves with matching bytes/SHA-256, no network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");
    const { testStorageUpload } = await import("@/lib/storage/test-storage");

    const pngBytes = GENUINE_PNG_BYTES;
    const path = `organizations/${ORG_ID}/logo/${LOGO_UUID}.png`;
    testStorageUpload("logos", path, pngBytes, "image/png");

    const result = await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: OWNED_LOGO_URL });
    expect(result.provenance).toEqual({
      included: true,
      bucket: "logos",
      path,
      contentType: "image/png",
      sha256: sha256Hex(pngBytes),
    });
    expect(result.bytes).toEqual({ data: pngBytes, contentType: "image/png" });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it.each([
    ["image/jpeg", GENUINE_JPEG_BYTES] as const,
    ["image/webp", GENUINE_WEBP_BYTES] as const,
  ])("a valid %s logo resolves successfully", async (contentType, bytes) => {
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");
    const { testStorageUpload } = await import("@/lib/storage/test-storage");

    const ext = contentType === "image/jpeg" ? "jpg" : "webp";
    const uuid = "33333333-3333-4333-8333-333333333333";
    const path = `organizations/${ORG_ID}/logo/${uuid}.${ext}`;
    const url = `${SUPABASE_URL}/storage/v1/object/public/logos/${path}`;
    testStorageUpload("logos", path, bytes, contentType);

    const result = await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: url });
    expect(result.provenance).toEqual({ included: true, bucket: "logos", path, contentType, sha256: sha256Hex(bytes) });
  });

  it("bytes with the wrong magic-byte signature for their claimed content type resolve to invalid_content, never included", async () => {
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");
    const { testStorageUpload } = await import("@/lib/storage/test-storage");

    // A genuine JPEG signature, but stored/labelled as image/png — the
    // signature and the claimed MIME type must agree.
    const uuid = "44444444-4444-4444-8444-444444444444";
    const path = `organizations/${ORG_ID}/logo/${uuid}.png`;
    const url = `${SUPABASE_URL}/storage/v1/object/public/logos/${path}`;
    testStorageUpload("logos", path, GENUINE_JPEG_BYTES, "image/png");

    const result = await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: url });
    expect(result).toEqual({ provenance: { included: false, reason: "invalid_content" }, bytes: null });
  });

  it("arbitrary text bytes labelled as image/png (no genuine signature at all) resolve to invalid_content", async () => {
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");
    const { testStorageUpload } = await import("@/lib/storage/test-storage");

    const uuid = "55555555-5555-4555-8555-555555555555";
    const path = `organizations/${ORG_ID}/logo/${uuid}.png`;
    const url = `${SUPABASE_URL}/storage/v1/object/public/logos/${path}`;
    testStorageUpload("logos", path, Buffer.from("this is plain text, not an image"), "image/png");

    const result = await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: url });
    expect(result).toEqual({ provenance: { included: false, reason: "invalid_content" }, bytes: null });
  });

  it("a path belonging to a different organization is rejected as invalid_content", async () => {
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");
    const otherOrgUrl = `${SUPABASE_URL}/storage/v1/object/public/logos/organizations/99999999-9999-4999-8999-999999999999/logo/${LOGO_UUID}.png`;

    const result = await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: otherOrgUrl });
    expect(result).toEqual({ provenance: { included: false, reason: "invalid_content" }, bytes: null });
  });

  it("a URL with the wrong origin/bucket is rejected as invalid_content", async () => {
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");

    const wrongOrigin = `https://evil.test/storage/v1/object/public/logos/organizations/${ORG_ID}/logo/${LOGO_UUID}.png`;
    expect(await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: wrongOrigin })).toEqual({
      provenance: { included: false, reason: "invalid_content" },
      bytes: null,
    });

    const wrongBucket = `${SUPABASE_URL}/storage/v1/object/public/attachments/organizations/${ORG_ID}/logo/${LOGO_UUID}.png`;
    expect(await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: wrongBucket })).toEqual({
      provenance: { included: false, reason: "invalid_content" },
      bytes: null,
    });
  });

  it("a well-formed, owned path with no actual stored object resolves to fetch_failed", async () => {
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");
    // A UUID never uploaded by any other test in this file — test-storage's
    // Map is a shared globalThis instance that persists across tests, so
    // reusing OWNED_LOGO_URL's own path here would collide with the
    // earlier "valid PNG logo" test's own upload.
    const neverUploadedUrl = `${SUPABASE_URL}/storage/v1/object/public/logos/organizations/${ORG_ID}/logo/99999999-8888-4777-8666-555555555555.png`;
    const result = await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: neverUploadedUrl });
    expect(result).toEqual({ provenance: { included: false, reason: "fetch_failed" }, bytes: null });
  });

  it("a provenance/byte mismatch is rejected downstream by the existing toRendererIssuerPresentation() verification boundary", async () => {
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");
    const { testStorageUpload } = await import("@/lib/storage/test-storage");
    const { toRendererIssuerPresentation } = await import("@/lib/invoices/pdf/view-model");
    const { buildIssuerSnapshotV1 } = await import("@/lib/invoices/pdf/snapshot-types");

    const path = `organizations/${ORG_ID}/logo/${LOGO_UUID}.png`;
    testStorageUpload("logos", path, GENUINE_PNG_BYTES, "image/png");
    const resolved = await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: OWNED_LOGO_URL });
    expect(resolved.provenance.included).toBe(true);

    const snapshot = buildIssuerSnapshotV1({
      organizationName: "Acme",
      profile: null,
      paymentDetails: null,
      logo: resolved.provenance,
    });

    // Bytes that do NOT match the provenance's own recorded SHA-256 — the
    // renderer boundary (already covered exhaustively by
    // invoice-pdf-view-model.test.ts) must reject this, never silently
    // render mismatched bytes.
    const tamperedBytes = { data: Buffer.from("different-bytes-entirely"), contentType: "image/png" as const };
    const presentation = toRendererIssuerPresentation(snapshot, tamperedBytes);
    expect(presentation).toEqual({ ok: false, reason: "LOGO_PROVENANCE_MISMATCH" });
  });
});

describe("resolveInvoiceLogo — production fetch path", () => {
  const originalTestMode = process.env.TEST_MODE;
  const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  beforeEach(() => {
    delete process.env.TEST_MODE;
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalTestMode === undefined) delete process.env.TEST_MODE;
    else process.env.TEST_MODE = originalTestMode;
    if (originalSupabaseUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function bodyResponse(bytes: Buffer, init: { status?: number; headers?: Record<string, string> } = {}) {
    return new Response(new Uint8Array(bytes), { status: init.status ?? 200, headers: init.headers });
  }

  it("a successful fetch of an allowed MIME type resolves included:true with the correct SHA-256", async () => {
    const bytes = GENUINE_PNG_BYTES;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(bodyResponse(bytes, { headers: { "content-type": "image/png", "content-length": String(bytes.length) } })),
    );
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");

    const result = await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: OWNED_LOGO_URL });
    expect(result.provenance).toEqual({
      included: true,
      bucket: "logos",
      path: `organizations/${ORG_ID}/logo/${LOGO_UUID}.png`,
      contentType: "image/png",
      sha256: sha256Hex(bytes),
    });
  });

  it("fetches the exact deterministically-reconstructed canonical URL (bucket/path rebuilt server-side, not the raw stored string blindly reused)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(bodyResponse(Buffer.from("x"), { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");

    await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: OWNED_LOGO_URL });
    expect(fetchSpy).toHaveBeenCalledWith(
      `${SUPABASE_URL}/storage/v1/object/public/logos/organizations/${ORG_ID}/logo/${LOGO_UUID}.png`,
      expect.any(Object),
    );
  });

  it("a logoUrl with extra query/fragment garbage appended fails path extraction outright — never reaches fetch at all", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");

    const result = await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: `${OWNED_LOGO_URL}?tampered=1#fragment` });
    expect(result).toEqual({ provenance: { included: false, reason: "invalid_content" }, bytes: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a redirect response (manual mode -> opaqueredirect) is treated as failure, never followed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ type: "opaqueredirect", ok: false, status: 0 }));
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");

    const result = await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: OWNED_LOGO_URL });
    expect(result).toEqual({ provenance: { included: false, reason: "fetch_failed" }, bytes: null });
  });

  it("a network/timeout failure (fetch rejects) resolves to fetch_failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("The operation was aborted")));
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");

    const result = await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: OWNED_LOGO_URL });
    expect(result).toEqual({ provenance: { included: false, reason: "fetch_failed" }, bytes: null });
  });

  it("a non-2xx response is treated as failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bodyResponse(Buffer.from(""), { status: 404 })));
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");

    const result = await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: OWNED_LOGO_URL });
    expect(result).toEqual({ provenance: { included: false, reason: "fetch_failed" }, bytes: null });
  });

  it("an unsupported Content-Type (e.g. SVG) is rejected as invalid_content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(bodyResponse(Buffer.from("<svg/>"), { headers: { "content-type": "image/svg+xml" } })),
    );
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");

    const result = await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: OWNED_LOGO_URL });
    expect(result).toEqual({ provenance: { included: false, reason: "invalid_content" }, bytes: null });
  });

  it("an oversized Content-Length header is rejected before reading the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        bodyResponse(Buffer.from("small"), { headers: { "content-type": "image/png", "content-length": String(3 * 1024 * 1024) } }),
      ),
    );
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");

    const result = await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: OWNED_LOGO_URL });
    expect(result).toEqual({ provenance: { included: false, reason: "invalid_content" }, bytes: null });
  });

  it("a body that streams more than the 2 MiB limit (regardless of Content-Length) is rejected", async () => {
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 1);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(bodyResponse(oversized, { headers: { "content-type": "image/png" } })),
    );
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");

    const result = await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: OWNED_LOGO_URL });
    expect(result).toEqual({ provenance: { included: false, reason: "invalid_content" }, bytes: null });
  });

  it("a response with no body is treated as a fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, type: "basic", headers: new Headers({ "content-type": "image/png" }), body: null }),
    );
    const { resolveInvoiceLogo } = await import("@/lib/invoices/pdf/logo");

    const result = await resolveInvoiceLogo({ organizationId: ORG_ID, logoUrl: OWNED_LOGO_URL });
    expect(result).toEqual({ provenance: { included: false, reason: "fetch_failed" }, bytes: null });
  });
});
