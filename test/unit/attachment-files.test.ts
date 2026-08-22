import { describe, expect, it } from "vitest";
import {
  sanitizeAttachmentFileName,
  validateAttachmentFile,
  buildAttachmentStoragePath,
} from "@/lib/storage/attachment-files";
import { ALLOWED_ATTACHMENT_TYPES, MAX_ATTACHMENT_SIZE_BYTES } from "@/lib/storage/attachments-config";
import { makeAttachmentFile } from "../support/fixtures";

const VALID_UUID_A = "11111111-1111-1111-1111-111111111111";
const VALID_UUID_B = "22222222-2222-2222-2222-222222222222";
const VALID_UUID_C = "33333333-3333-3333-3333-333333333333";

describe("sanitizeAttachmentFileName", () => {
  it("strips path separators and never leaves one in the result", () => {
    const result = sanitizeAttachmentFileName("../../etc/passwd");
    expect(result).not.toMatch(/[/\\]/);
  });

  it("strips backslashes the same way as forward slashes", () => {
    const result = sanitizeAttachmentFileName("..\\..\\windows\\system32\\evil.exe");
    expect(result).not.toMatch(/[/\\]/);
  });

  it("strips null bytes and other control characters", () => {
    expect(sanitizeAttachmentFileName("file\x00name.txt")).toBe("filename.txt");
    expect(sanitizeAttachmentFileName("file\x01\x02\x1f.txt")).toBe("file.txt");
  });

  it("strips embedded CRLF (header-injection attempts)", () => {
    expect(sanitizeAttachmentFileName("file\r\nname.txt")).toBe("filename.txt");
  });

  it("collapses whitespace runs to a single space", () => {
    expect(sanitizeAttachmentFileName("file   name.txt")).toBe("file name.txt");
  });

  it("collapses a dots-only name to the fallback, not an empty or hidden-file name", () => {
    expect(sanitizeAttachmentFileName("...")).toBe("file");
    expect(sanitizeAttachmentFileName("..")).toBe("file");
  });

  it("falls back to 'file' for an empty name", () => {
    expect(sanitizeAttachmentFileName("")).toBe("file");
  });

  it("strips leading dots so the result is never a hidden file", () => {
    const result = sanitizeAttachmentFileName("...secret.txt");
    expect(result.startsWith(".")).toBe(false);
  });

  it("truncates a long file name while preserving a short extension", () => {
    const longName = "a".repeat(200) + ".pdf";
    const result = sanitizeAttachmentFileName(longName);
    expect(result.length).toBe(150);
    expect(result.endsWith(".pdf")).toBe(true);
  });

  it("truncates a long extension-less name to the max length", () => {
    const longName = "a".repeat(200);
    const result = sanitizeAttachmentFileName(longName);
    expect(result.length).toBe(150);
  });

  it("preserves a normal, short file name and its extension exactly", () => {
    expect(sanitizeAttachmentFileName("photo.JPG")).toBe("photo.JPG");
  });

  it("preserves unicode file names", () => {
    expect(sanitizeAttachmentFileName("café résumé.pdf")).toBe("café résumé.pdf");
  });

  it("never returns a result containing a path separator, across a battery of hostile inputs", () => {
    const hostileInputs = [
      "../../../etc/passwd",
      "..\\..\\..\\windows\\win.ini",
      "/etc/passwd",
      "C:\\Windows\\System32\\config",
      "a/b\\c/d",
    ];
    for (const input of hostileInputs) {
      expect(sanitizeAttachmentFileName(input)).not.toMatch(/[/\\]/);
    }
  });
});

