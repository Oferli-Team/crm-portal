import { describe, expect, it } from "vitest";
import {
  validateLogoFile,
  buildLogoStoragePath,
  extractLogoStoragePathFromPublicUrl,
} from "@/lib/storage/logo-files";
import { ALLOWED_LOGO_TYPES, MAX_LOGO_SIZE_BYTES, LOGO_BUCKET } from "@/lib/storage/logo-config";

const VALID_UUID_A = "11111111-1111-1111-1111-111111111111";
const VALID_UUID_B = "22222222-2222-2222-2222-222222222222";

function makeLogoFile(overrides: Partial<{ name: string; type: string; size: number }> = {}) {
  return { name: "logo.png", type: "image/png", size: 1024, ...overrides };
}

describe("validateLogoFile", () => {
  it.each(ALLOWED_LOGO_TYPES.flatMap((type) => type.extensions.map((ext) => [type.mimeType, ext])))(
    "accepts %s with a matching .%s extension",
    (mimeType, extension) => {
      const result = validateLogoFile(makeLogoFile({ name: `logo.${extension}`, type: mimeType, size: 1024 }));
      expect(result).toEqual({ valid: true, mimeType, extension });
    },
  );

  it.each([
    ["svg (can carry embedded scripts)", "image/svg+xml", "icon.svg"],
    ["gif", "image/gif", "animated.gif"],
    ["pdf", "application/pdf", "document.pdf"],
    ["executable", "application/x-msdownload", "malware.exe"],
    ["html", "text/html", "page.html"],
  ])("rejects a forbidden %s type as type_not_allowed", (_label, type, name) => {
    const result = validateLogoFile(makeLogoFile({ name, type, size: 1024 }));
    expect(result).toEqual({ valid: false, error: "type_not_allowed" });
  });

  it("rejects a MIME/extension mismatch as extension_mismatch, not type_not_allowed", () => {
    const result = validateLogoFile(makeLogoFile({ name: "logo.png", type: "image/webp" }));
    expect(result).toEqual({ valid: false, error: "extension_mismatch" });
  });

  it("rejects a renamed executable declaring an allowed MIME type", () => {
    const result = validateLogoFile(makeLogoFile({ name: "totally-safe.exe", type: "image/png" }));
    expect(result).toEqual({ valid: false, error: "extension_mismatch" });
  });

  it("rejects a zero-byte file", () => {
    const result = validateLogoFile(makeLogoFile({ size: 0 }));
    expect(result).toEqual({ valid: false, error: "empty_file" });
  });

  it("accepts a file exactly at the 2 MB size limit", () => {
    expect(MAX_LOGO_SIZE_BYTES).toBe(2 * 1024 * 1024);
    const result = validateLogoFile(makeLogoFile({ size: MAX_LOGO_SIZE_BYTES }));
    expect(result.valid).toBe(true);
  });

  it("rejects an oversized file (one byte above the 2 MB limit)", () => {
    const result = validateLogoFile(makeLogoFile({ size: MAX_LOGO_SIZE_BYTES + 1 }));
    expect(result).toEqual({ valid: false, error: "file_too_large" });
  });

  it("rejects a wildly oversized file", () => {
    const result = validateLogoFile(makeLogoFile({ size: 50 * 1024 * 1024 }));
    expect(result).toEqual({ valid: false, error: "file_too_large" });
  });

  it("handles extensions case-insensitively", () => {
    const result = validateLogoFile(makeLogoFile({ name: "LOGO.PNG", type: "image/png" }));
    expect(result).toEqual({ valid: true, mimeType: "image/png", extension: "png" });
  });

  it("does NOT treat MIME types case-insensitively (matches validateAttachmentFile's own stricter contract)", () => {
    const result = validateLogoFile(makeLogoFile({ type: "IMAGE/PNG" }));
    expect(result).toEqual({ valid: false, error: "type_not_allowed" });
  });

  it("accepts both .jpg and .jpeg for image/jpeg", () => {
    expect(validateLogoFile(makeLogoFile({ name: "logo.jpg", type: "image/jpeg" })).valid).toBe(true);
    expect(validateLogoFile(makeLogoFile({ name: "logo.jpeg", type: "image/jpeg" })).valid).toBe(true);
  });
});

