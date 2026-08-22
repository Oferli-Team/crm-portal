import { describe, expect, it } from "vitest";
import { formatActivity } from "@/lib/activity/format-activity";
import type { ActivityEntityType, ActivityAction } from "@/generated/prisma/enums";
import { FIXED_NOW } from "../support/fixtures";

function activity(
  entityType: ActivityEntityType,
  action: ActivityAction,
  metadata: unknown,
  actor: { name: string; email: string } | null = null,
) {
  return formatActivity({ entityType, action, metadata, actor, createdAt: FIXED_NOW });
}

describe("formatActivity — Client events", () => {
  it("CREATED", () => {
    const result = activity("CLIENT", "CREATED", { name: "Acme Corp", status: "LEAD", actorName: "Jane Doe" });
    expect(result.actionLabel).toBe("created client Acme Corp");
    expect(result.entityLabel).toBe("Acme Corp");
    expect(result.isDeleted).toBe(false);
  });

  it("UPDATED lists humanized changed field names, never their values", () => {
    const result = activity("CLIENT", "UPDATED", {
      name: "Acme Corp",
      status: "ACTIVE",
      changedFields: ["email", "phone"],
      actorName: "Jane Doe",
    });
    expect(result.actionLabel).toBe("updated client Acme Corp");
    expect(result.detailLines).toEqual(["Changed: email, phone"]);
  });

  it("DELETED sets isDeleted", () => {
    const result = activity(
      "CLIENT",
      "DELETED",
      { name: "Acme Corp", status: "ARCHIVED" },
      { name: "Jane Doe", email: "jane@test.local" },
    );
    expect(result.actionLabel).toBe("deleted client Acme Corp");
    expect(result.isDeleted).toBe(true);
  });
});

describe("formatActivity — STATUS_CHANGED across entity types", () => {
  it("Project", () => {
    const result = activity("PROJECT", "STATUS_CHANGED", {
      name: "Website",
      clientName: "Acme Corp",
      from: "PLANNING",
      to: "IN_PROGRESS",
      actorName: "Jane Doe",
    });
    expect(result.actionLabel).toBe("changed project Website status");
    expect(result.detailLines).toEqual(["Planning → In Progress"]);
  });

  it("Task", () => {
    const result = activity("TASK", "STATUS_CHANGED", {
      title: "Fix bug",
      projectName: "Website",
      from: "TODO",
      to: "DONE",
      actorName: "Jane Doe",
    });
    expect(result.actionLabel).toBe("changed task Fix bug status");
    expect(result.detailLines).toEqual(["Todo → Done"]);
  });

  it("Invoice", () => {
    const result = activity("INVOICE", "STATUS_CHANGED", {
      invoiceNumber: "INV-1",
      projectName: "Website",
      from: "DRAFT",
      to: "PAID",
      actorName: "Jane Doe",
    });
    expect(result.actionLabel).toBe("changed invoice INV-1 status");
    expect(result.detailLines).toEqual(["Draft → Paid"]);
  });

  it("Invoice — SENT renders as Issued, scoped only to the INVOICE entity type", () => {
    const result = activity("INVOICE", "STATUS_CHANGED", {
      invoiceNumber: "INV-1",
      projectName: "Website",
      from: "SENT",
      to: "PAID",
      actorName: "Jane Doe",
    });
    expect(result.detailLines).toEqual(["Issued → Paid"]);
  });

  it("Invoice UPDATED lists the new field-name labels for Slice 2b's fields, never a value", () => {
    const result = activity("INVOICE", "UPDATED", {
      invoiceNumber: "INV-1",
      changedFields: ["currency", "issueDate", "discountType", "discountValue", "taxRatePercent", "taxLabel", "internalNotes", "notes", "lineItems"],
      actorName: "Jane Doe",
    });
    expect(result.detailLines).toEqual([
      "Changed: currency, issue date, discount type, discount, tax rate, tax label, internal notes, notes, line items",
    ]);
  });

  it("Invoice UPDATED — Legacy Archive's own single logical marker renders as a readable phrase, never a raw column name", () => {
    const result = activity("INVOICE", "UPDATED", {
      invoiceNumber: "INV-1",
      changedFields: ["legacyArchive"],
      actorName: "Jane Doe",
    });
    expect(result.detailLines).toEqual(["Changed: legacy PDF archive"]);
  });

  it("Invoice CREATED shows a formatted currency amount", () => {
    const result = activity("INVOICE", "CREATED", {
      invoiceNumber: "INV-1",
      status: "DRAFT",
      amount: "100",
      currency: "USD",
      projectName: "Website",
      actorName: "Jane Doe",
    });
    expect(result.actionLabel).toBe("created invoice INV-1");
    expect(result.detailLines).toEqual(["$100.00"]);
  });
});

