import { describe, expect, it } from "vitest";
import { sanitizeRedirectPath, sanitizePortalRedirectPath } from "@/lib/safe-redirect";

describe("sanitizeRedirectPath", () => {
  it("accepts a valid staff path", () => {
    expect(sanitizeRedirectPath("/team")).toBe("/team");
  });

  it("accepts a valid path with a query string", () => {
    expect(sanitizeRedirectPath("/clients?status=active")).toBe("/clients?status=active");
  });

  it("accepts a valid portal path", () => {
    expect(sanitizeRedirectPath("/portal/invite/abc123")).toBe("/portal/invite/abc123");
  });

  it("falls back to /dashboard by default", () => {
    expect(sanitizeRedirectPath(null)).toBe("/dashboard");
    expect(sanitizeRedirectPath(undefined)).toBe("/dashboard");
    expect(sanitizeRedirectPath("")).toBe("/dashboard");
  });

  it("honors a custom fallback", () => {
    expect(sanitizeRedirectPath(null, "/custom")).toBe("/custom");
    expect(sanitizeRedirectPath("", "/custom")).toBe("/custom");
  });

  it("rejects an absolute URL", () => {
    expect(sanitizeRedirectPath("https://evil.com")).toBe("/dashboard");
    expect(sanitizeRedirectPath("http://evil.com/x")).toBe("/dashboard");
  });

  it("rejects a protocol-relative URL", () => {
    expect(sanitizeRedirectPath("//evil.com")).toBe("/dashboard");
  });

  it("rejects backslash variants some browsers normalize into cross-origin URLs", () => {
    expect(sanitizeRedirectPath("/\\evil.com")).toBe("/dashboard");
    expect(sanitizeRedirectPath("\\evil.com")).toBe("/dashboard");
    expect(sanitizeRedirectPath("\\/evil.com")).toBe("/dashboard");
  });

  it("rejects embedded CRLF (header/response-splitting attempts)", () => {
    expect(sanitizeRedirectPath("/team\r\nSet-Cookie: x=1")).toBe("/dashboard");
    expect(sanitizeRedirectPath("/team\n")).toBe("/dashboard");
    expect(sanitizeRedirectPath("/team\r")).toBe("/dashboard");
  });

  it("rejects non-string values", () => {
    expect(sanitizeRedirectPath(["/team"] as unknown as string)).toBe("/dashboard");
    expect(sanitizeRedirectPath(123 as unknown as string)).toBe("/dashboard");
    expect(sanitizeRedirectPath({} as unknown as string)).toBe("/dashboard");
  });

  it("rejects a bare relative path with no leading slash", () => {
    expect(sanitizeRedirectPath("team")).toBe("/dashboard");
  });
});

describe("sanitizePortalRedirectPath", () => {
  it("accepts the portal root", () => {
    expect(sanitizePortalRedirectPath("/portal")).toBe("/portal");
  });

  it("accepts a nested portal path", () => {
    expect(sanitizePortalRedirectPath("/portal/invite/abc123")).toBe("/portal/invite/abc123");
  });

  it("rejects a staff path, even though it's a valid same-origin path", () => {
    expect(sanitizePortalRedirectPath("/dashboard")).toBe("/portal");
    expect(sanitizePortalRedirectPath("/team")).toBe("/portal");
  });

  it("rejects a path that merely starts with the string 'portal' without the boundary slash", () => {
    expect(sanitizePortalRedirectPath("/portalX")).toBe("/portal");
    expect(sanitizePortalRedirectPath("/portal-admin")).toBe("/portal");
  });

  it("falls back to /portal for open-redirect attempts", () => {
    expect(sanitizePortalRedirectPath("//evil.com")).toBe("/portal");
    expect(sanitizePortalRedirectPath("https://evil.com")).toBe("/portal");
  });

  it("falls back to /portal for empty/invalid input", () => {
    expect(sanitizePortalRedirectPath(null)).toBe("/portal");
    expect(sanitizePortalRedirectPath(undefined)).toBe("/portal");
    expect(sanitizePortalRedirectPath("")).toBe("/portal");
  });
});