describe("buildLogoStoragePath", () => {
  it("builds the exact required structure: organizations/{organizationId}/logo/{uuid}.{extension}", () => {
    expect(buildLogoStoragePath({ organizationId: VALID_UUID_A, uuid: VALID_UUID_B, extension: "png" })).toBe(
      `organizations/${VALID_UUID_A}/logo/${VALID_UUID_B}.png`,
    );
  });

  it("produces a different path for a different uuid", () => {
    const pathA = buildLogoStoragePath({ organizationId: VALID_UUID_A, uuid: VALID_UUID_B, extension: "png" });
    const pathB = buildLogoStoragePath({
      organizationId: VALID_UUID_A,
      uuid: "33333333-3333-3333-3333-333333333333",
      extension: "png",
    });
    expect(pathA).not.toBe(pathB);
  });

  it.each(["organizationId", "uuid"] as const)("rejects an invalid (non-UUID) %s", (field) => {
    const baseArgs = { organizationId: VALID_UUID_A, uuid: VALID_UUID_B, extension: "png" };
    expect(() => buildLogoStoragePath({ ...baseArgs, [field]: "../../etc/passwd" })).toThrow();
    expect(() => buildLogoStoragePath({ ...baseArgs, [field]: "not-a-uuid" })).toThrow();
  });

  it("never trusts a client-supplied filename — path is built entirely from server-controlled inputs", () => {
    // buildLogoStoragePath has no `name`/`fileName` parameter at all — this
    // test documents that contract rather than exercising a specific check.
    const path = buildLogoStoragePath({ organizationId: VALID_UUID_A, uuid: VALID_UUID_B, extension: "png" });
    expect(path).toBe(`organizations/${VALID_UUID_A}/logo/${VALID_UUID_B}.png`);
  });
});

describe("extractLogoStoragePathFromPublicUrl", () => {
  const supabaseUrl = "https://example.supabase.co";

  it("recovers the exact path from a well-formed Supabase public URL", () => {
    const path = `organizations/${VALID_UUID_A}/logo/${VALID_UUID_B}.png`;
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${LOGO_BUCKET}/${path}`;
    expect(extractLogoStoragePathFromPublicUrl({ publicUrl, supabaseUrl, bucket: LOGO_BUCKET })).toBe(path);
  });

  it("tolerates a trailing slash on supabaseUrl", () => {
    const path = `organizations/${VALID_UUID_A}/logo/${VALID_UUID_B}.png`;
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${LOGO_BUCKET}/${path}`;
    expect(extractLogoStoragePathFromPublicUrl({ publicUrl, supabaseUrl: `${supabaseUrl}/`, bucket: LOGO_BUCKET })).toBe(
      path,
    );
  });

  it("returns null for a URL from a different bucket", () => {
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/attachments/some/path.png`;
    expect(extractLogoStoragePathFromPublicUrl({ publicUrl, supabaseUrl, bucket: LOGO_BUCKET })).toBeNull();
  });

  it("returns null for a URL from a different Supabase project", () => {
    const publicUrl = `https://other-project.supabase.co/storage/v1/object/public/${LOGO_BUCKET}/logo.png`;
    expect(extractLogoStoragePathFromPublicUrl({ publicUrl, supabaseUrl, bucket: LOGO_BUCKET })).toBeNull();
  });

  it("returns null for a completely unrelated string", () => {
    expect(
      extractLogoStoragePathFromPublicUrl({ publicUrl: "not-a-url-at-all", supabaseUrl, bucket: LOGO_BUCKET }),
    ).toBeNull();
  });

  it("returns null for the prefix with nothing after it", () => {
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${LOGO_BUCKET}/`;
    expect(extractLogoStoragePathFromPublicUrl({ publicUrl, supabaseUrl, bucket: LOGO_BUCKET })).toBeNull();
  });
});
