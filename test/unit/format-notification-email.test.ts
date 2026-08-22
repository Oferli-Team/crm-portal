import { describe, expect, it } from "vitest";
import { formatNotificationEmail } from "@/lib/notifications/email/format-notification-email";
import type { NotificationType } from "@/generated/prisma/enums";

const CTA = "https://app.example.com/team";

function email(type: NotificationType, metadata: unknown, overrides: Partial<{ entityId: string | null; organizationName: string; ctaUrl: string }> = {}) {
  return formatNotificationEmail({
    type,
    metadata,
    entityId: overrides.entityId ?? null,
    organizationName: overrides.organizationName ?? "Acme Corp",
    ctaUrl: overrides.ctaUrl ?? CTA,
  });
}

describe("formatNotificationEmail — one happy path per deliverable type", () => {
  it("ROLE_CHANGED", () => {
    const result = email("ROLE_CHANGED", { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN" });
    expect(result.subject).toBe("Your role changed in Acme Corp");
    expect(result.text).toContain("Jane Doe changed your role from MEMBER to ADMIN in Acme Corp.");
  });

  it("OWNERSHIP_TRANSFERRED", () => {
    const result = email("OWNERSHIP_TRANSFERRED", {
      actorName: "Jane Doe",
      previousOwnerName: "Jane Doe",
      newOwnerName: "John Smith",
    });
    expect(result.subject).toBe("You're the new owner of Acme Corp");
    expect(result.text).toContain("previously Jane Doe");
  });

  it("MEMBER_REMOVED", () => {
    const result = email("MEMBER_REMOVED", { actorName: "Jane Doe" });
    expect(result.subject).toBe("You were removed from Acme Corp");
    expect(result.text).toContain("Jane Doe removed you from Acme Corp.");
  });

  it("PORTAL_INVITATION_ACCEPTED", () => {
    const result = email("PORTAL_INVITATION_ACCEPTED", {
      acceptedUserName: "Alice Client",
      email: "alice@example.com",
      clientName: "Acme Client",
    });
    expect(result.subject).toBe("Alice Client accepted Client Portal access");
    expect(result.text).toContain("Alice Client (alice@example.com) accepted Client Portal access for Acme Client.");
  });

  it("INVOICE_STATUS_CHANGED", () => {
    const result = email("INVOICE_STATUS_CHANGED", {
      actorName: "Jane Doe",
      invoiceNumber: "INV-042",
      from: "SENT",
      to: "PAID",
      projectName: "Website Redesign",
    });
    expect(result.subject).toBe("Invoice INV-042 status changed");
    expect(result.text).toContain("Jane Doe changed invoice INV-042 (Website Redesign) status from Issued to Paid.");
  });

  it("MENTIONED on a project", () => {
    const result = email("MENTIONED", {
      actorName: "Jane Doe",
      commentPreview: "Can you take a look at this?",
      parentEntityType: "PROJECT",
      parentEntityLabel: "Website Redesign",
    });
    expect(result.subject).toBe("Jane Doe mentioned you in a comment");
    expect(result.text).toContain('Jane Doe mentioned you in a comment on project Website Redesign: "Can you take a look at this?"');
  });

  it("MENTIONED on a task", () => {
    const result = email("MENTIONED", {
      actorName: "Jane Doe",
      commentPreview: "",
      parentEntityType: "TASK",
      parentEntityLabel: "Fix login bug",
    });
    expect(result.subject).toBe("Jane Doe mentioned you in a comment");
    expect(result.text).toContain("Jane Doe mentioned you in a comment on task Fix login bug.");
  });

  it("MENTIONED with no parentEntityLabel falls back to the generic subject/body", () => {
    const result = email("MENTIONED", { actorName: "Jane Doe", commentPreview: "hi" });
    expect(result.subject).toBe("New notification");
  });

  it("SUBSCRIPTION_ACTIVATED", () => {
    const result = email("SUBSCRIPTION_ACTIVATED", { planName: "Pro" });
    expect(result.subject).toBe("Your Pro plan is active");
    expect(result.text).toContain("Your Pro plan for Acme Corp is now active.");
  });

  it("PAYMENT_FAILED", () => {
    const result = email("PAYMENT_FAILED", { planName: "Pro" });
    expect(result.subject).toBe("Payment failed for Acme Corp");
    expect(result.text).toContain("A payment failed for Acme Corp (Pro plan). Update your payment method to avoid losing access.");
  });

  it("SUBSCRIPTION_CANCELED", () => {
    const result = email("SUBSCRIPTION_CANCELED", { planName: "Starter" });
    expect(result.subject).toBe("Your subscription was canceled");
    expect(result.text).toContain("The subscription for Acme Corp (Starter plan) was canceled.");
  });

  it("PLAN_CHANGED", () => {
    const result = email("PLAN_CHANGED", { planName: "Pro", previousPlanName: "Starter" });
    expect(result.subject).toBe("Your plan changed to Pro");
    expect(result.text).toContain("Acme Corp's plan changed from Starter to Pro.");
  });
});

describe("formatNotificationEmail — billing types degrade safely with no planName", () => {
  it("SUBSCRIPTION_ACTIVATED with no planName falls back to the generic subject/body", () => {
    const result = email("SUBSCRIPTION_ACTIVATED", {});
    expect(result.subject).toBe("New notification");
  });

  it("PLAN_CHANGED with no planName falls back to the generic subject/body", () => {
    const result = email("PLAN_CHANGED", {});
    expect(result.subject).toBe("New notification");
  });
});

describe("formatNotificationEmail — INVITATION_ACCEPTED (never sent, but must still degrade safely)", () => {
  it("falls back to the generic subject/body rather than throwing or building a half sentence", () => {
    const result = email("INVITATION_ACCEPTED", { actorName: "Jane Doe", acceptedUserName: "John", email: "j@example.com", role: "MEMBER" });
    expect(result.subject).toBe("New notification");
    expect(result.text).toContain("You have a new notification");
  });
});

describe("formatNotificationEmail — malformed metadata never throws", () => {
  it("metadata is null", () => {
    expect(() => email("ROLE_CHANGED", null)).not.toThrow();
    const result = email("ROLE_CHANGED", null);
    expect(result.subject).toBe("Your role changed in Acme Corp");
    expect(result.text).toContain("Someone changed your role");
  });

  it("metadata is a string", () => {
    const result = email("ROLE_CHANGED", "not an object");
    expect(result.subject).toBe("Your role changed in Acme Corp");
  });

  it("metadata is a number", () => {
    const result = email("INVOICE_STATUS_CHANGED", 42);
    expect(result.subject).toBe("New notification");
  });

  it("metadata is an array", () => {
    const result = email("MEMBER_REMOVED", ["actorName", "Jane Doe"]);
    expect(result.subject).toBe("You were removed from Acme Corp");
  });

  it("wrong-typed fields (numbers/objects instead of strings) degrade gracefully", () => {
    const result = email("ROLE_CHANGED", { actorName: 12345, from: { nested: true }, to: ["ADMIN"] });
    expect(result.text).toContain("Someone changed your role");
  });

  it("INVOICE_STATUS_CHANGED with no invoiceNumber falls all the way back", () => {
    const result = email("INVOICE_STATUS_CHANGED", { actorName: "Jane Doe", from: "SENT", to: "PAID" });
    expect(result.subject).toBe("New notification");
    expect(result.text).toContain("You have a new notification");
  });

  it("PORTAL_INVITATION_ACCEPTED with no clientName falls back", () => {
    const result = email("PORTAL_INVITATION_ACCEPTED", { acceptedUserName: "Alice", email: "a@example.com" });
    expect(result.subject).toBe("New notification");
  });
});

describe("formatNotificationEmail — HTML escaping", () => {
  it("escapes HTML-significant characters from metadata in the html body", () => {
    const result = email("ROLE_CHANGED", {
      actorName: `<script>alert('xss')</script>`,
      from: "MEMBER",
      to: "ADMIN",
    });
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
    expect(result.html).toContain("&#39;xss&#39;");
  });

  it("escapes the CTA URL in the html body too", () => {
    const result = email("ROLE_CHANGED", { actorName: "Jane" }, { ctaUrl: `https://app.example.com/team?x="><img src=x>` });
    expect(result.html).not.toContain(`"><img src=x>`);
  });

  it("the text body is not HTML-escaped (plain text has no such requirement)", () => {
    const result = email("ROLE_CHANGED", { actorName: "Jane & Co", from: "MEMBER", to: "ADMIN" });
    expect(result.text).toContain("Jane & Co");
  });
});

describe("formatNotificationEmail — subject is CRLF-safe", () => {
  it("strips embedded CR/LF from an interpolated display name", () => {
    const result = email("MEMBER_REMOVED", { actorName: "Evil\r\nBcc: attacker@evil.com" });
    expect(result.subject).not.toContain("\r");
    expect(result.subject).not.toContain("\n");
    expect(result.subject).toBe("You were removed from Acme Corp");
  });

  it("strips CR/LF from the organizationName itself", () => {
    const result = email("ROLE_CHANGED", { actorName: "Jane" }, { organizationName: "Acme\r\nX-Injected: 1" });
    expect(result.subject).not.toMatch(/[\r\n]/);
  });
});

describe("formatNotificationEmail — never leaks raw ids/secrets/tokens/paths, never dumps JSON", () => {
  it("does not render organizationId, recipientId, token, or storagePath even if present in metadata", () => {
    const result = email("ROLE_CHANGED", {
      actorName: "Jane Doe",
      from: "MEMBER",
      to: "ADMIN",
      organizationId: "org-secret-id",
      recipientId: "user-secret-id",
      token: "super-secret-token",
      storagePath: "organizations/x/y/z",
    });
    const rendered = `${result.subject} ${result.text} ${result.html}`;
    expect(rendered).not.toContain("org-secret-id");
    expect(rendered).not.toContain("user-secret-id");
    expect(rendered).not.toContain("super-secret-token");
    expect(rendered).not.toContain("storagePath");
  });

  it("never renders raw JSON of the metadata object", () => {
    const metadata = { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN", nested: { a: 1 } };
    const result = email("ROLE_CHANGED", metadata);
    expect(result.text).not.toContain("{");
    expect(result.html).not.toContain("&quot;actorName&quot;");
  });
});

describe("formatNotificationEmail — includes the shared legal footer", () => {
  it("both bodies link to /privacy and /terms", () => {
    const result = email("ROLE_CHANGED", { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN" });
    expect(result.html).toContain("/privacy");
    expect(result.html).toContain("/terms");
    expect(result.text).toContain("Privacy Policy:");
    expect(result.text).toContain("Terms of Service:");
  });
});

describe("formatNotificationEmail — safe CTA links", () => {
  it("the CTA link is exactly the server-provided ctaUrl, verbatim, in both text and html", () => {
    const ctaUrl = "https://app.example.com/invoices/11111111-1111-1111-1111-111111111111/edit";
    const result = email("INVOICE_STATUS_CHANGED", { actorName: "Jane", invoiceNumber: "INV-1", from: "SENT", to: "PAID" }, { ctaUrl });
    expect(result.text).toContain(ctaUrl);
    expect(result.html).toContain(ctaUrl);
  });

  it("the fallback (malformed metadata) case still includes whatever ctaUrl was supplied", () => {
    const ctaUrl = "https://app.example.com/notifications";
    const result = email("INVOICE_STATUS_CHANGED", { actorName: "Jane" }, { ctaUrl });
    expect(result.text).toContain(ctaUrl);
    expect(result.html).toContain(ctaUrl);
  });
});
