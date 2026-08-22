import { afterAll, describe, expect, it, vi } from "vitest";

// src/lib/invoices/pdf/storage.ts imports the real "server-only" marker
// package — see test/unit/cron-auth.test.ts's own header comment for the
// identical precedent. TEST_MODE is a module-level const computed once at
// first import (see test/unit/recovery-token.test.ts's own identical
// technique) — set before the dynamic import below so this module's real
// TEST_MODE branch runs directly, not a mock of it.
vi.mock("server-only", () => ({}));

// Invoice System Official Slice 3, sub-PR 3c — createInvoicePdfSignedUrl()'s
// own TEST_MODE branch calls next/headers' headers() to build a same-origin
// URL; this file is a plain Vitest unit test with no real Next.js request
// context, so the module is mocked with a fixed, deterministic
// host/protocol pair — never a real request, never randomness.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "e2e-test.local", "x-forwarded-proto": "https" }),
}));

const ORIGINAL_TEST_MODE = process.env.TEST_MODE;
process.env.TEST_MODE = "1";

const {
  buildInvoicePdfStoragePath,
  uploadInvoicePdfObject,
  removeInvoicePdfObject,
  probeInvoicePdfObject,
  createInvoicePdfSignedUrl,
  downloadInvoicePdfObject,
} = await import("@/lib/invoices/pdf/storage");
const { testStorageRead } = await import("@/lib/storage/test-storage");
const { MAX_PDF_BYTES } = await import("@/lib/invoices/pdf/buffer-validation");
// Bounded Archival Reconciliation/Cleanup — operation-specific failure-reason
// types, unit-tested for compile-time restriction only, below.
import type { InvoicePdfUploadResult, InvoicePdfRemoveResult } from "@/lib/invoices/pdf/storage";

afterAll(() => {
  if (ORIGINAL_TEST_MODE === undefined) {
    delete process.env.TEST_MODE;
  } else {
    process.env.TEST_MODE = ORIGINAL_TEST_MODE;
  }
});

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const INVOICE_ID = "22222222-2222-4222-8222-222222222222";
const ARCHIVE_ID = "33333333-3333-4333-8333-333333333333";

describe("buildInvoicePdfStoragePath — exact path construction and validation", () => {
  it("builds the exact documented path shape", () => {
    const path = buildInvoicePdfStoragePath({
      organizationId: ORG_ID,
      invoiceId: INVOICE_ID,
      documentVersion: 1,
      archiveId: ARCHIVE_ID,
    });
    expect(path).toBe(`organizations/${ORG_ID}/invoice-pdf/${INVOICE_ID}/v1/${ARCHIVE_ID}.pdf`);
  });

  it("reflects a documentVersion other than 1 exactly", () => {
    const path = buildInvoicePdfStoragePath({
      organizationId: ORG_ID,
      invoiceId: INVOICE_ID,
      documentVersion: 3,
      archiveId: ARCHIVE_ID,
    });
    expect(path).toContain("/v3/");
  });

  it("rejects a non-UUID organizationId", () => {
    expect(() =>
      buildInvoicePdfStoragePath({ organizationId: "not-a-uuid", invoiceId: INVOICE_ID, documentVersion: 1, archiveId: ARCHIVE_ID }),
    ).toThrow(/organizationId/);
  });

  it("rejects a non-UUID invoiceId", () => {
    expect(() =>
      buildInvoicePdfStoragePath({ organizationId: ORG_ID, invoiceId: "not-a-uuid", documentVersion: 1, archiveId: ARCHIVE_ID }),
    ).toThrow(/invoiceId/);
  });

  it("rejects a non-UUID archiveId", () => {
    expect(() =>
      buildInvoicePdfStoragePath({ organizationId: ORG_ID, invoiceId: INVOICE_ID, documentVersion: 1, archiveId: "not-a-uuid" }),
    ).toThrow(/archiveId/);
  });

  it("rejects a zero documentVersion", () => {
    expect(() =>
      buildInvoicePdfStoragePath({ organizationId: ORG_ID, invoiceId: INVOICE_ID, documentVersion: 0, archiveId: ARCHIVE_ID }),
    ).toThrow(/documentVersion/);
  });

  it("rejects a negative documentVersion", () => {
    expect(() =>
      buildInvoicePdfStoragePath({ organizationId: ORG_ID, invoiceId: INVOICE_ID, documentVersion: -1, archiveId: ARCHIVE_ID }),
    ).toThrow(/documentVersion/);
  });

  it("rejects a non-integer documentVersion", () => {
    expect(() =>
      buildInvoicePdfStoragePath({ organizationId: ORG_ID, invoiceId: INVOICE_ID, documentVersion: 1.5, archiveId: ARCHIVE_ID }),
    ).toThrow(/documentVersion/);
  });
});