describe("validateAttachmentFile", () => {
  it.each(ALLOWED_ATTACHMENT_TYPES.flatMap((type) => type.extensions.map((ext) => [type.mimeType, ext])))(
    "accepts %s with a matching .%s extension",
    (mimeType, extension) => {
      const result = validateAttachmentFile(
        makeAttachmentFile({ name: `document.${extension}`, type: mimeType, size: 1024 }),
      );
      expect(result).toEqual({ valid: true, mimeType, extension });
    },
  );

  it.each([
    ["executable", "application/x-msdownload", "malware.exe"],
    ["shell script", "application/x-sh", "install.sh"],
    ["javascript", "text/javascript", "payload.js"],
    ["zip archive", "application/zip", "bundle.zip"],
    ["html", "text/html", "page.html"],
    ["svg (can carry embedded scripts)", "image/svg+xml", "icon.svg"],
  ])("rejects a forbidden %s type as type_not_allowed", (_label, type, name) => {
    const result = validateAttachmentFile(makeAttachmentFile({ name, type, size: 1024 }));
    expect(result).toEqual({ valid: false, error: "type_not_allowed" });
  });

  it("rejects a MIME/extension mismatch as extension_mismatch, not type_not_allowed", () => {
    // The MIME type itself is allowed (text/plain), but the extension
    // doesn't belong to that same allowlist entry.
    const result = validateAttachmentFile(
      makeAttachmentFile({ name: "report.pdf", type: "text/plain", size: 1024 }),
    );
    expect(result).toEqual({ valid: false, error: "extension_mismatch" });
  });

  it("rejects a renamed executable declaring an allowed MIME type", () => {
    const result = validateAttachmentFile(
      makeAttachmentFile({ name: "totally-safe.exe", type: "application/pdf", size: 1024 }),
    );
    expect(result).toEqual({ valid: false, error: "extension_mismatch" });
  });

  it("rejects a zero-byte file", () => {
    const result = validateAttachmentFile(makeAttachmentFile({ size: 0 }));
    expect(result).toEqual({ valid: false, error: "empty_file" });
  });

  it("accepts a file exactly at the size limit", () => {
    const result = validateAttachmentFile(makeAttachmentFile({ size: MAX_ATTACHMENT_SIZE_BYTES }));
    expect(result.valid).toBe(true);
  });

  it("rejects a file one byte above the size limit", () => {
    const result = validateAttachmentFile(makeAttachmentFile({ size: MAX_ATTACHMENT_SIZE_BYTES + 1 }));
    expect(result).toEqual({ valid: false, error: "file_too_large" });
  });

  it("rejects a missing/empty file name as extension_mismatch (no extension to check)", () => {
    const result = validateAttachmentFile(makeAttachmentFile({ name: "" }));
    expect(result).toEqual({ valid: false, error: "extension_mismatch" });
  });

  it("rejects a missing/empty MIME type as type_not_allowed", () => {
    const result = validateAttachmentFile(makeAttachmentFile({ type: "" }));
    expect(result).toEqual({ valid: false, error: "type_not_allowed" });
  });

  it("handles extensions case-insensitively", () => {
    const result = validateAttachmentFile(
      makeAttachmentFile({ name: "PHOTO.PNG", type: "image/png", size: 1024 }),
    );
    expect(result).toEqual({ valid: true, mimeType: "image/png", extension: "png" });
  });

  it("does NOT treat MIME types case-insensitively (documents the current, stricter contract)", () => {
    const result = validateAttachmentFile(
      makeAttachmentFile({ name: "photo.png", type: "IMAGE/PNG", size: 1024 }),
    );
    expect(result).toEqual({ valid: false, error: "type_not_allowed" });
  });
});

describe("buildAttachmentStoragePath", () => {
  const baseArgs = {
    organizationId: VALID_UUID_A,
    entityType: "CLIENT" as const,
    entityId: VALID_UUID_B,
    attachmentId: VALID_UUID_C,
    safeFileName: "report.pdf",
  };

  it("builds the expected structure", () => {
    expect(buildAttachmentStoragePath(baseArgs)).toBe(
      `organizations/${VALID_UUID_A}/CLIENT/${VALID_UUID_B}/${VALID_UUID_C}/report.pdf`,
    );
  });

  it("produces a different path for a different attachmentId with the same file name", () => {
    const pathA = buildAttachmentStoragePath({ ...baseArgs, attachmentId: VALID_UUID_C });
    const pathB = buildAttachmentStoragePath({
      ...baseArgs,
      attachmentId: "44444444-4444-4444-4444-444444444444",
    });
    expect(pathA).not.toBe(pathB);
  });

  it("uses the safeFileName verbatim, without re-sanitizing it", () => {
    const path = buildAttachmentStoragePath({ ...baseArgs, safeFileName: "already sanitized name.pdf" });
    expect(path.endsWith("/already sanitized name.pdf")).toBe(true);
  });

  it.each(["organizationId", "entityId", "attachmentId"] as const)(
    "rejects an invalid (non-UUID) %s",
    (field) => {
      expect(() => buildAttachmentStoragePath({ ...baseArgs, [field]: "../../etc/passwd" })).toThrow();
      expect(() => buildAttachmentStoragePath({ ...baseArgs, [field]: "not-a-uuid" })).toThrow();
    },
  );

  it.each(["CLIENT", "PROJECT", "INVOICE"] as const)("embeds the %s entityType correctly", (entityType) => {
    const path = buildAttachmentStoragePath({ ...baseArgs, entityType });
    expect(path).toContain(`/${entityType}/`);
  });
});
