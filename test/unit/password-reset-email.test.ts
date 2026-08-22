import { describe, expect, it } from "vitest";
import { buildPasswordResetEmailContent } from "@/lib/email/password-reset";

const CONFIRM_URL = "https://app.example.com/auth/confirm?token_hash=abc123&audience=staff";

describe("buildPasswordResetEmailContent", () => {
  it("staff audience: subject and body reference the account generically, not 'Client Portal'", () => {
    const content = buildPasswordResetEmailContent({ confirmUrl: CONFIRM_URL, audience: "staff" });
    expect(content.subject).toBe("Reset your password");
    expect(content.html).toContain("your account");
    expect(content.html).not.toContain("Client Portal");
    expect(content.text).toContain("your account");
  });

  it("portal audience: subject and body reference the Client Portal by name", () => {
    const content = buildPasswordResetEmailContent({ confirmUrl: CONFIRM_URL, audience: "portal" });
    expect(content.subject).toBe("Reset your Client Portal password");
    expect(content.html).toContain("Client Portal");
    expect(content.text).toContain("Client Portal");
  });

  it("includes the confirm URL in the text body verbatim, and in the html body HTML-escaped", () => {
    const content = buildPasswordResetEmailContent({ confirmUrl: CONFIRM_URL, audience: "staff" });
    expect(content.text).toContain(CONFIRM_URL);
    expect(content.html).toContain(CONFIRM_URL.replace(/&/g, "&amp;"));
  });

  it("escapes HTML-significant characters in the URL within the html body", () => {
    const maliciousUrl = 'https://app.example.com/auth/confirm?token_hash=<script>&audience="staff"';
    const content = buildPasswordResetEmailContent({ confirmUrl: maliciousUrl, audience: "staff" });
    expect(content.html).not.toContain("<script>");
    expect(content.html).toContain("&lt;script&gt;");
  });

  it("states the link expires in 1 hour and is single-use", () => {
    const content = buildPasswordResetEmailContent({ confirmUrl: CONFIRM_URL, audience: "staff" });
    expect(content.html).toContain("expires in 1 hour");
    expect(content.html).toContain("used once");
    expect(content.text).toContain("expires in 1 hour");
  });

  it("reassures a recipient who didn't request this that nothing happens if ignored", () => {
    const content = buildPasswordResetEmailContent({ confirmUrl: CONFIRM_URL, audience: "staff" });
    expect(content.html).toContain("safely ignore");
    expect(content.text).toContain("safely ignore");
  });

  it("includes the shared legal footer (Privacy Policy / Terms of Service links) in both bodies", () => {
    const content = buildPasswordResetEmailContent({ confirmUrl: CONFIRM_URL, audience: "staff" });
    expect(content.html).toContain("/privacy");
    expect(content.html).toContain("/terms");
    expect(content.text).toContain("Privacy Policy:");
    expect(content.text).toContain("Terms of Service:");
  });
});