function identity(archiveId: string, overrides: Partial<{ organizationId: string; invoiceId: string; documentVersion: number }> = {}) {
  return { organizationId: overrides.organizationId ?? ORG_ID, invoiceId: overrides.invoiceId ?? INVOICE_ID, documentVersion: overrides.documentVersion ?? 1, archiveId };
}

describe("uploadInvoicePdfObject / removeInvoicePdfObject — accept only a structured identity, never a raw path", () => {
  it("uploads successfully for a fresh identity", async () => {
    const result = await uploadInvoicePdfObject({ identity: identity(ARCHIVE_ID), body: Buffer.from("%PDF-1.3 fake pdf bytes") });
    expect(result).toEqual({ ok: true });

    const path = buildInvoicePdfStoragePath(identity(ARCHIVE_ID));
    const stored = testStorageRead("attachments", path);
    expect(stored).not.toBeNull();
    expect(stored!.contentType).toBe("application/pdf");
  });

  it("a second upload attempt for the exact same identity is rejected — create-only collision, never a silent overwrite", async () => {
    const archiveId = "44444444-4444-4444-8444-444444444444";
    const first = Buffer.from("%PDF-1.3 original immutable bytes");
    const second = Buffer.from("%PDF-1.3 a completely different payload");

    const firstResult = await uploadInvoicePdfObject({ identity: identity(archiveId), body: first });
    expect(firstResult).toEqual({ ok: true });

    const secondResult = await uploadInvoicePdfObject({ identity: identity(archiveId), body: second });
    expect(secondResult).toEqual({ ok: false, reason: "upload_failed" });

    // TEST_MODE must not silently overwrite the immutable bytes already stored.
    const path = buildInvoicePdfStoragePath(identity(archiveId));
    const stored = testStorageRead("attachments", path);
    expect(stored!.body.equals(first)).toBe(true);
  });

  it("removes exactly the object identified, and only that object", async () => {
    const archiveId = "55555555-5555-4555-8555-555555555555";
    const otherArchiveId = "66666666-6666-4666-8666-666666666666";

    await uploadInvoicePdfObject({ identity: identity(archiveId), body: Buffer.from("target") });
    await uploadInvoicePdfObject({ identity: identity(otherArchiveId), body: Buffer.from("must survive") });

    const removeResult = await removeInvoicePdfObject({ identity: identity(archiveId) });
    expect(removeResult).toEqual({ ok: true });

    expect(testStorageRead("attachments", buildInvoicePdfStoragePath(identity(archiveId)))).toBeNull();
    // The unrelated object at a different identity is never touched.
    expect(testStorageRead("attachments", buildInvoicePdfStoragePath(identity(otherArchiveId)))).not.toBeNull();
  });

  it("removing an already-absent object is treated as successful cleanup", async () => {
    const archiveId = "77777777-7777-4777-8777-777777777777";
    // Never uploaded — the object at this identity's path is already absent.
    const result = await removeInvoicePdfObject({ identity: identity(archiveId) });
    expect(result).toEqual({ ok: true });
  });

  it("cannot be pointed at an existing attachment object's path — the identity always resolves inside the invoice-pdf namespace, never elsewhere in the shared bucket", async () => {
    const { testStorageUpload } = await import("@/lib/storage/test-storage");
    const attachmentPath = `organizations/${ORG_ID}/attachments/some-real-attachment-id.pdf`;
    testStorageUpload("attachments", attachmentPath, Buffer.from("a real attachment, never touched by Invoice PDF archival"), "application/pdf");

    // Even with an identity built from the exact same organizationId, the
    // rebuilt path always lands under invoice-pdf/, never at an arbitrary
    // attachment path — removeInvoicePdfObject has no way to target
    // attachmentPath at all.
    const archiveId = "88888888-8888-4888-8888-888888888888";
    const result = await removeInvoicePdfObject({ identity: identity(archiveId) });
    expect(result).toEqual({ ok: true }); // absent-at-its-own-path, still a no-op success

    // The unrelated attachment object is completely untouched.
    expect(testStorageRead("attachments", attachmentPath)).not.toBeNull();
  });

  it("cannot be pointed at a logo object's path — the invoice-pdf namespace never collides with organizations/<org>/logo/", async () => {
    const { testStorageUpload } = await import("@/lib/storage/test-storage");
    const logoPath = `organizations/${ORG_ID}/logo/${ARCHIVE_ID}.png`;
    testStorageUpload("logos", logoPath, Buffer.from("a real logo, never touched by Invoice PDF archival"), "image/png");

    const result = await removeInvoicePdfObject({ identity: identity(ARCHIVE_ID) });
    expect(result).toEqual({ ok: true });
    // Different bucket entirely ("logos" vs "attachments") — completely untouched.
    expect(testStorageRead("logos", logoPath)).not.toBeNull();
  });

  it("rejects an identity with an invalid organizationId/invoiceId/archiveId or documentVersion before any Storage call", async () => {
    await expect(uploadInvoicePdfObject({ identity: { organizationId: "not-a-uuid", invoiceId: INVOICE_ID, documentVersion: 1, archiveId: ARCHIVE_ID }, body: Buffer.from("x") })).rejects.toThrow(/organizationId/);
    await expect(uploadInvoicePdfObject({ identity: { organizationId: ORG_ID, invoiceId: "not-a-uuid", documentVersion: 1, archiveId: ARCHIVE_ID }, body: Buffer.from("x") })).rejects.toThrow(/invoiceId/);
    await expect(uploadInvoicePdfObject({ identity: { organizationId: ORG_ID, invoiceId: INVOICE_ID, documentVersion: 1, archiveId: "not-a-uuid" }, body: Buffer.from("x") })).rejects.toThrow(/archiveId/);
    await expect(uploadInvoicePdfObject({ identity: { organizationId: ORG_ID, invoiceId: INVOICE_ID, documentVersion: 0, archiveId: ARCHIVE_ID }, body: Buffer.from("x") })).rejects.toThrow(/documentVersion/);
    await expect(removeInvoicePdfObject({ identity: { organizationId: "not-a-uuid", invoiceId: INVOICE_ID, documentVersion: 1, archiveId: ARCHIVE_ID } })).rejects.toThrow(/organizationId/);
  });
});