describe("formatActivity — Invitation events", () => {
  it("INVITATION_SENT", () => {
    const result = activity("INVITATION", "INVITATION_SENT", {
      email: "a@test.local",
      role: "MEMBER",
      actorName: "Jane Doe",
    });
    expect(result.actionLabel).toBe("invited a@test.local as Member");
    expect(result.entityLabel).toBe("a@test.local");
  });

  it("INVITATION_RESENT", () => {
    const result = activity("INVITATION", "INVITATION_RESENT", { email: "a@test.local", role: "MEMBER", actorName: "Jane" });
    expect(result.actionLabel).toBe("resent an invitation to a@test.local");
  });

  it("INVITATION_CANCELED", () => {
    const result = activity("INVITATION", "INVITATION_CANCELED", { email: "a@test.local", role: "MEMBER", actorName: "Jane" });
    expect(result.actionLabel).toBe("canceled the invitation for a@test.local");
  });

  it("INVITATION_ACCEPTED", () => {
    const result = activity("INVITATION", "INVITATION_ACCEPTED", {
      email: "a@test.local",
      role: "ADMIN",
      memberName: "a",
      actorName: "a",
    });
    expect(result.actionLabel).toBe("accepted an invitation as Admin");
  });
});

describe("formatActivity — Membership events", () => {
  it("ROLE_CHANGED", () => {
    const result = activity("MEMBERSHIP", "ROLE_CHANGED", {
      memberName: "Bob",
      memberEmail: "bob@test.local",
      from: "MEMBER",
      to: "ADMIN",
      actorName: "Jane Doe",
    });
    expect(result.actionLabel).toBe("changed Bob's role");
    expect(result.detailLines).toEqual(["Member → Admin"]);
  });

  it("OWNERSHIP_TRANSFERRED", () => {
    const result = activity("MEMBERSHIP", "OWNERSHIP_TRANSFERRED", {
      previousOwnerName: "Jane Doe",
      newOwnerName: "Bob",
      actorName: "Jane Doe",
    });
    expect(result.actionLabel).toBe("transferred ownership");
    expect(result.detailLines).toEqual(["Jane Doe → Bob"]);
    expect(result.entityLabel).toBe("Bob");
  });

  it("MEMBER_REMOVED", () => {
    const result = activity("MEMBERSHIP", "MEMBER_REMOVED", {
      memberName: "Bob",
      memberEmail: "bob@test.local",
      role: "MEMBER",
      actorName: "Jane Doe",
    });
    expect(result.actionLabel).toBe("removed Bob from the organization");
  });

  it("MEMBER_LEFT is self-referential", () => {
    const result = activity("MEMBERSHIP", "MEMBER_LEFT", {
      memberName: "Jane Doe",
      memberEmail: "jane@test.local",
      role: "OWNER",
      actorName: "Jane Doe",
    });
    expect(result.actionLabel).toBe("left the organization");
    expect(result.entityLabel).toBe("Jane Doe");
  });
});

describe("formatActivity — Attachment events", () => {
  it("FILE_UPLOADED", () => {
    const result = activity("ATTACHMENT", "FILE_UPLOADED", {
      fileName: "report.pdf",
      parentEntityType: "CLIENT",
      parentEntityLabel: "Acme Corp",
      actorName: "Jane Doe",
    });
    expect(result.actionLabel).toBe("uploaded report.pdf to client Acme Corp");
    expect(result.isDeleted).toBe(false);
  });

  it("FILE_DELETED sets isDeleted", () => {
    const result = activity("ATTACHMENT", "FILE_DELETED", {
      fileName: "report.pdf",
      parentEntityType: "CLIENT",
      parentEntityLabel: "Acme Corp",
      actorName: "Jane Doe",
    });
    expect(result.actionLabel).toBe("deleted report.pdf from client Acme Corp");
    expect(result.isDeleted).toBe(true);
  });
});

describe("formatActivity — Portal (Client Portal) events", () => {
  it("PORTAL_INVITATION_SENT", () => {
    const result = activity("PORTAL_USER", "PORTAL_INVITATION_SENT", {
      email: "a@test.local",
      clientName: "Acme Corp",
      actorName: "Jane Doe",
    });
    expect(result.actionLabel).toBe("invited a@test.local to client portal for Acme Corp");
  });

  it("PORTAL_INVITATION_ACCEPTED (self-referential, actor is always null)", () => {
    const result = activity(
      "PORTAL_USER",
      "PORTAL_INVITATION_ACCEPTED",
      { portalUserName: "Alex Portal", clientName: "Acme Corp", actorName: "Alex Portal" },
      null,
    );
    expect(result.actionLabel).toBe("accepted client portal access for Acme Corp");
    expect(result.entityLabel).toBe("Acme Corp");
    expect(result.actorLabel).toBe("Alex Portal");
  });

  it("PORTAL_USER_REMOVED", () => {
    const result = activity("PORTAL_USER", "PORTAL_USER_REMOVED", {
      portalUserName: "Bob Portal",
      clientName: "Acme Corp",
      actorName: "Jane Doe",
    });
    expect(result.actionLabel).toBe("removed Bob Portal's client portal access for Acme Corp");
  });

  it("PORTAL_INVITATION_RESENT/CANCELED fall back safely when email is missing", () => {
    const resent = activity("PORTAL_USER", "PORTAL_INVITATION_RESENT", { clientName: "Acme Corp" });
    const canceled = activity("PORTAL_USER", "PORTAL_INVITATION_CANCELED", { clientName: "Acme Corp" });
    expect(resent.actionLabel).toBe("Activity recorded");
    expect(canceled.actionLabel).toBe("Activity recorded");
  });
});

