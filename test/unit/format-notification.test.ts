import { describe, expect, it } from "vitest";
import { formatNotification } from "@/lib/notifications/format-notification";
import type { NotificationType } from "@/generated/prisma/enums";
import { FIXED_NOW } from "../support/fixtures";

function notification(
  type: NotificationType,
  metadata: unknown,
  overrides: Partial<{ entityId: string | null; readAt: Date | null }> = {},
) {
  return formatNotification({
    type,
    metadata,
    entityId: "entityId" in overrides ? overrides.entityId! : "11111111-1111-1111-1111-111111111111",
    createdAt: FIXED_NOW,
    readAt: overrides.readAt ?? null,
  });
}

describe("formatNotification — one happy path per type", () => {
  it("ROLE_CHANGED", () => {
    const result = notification("ROLE_CHANGED", { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN" });
    expect(result.title).toBe("Jane Doe changed your role");
    expect(result.detail).toBe("Member → Admin");
    expect(result.link).toBe("/team");
  });

  it("OWNERSHIP_TRANSFERRED", () => {
    const result = notification("OWNERSHIP_TRANSFERRED", {
      actorName: "Jane Doe",
      previousOwnerName: "Jane Doe",
      newOwnerName: "John Smith",
    });
    expect(result.title).toBe("Jane Doe transferred ownership to you");
    expect(result.detail).toBe("Jane Doe → John Smith");
    expect(result.link).toBe("/team");
  });

  it("MEMBER_REMOVED", () => {
    const result = notification("MEMBER_REMOVED", { actorName: "Jane Doe", memberName: "John Smith" });
    expect(result.title).toBe("Jane Doe removed you from the organization");
    expect(result.detail).toBeNull();
    expect(result.link).toBe("/team");
  });

  it("INVITATION_ACCEPTED", () => {
    const result = notification("INVITATION_ACCEPTED", {
      actorName: "Jane Doe",
      acceptedUserName: "John Smith",
      email: "john@example.com",
      role: "MEMBER",
    });
    expect(result.title).toBe("John Smith accepted your invitation");
    expect(result.detail).toBe("john@example.com · Member");
    expect(result.link).toBe("/team");
  });

  it("PORTAL_INVITATION_ACCEPTED", () => {
    const result = notification("PORTAL_INVITATION_ACCEPTED", {
      acceptedUserName: "Alice Client",
      email: "alice@example.com",
      clientName: "Acme Corp",
    });
    expect(result.title).toBe("Alice Client accepted Client Portal access");
    expect(result.detail).toBe("Acme Corp · alice@example.com");
    // No reliable clientId is ever carried in this type's metadata — see
    // format-notification.ts's buildLink comment.
    expect(result.link).toBeNull();
  });

  it("INVOICE_STATUS_CHANGED", () => {
    const result = notification("INVOICE_STATUS_CHANGED", {
      actorName: "Jane Doe",
      invoiceNumber: "INV-042",
      from: "SENT",
      to: "PAID",
      projectName: "Website Redesign",
    });
    expect(result.title).toBe("Jane Doe changed invoice INV-042 status");
    expect(result.detail).toBe("Issued → Paid · Website Redesign");
    expect(result.link).toBe("/invoices/11111111-1111-1111-1111-111111111111/edit");
  });

  it("INVOICE_STATUS_CHANGED with no entityId renders the title with no link", () => {
    const result = notification(
      "INVOICE_STATUS_CHANGED",
      { actorName: "Jane Doe", invoiceNumber: "INV-042", from: "SENT", to: "PAID" },
      { entityId: null },
    );
    expect(result.title).toBe("Jane Doe changed invoice INV-042 status");
    expect(result.link).toBeNull();
  });

  it("MENTIONED", () => {
    const result = notification("MENTIONED", {
      actorName: "Jane Doe",
      commentPreview: "Can you take a look at this?",
      parentEntityType: "PROJECT",
      parentEntityLabel: "Website Redesign",
    });
    expect(result.title).toBe("Jane Doe mentioned you in a comment");
    expect(result.detail).toBe("Can you take a look at this?");
    expect(result.link).toBeNull();
  });

  it("SUBSCRIPTION_ACTIVATED", () => {
    const result = notification("SUBSCRIPTION_ACTIVATED", { planName: "Pro" });
    expect(result.title).toBe("Your Pro plan is now active");
    expect(result.detail).toBeNull();
    expect(result.link).toBe("/settings/billing");
  });

  it("PAYMENT_FAILED", () => {
    const result = notification("PAYMENT_FAILED", { planName: "Pro" });
    expect(result.title).toBe("A payment failed");
    expect(result.detail).toBe("Pro plan — update your payment method to avoid losing access.");
    expect(result.link).toBe("/settings/billing");
  });

  it("SUBSCRIPTION_CANCELED", () => {
    const result = notification("SUBSCRIPTION_CANCELED", { planName: "Starter" });
    expect(result.title).toBe("Your subscription was canceled");
    expect(result.detail).toBe("Starter plan");
    expect(result.link).toBe("/settings/billing");
  });

  it("PLAN_CHANGED", () => {
    const result = notification("PLAN_CHANGED", { planName: "Pro", previousPlanName: "Starter" });
    expect(result.title).toBe("Your plan changed to Pro");
    expect(result.detail).toBe("Starter → Pro");
    expect(result.link).toBe("/settings/billing");
  });
});

describe("formatNotification — actor/name fallback when actorName is missing", () => {
  it("ROLE_CHANGED falls back to 'Someone'", () => {
    const result = notification("ROLE_CHANGED", { from: "MEMBER", to: "ADMIN" });
    expect(result.title).toBe("Someone changed your role");
  });

  it("OWNERSHIP_TRANSFERRED falls back to 'Someone'", () => {
    const result = notification("OWNERSHIP_TRANSFERRED", {
      previousOwnerName: "Jane Doe",
      newOwnerName: "John Smith",
    });
    expect(result.title).toBe("Someone transferred ownership to you");
  });

  it("MEMBER_REMOVED falls back to 'Someone'", () => {
    const result = notification("MEMBER_REMOVED", {});
    expect(result.title).toBe("Someone removed you from the organization");
  });

  it("INVITATION_ACCEPTED falls back to 'Someone' for acceptedUserName", () => {
    const result = notification("INVITATION_ACCEPTED", { email: "john@example.com", role: "MEMBER" });
    expect(result.title).toBe("Someone accepted your invitation");
  });

  it("PORTAL_INVITATION_ACCEPTED falls back to 'Someone'", () => {
    const result = notification("PORTAL_INVITATION_ACCEPTED", {});
    expect(result.title).toBe("Someone accepted Client Portal access");
  });

  it("MENTIONED falls back to 'Someone'", () => {
    const result = notification("MENTIONED", { parentEntityType: "PROJECT", parentEntityLabel: "Website Redesign" });
    expect(result.title).toBe("Someone mentioned you in a comment");
  });

  it("INVOICE_STATUS_CHANGED falls back to 'Someone' but still needs invoiceNumber", () => {
    const result = notification("INVOICE_STATUS_CHANGED", { invoiceNumber: "INV-1", from: "DRAFT", to: "SENT" });
    expect(result.title).toBe("Someone changed invoice INV-1 status");
  });
});

describe("formatNotification — missing/partial fields degrade the detail line, not the title", () => {
  it("ROLE_CHANGED with only 'from' omits the detail line", () => {
    const result = notification("ROLE_CHANGED", { actorName: "Jane Doe", from: "MEMBER" });
    expect(result.title).toBe("Jane Doe changed your role");
    expect(result.detail).toBeNull();
  });

  it("OWNERSHIP_TRANSFERRED missing newOwnerName omits the detail line", () => {
    const result = notification("OWNERSHIP_TRANSFERRED", { actorName: "Jane Doe", previousOwnerName: "Jane Doe" });
    expect(result.detail).toBeNull();
  });

  it("INVITATION_ACCEPTED missing role omits the detail line", () => {
    const result = notification("INVITATION_ACCEPTED", { acceptedUserName: "John", email: "john@example.com" });
    expect(result.detail).toBeNull();
  });

  it("INVOICE_STATUS_CHANGED missing projectName still shows the status change", () => {
    const result = notification("INVOICE_STATUS_CHANGED", {
      actorName: "Jane Doe",
      invoiceNumber: "INV-1",
      from: "DRAFT",
      to: "SENT",
    });
    expect(result.detail).toBe("Draft → Issued");
  });

  it("INVOICE_STATUS_CHANGED with no invoiceNumber at all falls all the way back", () => {
    const result = notification("INVOICE_STATUS_CHANGED", { actorName: "Jane Doe", from: "DRAFT", to: "SENT" });
    expect(result.title).toBe("Notification received");
    expect(result.detail).toBeNull();
    expect(result.link).toBeNull();
  });
});

describe("formatNotification — never throws on malformed metadata", () => {
  it("metadata is null", () => {
    const result = notification("ROLE_CHANGED", null);
    expect(result.title).toBe("Someone changed your role");
  });

  it("metadata is a string", () => {
    const result = notification("ROLE_CHANGED", "not an object");
    expect(result.title).toBe("Someone changed your role");
  });

  it("metadata is a number", () => {
    const result = notification("INVOICE_STATUS_CHANGED", 42);
    expect(result.title).toBe("Notification received");
  });

  it("metadata is an array", () => {
    const result = notification("MEMBER_REMOVED", ["actorName", "Jane Doe"]);
    expect(result.title).toBe("Someone removed you from the organization");
  });

  it("metadata fields have the wrong type (numbers/objects instead of strings)", () => {
    const result = notification("ROLE_CHANGED", { actorName: 12345, from: { nested: true }, to: ["ADMIN"] });
    expect(result.title).toBe("Someone changed your role");
    expect(result.detail).toBeNull();
  });

  it("an unknown/future NotificationType falls back to the generic title with no link", () => {
    const result = notification("SOME_FUTURE_TYPE" as NotificationType, { actorName: "Jane Doe" });
    expect(result.title).toBe("Notification received");
    expect(result.detail).toBeNull();
    expect(result.link).toBeNull();
  });
});

describe("formatNotification — never leaks raw ids/secrets, and never dumps JSON", () => {
  it("does not render organizationId, entityId, token, or storagePath even if present in metadata", () => {
    const result = notification("ROLE_CHANGED", {
      actorName: "Jane Doe",
      from: "MEMBER",
      to: "ADMIN",
      organizationId: "org-secret-id",
      recipientId: "user-secret-id",
      token: "super-secret-token",
      storagePath: "organizations/x/y/z",
    });
    const rendered = `${result.title} ${result.detail ?? ""}`;
    expect(rendered).not.toContain("org-secret-id");
    expect(rendered).not.toContain("user-secret-id");
    expect(rendered).not.toContain("super-secret-token");
    expect(rendered).not.toContain("storagePath");
  });

  it("never renders raw JSON of the metadata object", () => {
    const metadata = { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN", nested: { a: 1 } };
    const result = notification("ROLE_CHANGED", metadata);
    expect(result.title).not.toContain("{");
    expect(result.detail ?? "").not.toContain("{");
  });
});

describe("formatNotification — timestamp and unread flag", () => {
  it("timestamp is passed through deterministically", () => {
    const result = notification("ROLE_CHANGED", { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN" });
    expect(result.timestamp).toEqual(FIXED_NOW);
  });

  it("isUnread is true when readAt is null", () => {
    const result = notification("ROLE_CHANGED", { actorName: "Jane Doe" }, { readAt: null });
    expect(result.isUnread).toBe(true);
  });

  it("isUnread is false once readAt is set", () => {
    const result = notification("ROLE_CHANGED", { actorName: "Jane Doe" }, { readAt: FIXED_NOW });
    expect(result.isUnread).toBe(false);
  });
});

describe("formatNotification — link allowlist", () => {
  it("membership/invitation types always link to /team regardless of entityId", () => {
    for (const type of ["ROLE_CHANGED", "OWNERSHIP_TRANSFERRED", "MEMBER_REMOVED", "INVITATION_ACCEPTED"] as const) {
      const result = notification(type, { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN" }, { entityId: null });
      expect(result.link).toBe("/team");
    }
  });

  it("MENTIONED without parentEntityId (e.g. older rows written before Stage 4) gets no link", () => {
    const result = notification(
      "MENTIONED",
      { actorName: "Jane Doe", commentPreview: "hi", parentEntityType: "PROJECT", parentEntityLabel: "Website Redesign" },
      { entityId: "33333333-3333-3333-3333-333333333333" },
    );
    expect(result.link).toBeNull();
  });

  it("MENTIONED on a project links to the project edit page with a #comment fragment", () => {
    const result = notification(
      "MENTIONED",
      {
        actorName: "Jane Doe",
        commentPreview: "hi",
        parentEntityType: "PROJECT",
        parentEntityLabel: "Website Redesign",
        parentEntityId: "44444444-4444-4444-4444-444444444444",
      },
      { entityId: "33333333-3333-3333-3333-333333333333" },
    );
    expect(result.link).toBe(
      "/projects/44444444-4444-4444-4444-444444444444/edit#comment-33333333-3333-3333-3333-333333333333",
    );
  });

  it("MENTIONED on a task links to the task edit page with a #comment fragment", () => {
    const result = notification(
      "MENTIONED",
      {
        actorName: "Jane Doe",
        commentPreview: "hi",
        parentEntityType: "TASK",
        parentEntityLabel: "Fix login bug",
        parentEntityId: "55555555-5555-5555-5555-555555555555",
      },
      { entityId: "33333333-3333-3333-3333-333333333333" },
    );
    expect(result.link).toBe(
      "/tasks/55555555-5555-5555-5555-555555555555/edit#comment-33333333-3333-3333-3333-333333333333",
    );
  });

  it("MENTIONED with a malformed parentEntityType gets no link, never a guessed route", () => {
    const result = notification(
      "MENTIONED",
      {
        actorName: "Jane Doe",
        parentEntityType: "INVOICE",
        parentEntityLabel: "X",
        parentEntityId: "66666666-6666-6666-6666-666666666666",
      },
      { entityId: "33333333-3333-3333-3333-333333333333" },
    );
    expect(result.link).toBeNull();
  });

  it("MENTIONED with no entityId (the comment id) gets no link even with a valid parentEntityId", () => {
    const result = notification(
      "MENTIONED",
      {
        actorName: "Jane Doe",
        parentEntityType: "PROJECT",
        parentEntityLabel: "Website Redesign",
        parentEntityId: "44444444-4444-4444-4444-444444444444",
      },
      { entityId: null },
    );
    expect(result.link).toBeNull();
  });

  it("PORTAL_INVITATION_ACCEPTED never gets a link, even with an entityId present", () => {
    const result = notification(
      "PORTAL_INVITATION_ACCEPTED",
      { acceptedUserName: "Alice", email: "a@example.com", clientName: "Acme" },
      { entityId: "22222222-2222-2222-2222-222222222222" },
    );
    expect(result.link).toBeNull();
  });

  it("INVOICE_STATUS_CHANGED links to the real /invoices/[id]/edit route using entityId", () => {
    const result = notification(
      "INVOICE_STATUS_CHANGED",
      { actorName: "Jane Doe", invoiceNumber: "INV-1", from: "DRAFT", to: "SENT" },
      { entityId: "33333333-3333-3333-3333-333333333333" },
    );
    expect(result.link).toBe("/invoices/33333333-3333-3333-3333-333333333333/edit");
  });
});