describe("probeInvoicePdfObject — TEST_MODE branch", () => {
  it("reports exists: true for an object actually present in the TEST_MODE store", async () => {
    const archiveId = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
    await uploadInvoicePdfObject({ identity: identity(archiveId), body: Buffer.from("%PDF-1.3 present") });

    const result = await probeInvoicePdfObject({ identity: identity(archiveId) });
    expect(result).toEqual({ ok: true, exists: true });
  });

  it("reports exists: false for an object never uploaded", async () => {
    const archiveId = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb";
    const result = await probeInvoicePdfObject({ identity: identity(archiveId) });
    expect(result).toEqual({ ok: true, exists: false });
  });

  it("reports exists: false after the object has been removed", async () => {
    const archiveId = "cccccccc-3333-4ccc-8ccc-cccccccccccc";
    await uploadInvoicePdfObject({ identity: identity(archiveId), body: Buffer.from("%PDF-1.3 to be removed") });
    await removeInvoicePdfObject({ identity: identity(archiveId) });

    const result = await probeInvoicePdfObject({ identity: identity(archiveId) });
    expect(result).toEqual({ ok: true, exists: false });
  });

  it("never confuses a different identity's object with this one's absence", async () => {
    const targetArchiveId = "dddddddd-4444-4ddd-8ddd-dddddddddddd";
    const otherArchiveId = "eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee";
    await uploadInvoicePdfObject({ identity: identity(otherArchiveId), body: Buffer.from("unrelated") });

    const result = await probeInvoicePdfObject({ identity: identity(targetArchiveId) });
    expect(result).toEqual({ ok: true, exists: false });
  });
});