describe("formatActivity — actor label fallback chain", () => {
  it("prefers actor.name over metadata.actorName when both are present", () => {
    const result = activity(
      "CLIENT",
      "CREATED",
      { name: "Acme Corp", status: "LEAD", actorName: "Metadata Name" },
      { name: "Actor Name", email: "actor@test.local" },
    );
    expect(result.actorLabel).toBe("Actor Name");
  });

  it("falls back to metadata.actorName when actor is null", () => {
    const result = activity("CLIENT", "CREATED", { name: "Acme Corp", status: "LEAD", actorName: "Metadata Name" }, null);
    expect(result.actorLabel).toBe("Metadata Name");
  });

  it("falls back to 'Unknown user' when neither is present", () => {
    const result = activity("CLIENT", "CREATED", { name: "Acme Corp", status: "LEAD" }, null);
    expect(result.actorLabel).toBe("Unknown user");
  });
});

describe("formatActivity — malformed metadata never crashes", () => {
  it("metadata: null", () => {
    const result = activity("CLIENT", "CREATED", null, { name: "Jane Doe", email: "jane@test.local" });
    expect(result.actionLabel).toBe("Activity recorded");
    expect(result.entityLabel).toBeNull();
    expect(result.detailLines).toEqual([]);
  });

  it("metadata: a plain string", () => {
    const result = activity("CLIENT", "CREATED", "not an object", { name: "Jane Doe", email: "jane@test.local" });
    expect(result.actionLabel).toBe("Activity recorded");
  });

  it("metadata: missing the required name field", () => {
    const result = activity("CLIENT", "CREATED", { status: "LEAD" });
    expect(result.actionLabel).toBe("Activity recorded");
  });

  it("metadata: wrong field types (a number where a string is expected)", () => {
    const result = activity("CLIENT", "CREATED", { name: 12345, status: "LEAD" });
    expect(result.actionLabel).toBe("Activity recorded");
  });

  it("metadata: changedFields is not an array", () => {
    const result = activity("CLIENT", "UPDATED", { name: "Acme Corp", status: "LEAD", changedFields: "email" });
    expect(result.actionLabel).toBe("updated client Acme Corp");
    expect(result.detailLines).toEqual([]);
  });

  it("an unrecognized action within a known entityType falls back safely", () => {
    const result = activity("CLIENT", "PORTAL_USER_REMOVED" as ActivityAction, { name: "Acme Corp", status: "LEAD" });
    expect(result.actionLabel).toBe("Activity recorded");
  });

  it("a hypothetical future entityType falls back safely rather than throwing", () => {
    const result = activity(
      "FUTURE_ENTITY_TYPE" as ActivityEntityType,
      "CREATED" as ActivityAction,
      { name: "Whatever" },
    );
    expect(result.actionLabel).toBe("Activity recorded");
    expect(result.entityLabel).toBeNull();
  });

  it("an unrecognized action falls back safely for every non-data entityType", () => {
    const bogusAction = "SOME_FUTURE_ACTION" as ActivityAction;
    expect(activity("INVITATION", bogusAction, { email: "a@test.local", role: "MEMBER" }).actionLabel).toBe(
      "Activity recorded",
    );
    expect(activity("MEMBERSHIP", bogusAction, { memberName: "Bob" }).actionLabel).toBe("Activity recorded");
    expect(
      activity("ATTACHMENT", bogusAction, {
        fileName: "x.pdf",
        parentEntityType: "CLIENT",
        parentEntityLabel: "Acme Corp",
      }).actionLabel,
    ).toBe("Activity recorded");
    expect(activity("PORTAL_USER", bogusAction, { clientName: "Acme Corp" }).actionLabel).toBe(
      "Activity recorded",
    );
  });

  it("catches a metadata object that throws on property access, rather than crashing the page", () => {
    const hostileMetadata: Record<string, unknown> = {};
    Object.defineProperty(hostileMetadata, "name", {
      enumerable: true,
      get(): never {
        throw new Error("boom");
      },
    });
    const result = activity("CLIENT", "CREATED", hostileMetadata);
    expect(result.actionLabel).toBe("Activity recorded");
  });
});

describe("formatActivity — never leaks raw/unexpected metadata into the display model", () => {
  it("a stray secret-looking field never appears in any rendered string", () => {
    const result = activity("CLIENT", "CREATED", {
      name: "Acme Corp",
      status: "LEAD",
      actorName: "Jane Doe",
      token: "super-secret-token-value",
      storagePath: "organizations/x/y/z",
    });
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain("super-secret-token-value");
    expect(rendered).not.toContain("storagePath");
  });
});