describe("probeInvoicePdfObject — production adapter", () => {
  const prodIdentity = { organizationId: ORG_ID, invoiceId: INVOICE_ID, documentVersion: 1, archiveId: ARCHIVE_ID };

  async function withProdProbe(run: (probeProd: typeof probeInvoicePdfObject, buildPathProd: typeof buildInvoicePdfStoragePath) => Promise<void>) {
    const originalTestMode = process.env.TEST_MODE;
    try {
      delete process.env.TEST_MODE;
      vi.resetModules();
      const { probeInvoicePdfObject: probeProd, buildInvoicePdfStoragePath: buildPathProd } = await import("@/lib/invoices/pdf/storage");
      await run(probeProd, buildPathProd);
    } finally {
      process.env.TEST_MODE = originalTestMode;
      vi.resetModules();
    }
  }

  it("data:true, error:null -> exists: true", async () => {
    await withProdProbe(async (probeProd) => {
      const existsMock = vi.fn().mockResolvedValue({ data: true, error: null });
      const fakeClient = { storage: { from: vi.fn().mockReturnValue({ exists: existsMock }) } } as unknown as Parameters<typeof probeProd>[1];

      const result = await probeProd({ identity: prodIdentity }, fakeClient);
      expect(result).toEqual({ ok: true, exists: true });
    });
  });

  it("data:false, error.status:404 -> exists: false (confirmed absent)", async () => {
    await withProdProbe(async (probeProd) => {
      const existsMock = vi.fn().mockResolvedValue({ data: false, error: { status: 404, message: "not found" } });
      const fakeClient = { storage: { from: vi.fn().mockReturnValue({ exists: existsMock }) } } as unknown as Parameters<typeof probeProd>[1];

      const result = await probeProd({ identity: prodIdentity }, fakeClient);
      expect(result).toEqual({ ok: true, exists: false });
    });
  });

  it("data:false, error.status:400 -> probe_failed, never exists: false — an unexpected provider response given canonical path validation, never treated as evidence of absence", async () => {
    await withProdProbe(async (probeProd) => {
      const existsMock = vi.fn().mockResolvedValue({ data: false, error: { status: 400, message: "bad request" } });
      const fakeClient = { storage: { from: vi.fn().mockReturnValue({ exists: existsMock }) } } as unknown as Parameters<typeof probeProd>[1];

      const result = await probeProd({ identity: prodIdentity }, fakeClient);
      expect(result).toEqual({ ok: false, reason: "probe_failed" });
    });
  });

  it("an unexpected resolved shape (data:false, error:null) -> probe_failed, never inferred as absent", async () => {
    await withProdProbe(async (probeProd) => {
      const existsMock = vi.fn().mockResolvedValue({ data: false, error: null });
      const fakeClient = { storage: { from: vi.fn().mockReturnValue({ exists: existsMock }) } } as unknown as Parameters<typeof probeProd>[1];

      const result = await probeProd({ identity: prodIdentity }, fakeClient);
      expect(result).toEqual({ ok: false, reason: "probe_failed" });
    });
  });

  it("an unexpected resolved shape (data:true, error:non-null) -> probe_failed", async () => {
    await withProdProbe(async (probeProd) => {
      const existsMock = vi.fn().mockResolvedValue({ data: true, error: { status: 200, message: "inconsistent" } });
      const fakeClient = { storage: { from: vi.fn().mockReturnValue({ exists: existsMock }) } } as unknown as Parameters<typeof probeProd>[1];

      const result = await probeProd({ identity: prodIdentity }, fakeClient);
      expect(result).toEqual({ ok: false, reason: "probe_failed" });
    });
  });

  it("a thrown auth/network/5xx failure -> probe_failed, never letting the raw exception escape", async () => {
    await withProdProbe(async (probeProd) => {
      const existsMock = vi.fn().mockRejectedValue(new Error("simulated network failure — must never be persisted or thrown"));
      const fakeClient = { storage: { from: vi.fn().mockReturnValue({ exists: existsMock }) } } as unknown as Parameters<typeof probeProd>[1];

      const result = await probeProd({ identity: prodIdentity }, fakeClient);
      expect(result).toEqual({ ok: false, reason: "probe_failed" });
    });
  });

  it("no client available and none injected -> storage_not_configured, without ever calling exists()", async () => {
    await withProdProbe(async (probeProd) => {
      const result = await probeProd({ identity: prodIdentity });
      expect(result).toEqual({ ok: false, reason: "storage_not_configured" });
    });
  });

  it("rejects an invalid structured identity before any external call", async () => {
    await withProdProbe(async (probeProd) => {
      await expect(probeProd({ identity: { ...prodIdentity, organizationId: "not-a-uuid" } })).rejects.toThrow(/organizationId/);
    });
  });
});

describe("InvoicePdfUploadResult / InvoicePdfRemoveResult — operation-specific failure reasons (type contract)", () => {
  // Bounded Archival Reconciliation/Cleanup — a pure compile-time
  // restriction: uploadInvoicePdfObject() can never fail with
  // "remove_failed", and removeInvoicePdfObject() can never fail with
  // "upload_failed". There is no runtime behavior to assert here — each
  // suppression comment directly below its own assignment IS the
  // assertion, enforced by `npx tsc --noEmit` (tsconfig.json includes
  // test/**/*.ts), mirroring the established precedent in
  // test/unit/invoice-lifecycle.test.ts's own frozen-object check. If a
  // future edit widens either type back, a suppression comment with
  // nothing left to suppress becomes its own type-check failure.
  it("InvoicePdfUploadResult's reason may never be 'remove_failed'", () => {
    // @ts-expect-error — "remove_failed" is not a valid InvoicePdfUploadFailureReason.
    const badUpload: InvoicePdfUploadResult = { ok: false, reason: "remove_failed" };
    void badUpload;
  });

  it("InvoicePdfRemoveResult's reason may never be 'upload_failed'", () => {
    // @ts-expect-error — "upload_failed" is not a valid InvoicePdfRemoveFailureReason.
    const badRemove: InvoicePdfRemoveResult = { ok: false, reason: "upload_failed" };
    void badRemove;
  });
});

describe("uploadInvoicePdfObject — production adapter passes upsert: false", () => {
  it("calls storage.from(bucket).upload(path, body, { contentType: 'application/pdf', upsert: false })", async () => {
    const originalTestMode = process.env.TEST_MODE;
    delete process.env.TEST_MODE;
    // Re-import fresh so TEST_MODE re-evaluates to false for this one assertion.
    vi.resetModules();
    const { uploadInvoicePdfObject: uploadProd, buildInvoicePdfStoragePath: buildPathProd } = await import("@/lib/invoices/pdf/storage");

    const uploadMock = vi.fn().mockResolvedValue({ error: null });
    const fakeClient = {
      storage: { from: vi.fn().mockReturnValue({ upload: uploadMock }) },
    } as unknown as Parameters<typeof uploadProd>[1];

    const prodIdentity = { organizationId: ORG_ID, invoiceId: INVOICE_ID, documentVersion: 1, archiveId: ARCHIVE_ID };
    const body = Buffer.from("bytes");
    const result = await uploadProd({ identity: prodIdentity, body }, fakeClient);

    expect(result).toEqual({ ok: true });
    expect(uploadMock).toHaveBeenCalledWith(buildPathProd(prodIdentity), body, { contentType: "application/pdf", upsert: false });

    process.env.TEST_MODE = originalTestMode;
    vi.resetModules();
  });
});

describe("createInvoicePdfSignedUrl — TEST_MODE branch", () => {
  const prodIdentity = { organizationId: ORG_ID, invoiceId: INVOICE_ID, documentVersion: 1, archiveId: ARCHIVE_ID };

  it("rebuilds the canonical path internally and returns a deterministic same-origin e2e-test-storage URL", async () => {
    const result = await createInvoicePdfSignedUrl({ identity: prodIdentity, invoiceNumber: "INV-2026-001" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const expectedPath = buildInvoicePdfStoragePath(prodIdentity);
    expect(result.url).toBe(`https://e2e-test.local/api/e2e-test-storage/attachments/${expectedPath}`);
  });

  it("two identical calls return identical results — deterministic, no randomness or timestamp", async () => {
    const first = await createInvoicePdfSignedUrl({ identity: prodIdentity, invoiceNumber: "INV-2026-001" });
    const second = await createInvoicePdfSignedUrl({ identity: prodIdentity, invoiceNumber: "INV-2026-001" });
    expect(first).toEqual(second);
  });

  it("never calls a Supabase client — the TEST_MODE branch returns before any client is resolved, even when one is explicitly supplied", async () => {
    // Direct evidence, not inference: a fake client IS supplied (unlike
    // the sibling "no client argument at all" case this replaces), with
    // its own storage.from spied — if TEST_MODE's own branch reached the
    // client-resolution/signing code at all, this spy would record a
    // call. It never does, proving the TEST_MODE `if` returns before
    // resolveClient()/storage.from() are ever reached, not merely that
    // no client happened to be available to call.
    const fromSpy = vi.fn();
    const fakeClient = { storage: { from: fromSpy } } as unknown as Parameters<typeof createInvoicePdfSignedUrl>[1];

    const result = await createInvoicePdfSignedUrl({ identity: prodIdentity, invoiceNumber: "INV-2026-001" }, fakeClient);

    const expectedPath = buildInvoicePdfStoragePath(prodIdentity);
    expect(result).toEqual({ ok: true, url: `https://e2e-test.local/api/e2e-test-storage/attachments/${expectedPath}` });
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("rejects an invalid structured identity before any external call — buildInvoicePdfStoragePath's own validation runs first", async () => {
    await expect(
      createInvoicePdfSignedUrl({ identity: { ...prodIdentity, organizationId: "not-a-uuid" }, invoiceNumber: "INV-2026-001" }),
    ).rejects.toThrow(/organizationId/);
  });
});

describe("createInvoicePdfSignedUrl — production adapter", () => {
  const prodIdentity = { organizationId: ORG_ID, invoiceId: INVOICE_ID, documentVersion: 1, archiveId: ARCHIVE_ID };

  it("calls storage.from('attachments').createSignedUrl(rebuiltPath, 60, { download: safeFilename }) and succeeds", async () => {
    const originalTestMode = process.env.TEST_MODE;
    try {
      delete process.env.TEST_MODE;
      vi.resetModules();
      const {
        createInvoicePdfSignedUrl: signProd,
        buildInvoicePdfStoragePath: buildPathProd,
        buildInvoicePdfDownloadFilename: buildFilenameProd,
      } = await import("@/lib/invoices/pdf/storage");

      const createSignedUrlMock = vi.fn().mockResolvedValue({ data: { signedUrl: "https://storage.example.test/signed/mock.pdf" }, error: null });
      const fromMock = vi.fn().mockReturnValue({ createSignedUrl: createSignedUrlMock });
      const fakeClient = { storage: { from: fromMock } } as unknown as Parameters<typeof signProd>[1];

      const result = await signProd({ identity: prodIdentity, invoiceNumber: "INV-2026-001" }, fakeClient);

      expect(result).toEqual({ ok: true, url: "https://storage.example.test/signed/mock.pdf" });
      expect(fromMock).toHaveBeenCalledWith("attachments");
      expect(createSignedUrlMock).toHaveBeenCalledWith(buildPathProd(prodIdentity), 60, {
        download: buildFilenameProd("INV-2026-001"),
      });
    } finally {
      process.env.TEST_MODE = originalTestMode;
      vi.resetModules();
    }
  });

  it("returns storage_not_configured when no client can be resolved and none is injected", async () => {
    const originalTestMode = process.env.TEST_MODE;
    try {
      delete process.env.TEST_MODE;
      vi.resetModules();
      const { createInvoicePdfSignedUrl: signProd } = await import("@/lib/invoices/pdf/storage");

      // No client injected, and no real Supabase admin client is
      // configured in this test environment — resolveClient() falls
      // through to its own catch branch.
      const result = await signProd({ identity: prodIdentity, invoiceNumber: "INV-2026-001" });
      expect(result).toEqual({ ok: false, reason: "storage_not_configured" });
    } finally {
      process.env.TEST_MODE = originalTestMode;
      vi.resetModules();
    }
  });

  it("maps a returned provider error to signed_url_failed", async () => {
    const originalTestMode = process.env.TEST_MODE;
    try {
      delete process.env.TEST_MODE;
      vi.resetModules();
      const { createInvoicePdfSignedUrl: signProd } = await import("@/lib/invoices/pdf/storage");

      const fakeClient = {
        storage: {
          from: vi.fn().mockReturnValue({
            createSignedUrl: vi.fn().mockResolvedValue({ data: null, error: { message: "provider rejected" } }),
          }),
        },
      } as unknown as Parameters<typeof signProd>[1];

      const result = await signProd({ identity: prodIdentity, invoiceNumber: "INV-2026-001" }, fakeClient);
      expect(result).toEqual({ ok: false, reason: "signed_url_failed" });
    } finally {
      process.env.TEST_MODE = originalTestMode;
      vi.resetModules();
    }
  });

  it("maps a thrown provider error to signed_url_failed, never letting the raw exception escape", async () => {
    const originalTestMode = process.env.TEST_MODE;
    try {
      delete process.env.TEST_MODE;
      vi.resetModules();
      const { createInvoicePdfSignedUrl: signProd } = await import("@/lib/invoices/pdf/storage");

      const fakeClient = {
        storage: {
          from: vi.fn().mockReturnValue({
            createSignedUrl: vi.fn().mockRejectedValue(new Error("network failure")),
          }),
        },
      } as unknown as Parameters<typeof signProd>[1];

      const result = await signProd({ identity: prodIdentity, invoiceNumber: "INV-2026-001" }, fakeClient);
      expect(result).toEqual({ ok: false, reason: "signed_url_failed" });
    } finally {
      process.env.TEST_MODE = originalTestMode;
      vi.resetModules();
    }
  });

  it("maps a missing/empty signedUrl to signed_url_failed even when no error is reported", async () => {
    const originalTestMode = process.env.TEST_MODE;
    try {
      delete process.env.TEST_MODE;
      vi.resetModules();
      const { createInvoicePdfSignedUrl: signProd } = await import("@/lib/invoices/pdf/storage");

      const fakeClient = {
        storage: {
          from: vi.fn().mockReturnValue({
            createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: "" }, error: null }),
          }),
        },
      } as unknown as Parameters<typeof signProd>[1];

      const result = await signProd({ identity: prodIdentity, invoiceNumber: "INV-2026-001" }, fakeClient);
      expect(result).toEqual({ ok: false, reason: "signed_url_failed" });
    } finally {
      process.env.TEST_MODE = originalTestMode;
      vi.resetModules();
    }
  });
});

// Invoice System Slice 4, PR 4a — the identity-only byte-read operation
// added for the (still-unwired) future send-invoice-email path.
describe("downloadInvoicePdfObject — TEST_MODE branch", () => {
  it("returns the exact bytes previously uploaded", async () => {
    const archiveId = "ffffffff-1111-4fff-8fff-ffffffffffff";
    const body = Buffer.from("%PDF-1.3 exact bytes to download");
    await uploadInvoicePdfObject({ identity: identity(archiveId), body });

    const result = await downloadInvoicePdfObject({ identity: identity(archiveId) });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.bytes.equals(body)).toBe(true);
    expect(result.contentType).toBe("application/pdf");
  });

  it("returns not_found for an object never uploaded", async () => {
    const archiveId = "aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaab";
    const result = await downloadInvoicePdfObject({ identity: identity(archiveId) });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found after the object has been removed", async () => {
    const archiveId = "bbbbbbbb-3333-4bbb-8bbb-bbbbbbbbbbbc";
    await uploadInvoicePdfObject({ identity: identity(archiveId), body: Buffer.from("%PDF-1.3 to be removed") });
    await removeInvoicePdfObject({ identity: identity(archiveId) });

    const result = await downloadInvoicePdfObject({ identity: identity(archiveId) });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("never confuses a different identity's object with this one's absence", async () => {
    const targetArchiveId = "cccccccc-4444-4ccc-8ccc-ccccccccccce";
    const otherArchiveId = "dddddddd-5555-4ddd-8ddd-ddddddddddde";
    await uploadInvoicePdfObject({ identity: identity(otherArchiveId), body: Buffer.from("%PDF-1.3 unrelated") });

    const result = await downloadInvoicePdfObject({ identity: identity(targetArchiveId) });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects an invalid PDF signature found on the stored object — bounded invalid_object, never the raw byte content", async () => {
    // uploadInvoicePdfObject() itself performs no signature validation, so
    // a non-PDF payload is written directly via testStorageUpload() to
    // simulate a corrupted/tampered stored object.
    const { testStorageUpload } = await import("@/lib/storage/test-storage");
    const archiveId = "eeeeeeee-6666-4eee-8eee-eeeeeeeeeeef";
    const path = buildInvoicePdfStoragePath(identity(archiveId));
    testStorageUpload("attachments", path, Buffer.from("not a pdf at all"), "application/pdf");

    const result = await downloadInvoicePdfObject({ identity: identity(archiveId) });
    expect(result).toEqual({ ok: false, reason: "invalid_object" });
  });

  it("rejects a stored object exactly one byte over MAX_PDF_BYTES", async () => {
    const { testStorageUpload } = await import("@/lib/storage/test-storage");
    const archiveId = "ffffffff-7777-4fff-8fff-fffffffffff0";
    const oversized = Buffer.concat([Buffer.from("%PDF-1.3"), Buffer.alloc(MAX_PDF_BYTES - 8 + 1, 0x41)]);
    expect(oversized.length).toBe(MAX_PDF_BYTES + 1);
    const path = buildInvoicePdfStoragePath(identity(archiveId));
    testStorageUpload("attachments", path, oversized, "application/pdf");

    const result = await downloadInvoicePdfObject({ identity: identity(archiveId) });
    expect(result).toEqual({ ok: false, reason: "invalid_object" });
  });

  it("accepts a stored object at exactly MAX_PDF_BYTES", async () => {
    const { testStorageUpload } = await import("@/lib/storage/test-storage");
    const archiveId = "aaaaaaaa-8888-4aaa-8aaa-aaaaaaaaaaa1";
    const exact = Buffer.concat([Buffer.from("%PDF-1.3"), Buffer.alloc(MAX_PDF_BYTES - 8, 0x41)]);
    expect(exact.length).toBe(MAX_PDF_BYTES);
    const path = buildInvoicePdfStoragePath(identity(archiveId));
    testStorageUpload("attachments", path, exact, "application/pdf");

    const result = await downloadInvoicePdfObject({ identity: identity(archiveId) });
    expect(result.ok).toBe(true);
  });

  it("never calls a Supabase client — the TEST_MODE branch returns before any client is resolved, even when one is explicitly supplied", async () => {
    const archiveId = "bbbbbbbb-9999-4bbb-8bbb-bbbbbbbbbbb2";
    await uploadInvoicePdfObject({ identity: identity(archiveId), body: Buffer.from("%PDF-1.3 present") });

    const fromSpy = vi.fn();
    const fakeClient = { storage: { from: fromSpy } } as unknown as Parameters<typeof downloadInvoicePdfObject>[1];

    const result = await downloadInvoicePdfObject({ identity: identity(archiveId) }, fakeClient);
    expect(result.ok).toBe(true);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("rejects an invalid structured identity before any external call", async () => {
    await expect(
      downloadInvoicePdfObject({ identity: { organizationId: "not-a-uuid", invoiceId: INVOICE_ID, documentVersion: 1, archiveId: ARCHIVE_ID } }),
    ).rejects.toThrow(/organizationId/);
  });
});

describe("downloadInvoicePdfObject — production adapter", () => {
  const prodIdentity = { organizationId: ORG_ID, invoiceId: INVOICE_ID, documentVersion: 1, archiveId: ARCHIVE_ID };

  async function withProdDownload(run: (downloadProd: typeof downloadInvoicePdfObject) => Promise<void>) {
    const originalTestMode = process.env.TEST_MODE;
    try {
      delete process.env.TEST_MODE;
      vi.resetModules();
      const { downloadInvoicePdfObject: downloadProd } = await import("@/lib/invoices/pdf/storage");
      await run(downloadProd);
    } finally {
      process.env.TEST_MODE = originalTestMode;
      vi.resetModules();
    }
  }

  function fakeBlob(bytes: Buffer) {
    return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  }

  it("downloads the exact bytes on success via storage.from(bucket).download(path)", async () => {
    await withProdDownload(async (downloadProd) => {
      const body = Buffer.from("%PDF-1.3 production bytes");
      const downloadMock = vi.fn().mockResolvedValue({ data: fakeBlob(body), error: null });
      const fromMock = vi.fn().mockReturnValue({ download: downloadMock });
      const fakeClient = { storage: { from: fromMock } } as unknown as Parameters<typeof downloadProd>[1];

      const result = await downloadProd({ identity: prodIdentity }, fakeClient);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.bytes.equals(body)).toBe(true);
      expect(result.contentType).toBe("application/pdf");
      expect(fromMock).toHaveBeenCalledWith("attachments");
      expect(downloadMock).toHaveBeenCalledWith(buildInvoicePdfStoragePath(prodIdentity));
    });
  });

  it("error.status 404 -> not_found (confirmed absent)", async () => {
    await withProdDownload(async (downloadProd) => {
      const downloadMock = vi.fn().mockResolvedValue({ data: null, error: { status: 404, message: "not found" } });
      const fakeClient = { storage: { from: vi.fn().mockReturnValue({ download: downloadMock }) } } as unknown as Parameters<typeof downloadProd>[1];

      const result = await downloadProd({ identity: prodIdentity }, fakeClient);
      expect(result).toEqual({ ok: false, reason: "not_found" });
    });
  });

  it("error.status other than 404 -> download_failed, never inferred as absent", async () => {
    await withProdDownload(async (downloadProd) => {
      const downloadMock = vi.fn().mockResolvedValue({ data: null, error: { status: 500, message: "server error" } });
      const fakeClient = { storage: { from: vi.fn().mockReturnValue({ download: downloadMock }) } } as unknown as Parameters<typeof downloadProd>[1];

      const result = await downloadProd({ identity: prodIdentity }, fakeClient);
      expect(result).toEqual({ ok: false, reason: "download_failed" });
    });
  });

  it("an unexpected resolved shape (data:null, error:null) -> download_failed, never inferred as absent", async () => {
    await withProdDownload(async (downloadProd) => {
      const downloadMock = vi.fn().mockResolvedValue({ data: null, error: null });
      const fakeClient = { storage: { from: vi.fn().mockReturnValue({ download: downloadMock }) } } as unknown as Parameters<typeof downloadProd>[1];

      const result = await downloadProd({ identity: prodIdentity }, fakeClient);
      expect(result).toEqual({ ok: false, reason: "download_failed" });
    });
  });

  it("a thrown auth/network/5xx failure -> download_failed, never letting the raw exception escape", async () => {
    await withProdDownload(async (downloadProd) => {
      const downloadMock = vi.fn().mockRejectedValue(new Error("simulated network failure — must never be persisted or thrown"));
      const fakeClient = { storage: { from: vi.fn().mockReturnValue({ download: downloadMock }) } } as unknown as Parameters<typeof downloadProd>[1];

      const result = await downloadProd({ identity: prodIdentity }, fakeClient);
      expect(result).toEqual({ ok: false, reason: "download_failed" });
    });
  });

  it("maps an invalid PDF signature in the downloaded bytes to invalid_object", async () => {
    await withProdDownload(async (downloadProd) => {
      const downloadMock = vi.fn().mockResolvedValue({ data: fakeBlob(Buffer.from("not a pdf")), error: null });
      const fakeClient = { storage: { from: vi.fn().mockReturnValue({ download: downloadMock }) } } as unknown as Parameters<typeof downloadProd>[1];

      const result = await downloadProd({ identity: prodIdentity }, fakeClient);
      expect(result).toEqual({ ok: false, reason: "invalid_object" });
    });
  });

  it("no client available and none injected -> storage_not_configured, without ever calling download()", async () => {
    await withProdDownload(async (downloadProd) => {
      const result = await downloadProd({ identity: prodIdentity });
      expect(result).toEqual({ ok: false, reason: "storage_not_configured" });
    });
  });

  it("rejects an invalid structured identity before any external call", async () => {
    await withProdDownload(async (downloadProd) => {
      await expect(downloadProd({ identity: { ...prodIdentity, organizationId: "not-a-uuid" } })).rejects.toThrow(/organizationId/);
    });
  });
});
