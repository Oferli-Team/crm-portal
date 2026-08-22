import { describe, expect, it } from "vitest";
import { buildAttachmentActivityMetadata } from "@/lib/activity/attachment-metadata";
import {
  buildPortalInvitationMetadata,
  buildPortalInvitationAcceptedMetadata,
  buildPortalUserRemovedMetadata,
} from "@/lib/activity/portal-metadata";
import {
  buildInvitationMetadata,
  buildInvitationAcceptedMetadata,
  buildMembershipMetadata,
  buildRoleChangedMetadata,
  buildOwnershipTransferredMetadata,
} from "@/lib/activity/team-metadata";
import { diffClientFields, buildClientActivityMetadata } from "@/lib/activity/client-metadata";
import {
  diffProjectFields,
  buildProjectMetadata,
  buildProjectStatusChangedMetadata,
  buildProjectUpdatedMetadata,
} from "@/lib/activity/project-metadata";
import {
  diffTaskFields,
  buildTaskMetadata,
  buildTaskStatusChangedMetadata,
  buildTaskUpdatedMetadata,
} from "@/lib/activity/task-metadata";
import {
  diffInvoiceFields,
  buildInvoiceSnapshotMetadata,
  buildInvoiceStatusChangedMetadata,
  buildInvoiceUpdatedMetadata,
  type InvoiceTrackedSnapshot,
} from "@/lib/activity/invoice-metadata";
import { Prisma } from "@/generated/prisma/browser";

// Every builder below is an allowlist by construction — it only ever
// returns the fields it explicitly names. These tests lock that contract
// in place: no secret-ish field (token, storagePath, signedUrl, clientId,
// organizationId, provider responses, ...) can ever silently leak in
// through a future edit without one of these assertions failing.

describe("buildAttachmentActivityMetadata", () => {
  it("returns exactly the 4 allowed fields — never storagePath/signedUrl/mimeType/bucket", () => {
    const metadata = buildAttachmentActivityMetadata("report.pdf", "CLIENT", "Acme Corp", "Jane Doe");
    expect(metadata).toEqual({
      fileName: "report.pdf",
      parentEntityType: "CLIENT",
      parentEntityLabel: "Acme Corp",
      actorName: "Jane Doe",
    });
    expect(Object.keys(metadata)).toHaveLength(4);
  });
});

describe("portal-metadata builders", () => {
  it("buildPortalInvitationMetadata never includes clientId/organizationId/token", () => {
    const metadata = buildPortalInvitationMetadata({ email: "a@test.local" }, "Acme Corp", "Jane Doe");
    expect(metadata).toEqual({ email: "a@test.local", clientName: "Acme Corp", actorName: "Jane Doe" });
    expect(metadata).not.toHaveProperty("clientId");
    expect(metadata).not.toHaveProperty("organizationId");
    expect(metadata).not.toHaveProperty("token");
  });

  it("buildPortalInvitationAcceptedMetadata never includes clientId/organizationId/token", () => {
    const metadata = buildPortalInvitationAcceptedMetadata(
      { name: "Jane Doe", email: "a@test.local" },
      "Acme Corp",
      "Jane Doe",
    );
    expect(metadata).toEqual({
      portalUserName: "Jane Doe",
      portalUserEmail: "a@test.local",
      clientName: "Acme Corp",
      actorName: "Jane Doe",
    });
    expect(metadata).not.toHaveProperty("clientId");
    expect(metadata).not.toHaveProperty("organizationId");
    expect(metadata).not.toHaveProperty("token");
  });

  it("buildPortalUserRemovedMetadata never includes clientId/organizationId/token", () => {
    const metadata = buildPortalUserRemovedMetadata(
      { name: "Jane Doe", email: "a@test.local" },
      "Acme Corp",
      "Actor Name",
    );
    expect(metadata).not.toHaveProperty("clientId");
    expect(metadata).not.toHaveProperty("organizationId");
    expect(metadata).not.toHaveProperty("token");
  });
});

describe("team-metadata builders", () => {
  it("buildInvitationMetadata never includes a token or invitation URL", () => {
    const metadata = buildInvitationMetadata({ email: "a@test.local", role: "MEMBER" }, "Jane Doe");
    expect(metadata).toEqual({ email: "a@test.local", role: "MEMBER", actorName: "Jane Doe" });
    expect(metadata).not.toHaveProperty("token");
    expect(metadata).not.toHaveProperty("url");
  });

  it("buildInvitationAcceptedMetadata carries both memberName and actorName", () => {
    const metadata = buildInvitationAcceptedMetadata(
      { email: "a@test.local", role: "ADMIN" },
      "Jane Doe",
      "Jane Doe",
    );
    expect(metadata).toEqual({
      email: "a@test.local",
      role: "ADMIN",
      memberName: "Jane Doe",
      actorName: "Jane Doe",
    });
  });

  it("buildMembershipMetadata surfaces actorName alongside the member", () => {
    const metadata = buildMembershipMetadata({ name: "Jane Doe", email: "a@test.local" }, "MEMBER", "Owner Name");
    expect(metadata).toEqual({
      memberName: "Jane Doe",
      memberEmail: "a@test.local",
      role: "MEMBER",
      actorName: "Owner Name",
    });
  });

  it("buildRoleChangedMetadata records from/to alongside actorName", () => {
    const metadata = buildRoleChangedMetadata(
      { name: "Jane Doe", email: "a@test.local" },
      "MEMBER",
      "ADMIN",
      "Owner Name",
    );
    expect(metadata).toEqual({
      memberName: "Jane Doe",
      memberEmail: "a@test.local",
      from: "MEMBER",
      to: "ADMIN",
      actorName: "Owner Name",
    });
  });

  it("buildOwnershipTransferredMetadata contains no member ids, only display names", () => {
    const metadata = buildOwnershipTransferredMetadata("Old Owner", "New Owner", "Old Owner");
    expect(metadata).toEqual({
      previousOwnerName: "Old Owner",
      newOwnerName: "New Owner",
      actorName: "Old Owner",
    });
  });
});

describe("client-metadata", () => {
  const baseClientSnapshot = {
    name: "Acme",
    email: null as string | null,
    phone: null as string | null,
    company: null as string | null,
    status: "LEAD",
    billingLegalName: null as string | null,
    taxId: null as string | null,
    streetAddress: null as string | null,
    city: null as string | null,
    state: null as string | null,
    postalCode: null as string | null,
    country: null as string | null,
  };

  it("diffClientFields returns only field names that changed, never values", () => {
    const before = { ...baseClientSnapshot, email: "old@test.local" };
    const after = { ...baseClientSnapshot, email: "new@test.local", status: "ACTIVE" };
    const changed = diffClientFields(before, after);
    expect(changed).toEqual(["email", "status"]);
    // No value ("old@test.local", "new@test.local", "LEAD", "ACTIVE") ever appears.
    for (const field of changed) {
      expect(typeof field).toBe("string");
      expect(field).not.toContain("@");
    }
  });

  it("diffClientFields returns an empty array when nothing changed", () => {
    expect(diffClientFields(baseClientSnapshot, { ...baseClientSnapshot })).toEqual([]);
  });

  it("diffClientFields (Invoice System Slice 1) detects a billing-field change, name only", () => {
    const before = { ...baseClientSnapshot, taxId: "OLD-TAX-ID", streetAddress: "1 Old St" };
    const after = { ...baseClientSnapshot, taxId: "NEW-TAX-ID", streetAddress: "1 Old St" };
    const changed = diffClientFields(before, after);
    expect(changed).toEqual(["taxId"]);
    expect(JSON.stringify(changed)).not.toContain("TAX-ID");
  });

  it("buildClientActivityMetadata never includes email/phone/company/notes", () => {
    const metadata = buildClientActivityMetadata({ name: "Acme", status: "ACTIVE" }, "Jane Doe", ["email"]);
    expect(metadata).toEqual({ name: "Acme", status: "ACTIVE", actorName: "Jane Doe", changedFields: ["email"] });
    expect(metadata).not.toHaveProperty("phone");
    expect(metadata).not.toHaveProperty("company");
    expect(metadata).not.toHaveProperty("notes");
  });

  it("buildClientActivityMetadata omits changedFields entirely when not given (CREATED/DELETED)", () => {
    const metadata = buildClientActivityMetadata({ name: "Acme", status: "LEAD" }, "Jane Doe");
    expect(metadata).not.toHaveProperty("changedFields");
  });
});

describe("project-metadata", () => {
  it("diffProjectFields returns only changed field names", () => {
    const before = { name: "Website", clientId: "c1", status: "PLANNING", startDate: null, endDate: null };
    const after = { name: "Website", clientId: "c1", status: "IN_PROGRESS", startDate: null, endDate: null };
    expect(diffProjectFields(before, after)).toEqual(["status"]);
  });

  it("diffProjectFields compares Date fields by time value, not object identity", () => {
    const before = {
      name: "Website",
      clientId: "c1",
      status: "PLANNING",
      startDate: new Date("2026-01-01T00:00:00Z"),
      endDate: null,
    };
    const after = {
      ...before,
      startDate: new Date("2026-01-01T00:00:00Z"), // different object, same instant
    };
    expect(diffProjectFields(before, after)).toEqual([]);
  });

  it("buildProjectMetadata/StatusChanged/Updated never include a raw client id", () => {
    const snapshot = buildProjectMetadata({ name: "Website", status: "PLANNING" }, "Acme Corp", "Jane Doe");
    const statusChanged = buildProjectStatusChangedMetadata(
      { name: "Website" },
      "Acme Corp",
      "PLANNING",
      "IN_PROGRESS",
      "Jane Doe",
    );
    const updated = buildProjectUpdatedMetadata(
      { name: "Website", status: "PLANNING" },
      "Acme Corp",
      ["startDate"],
      "Jane Doe",
    );
    for (const metadata of [snapshot, statusChanged, updated]) {
      expect(metadata).not.toHaveProperty("clientId");
      expect(metadata.actorName).toBe("Jane Doe");
    }
  });
});

describe("task-metadata", () => {
  it("diffTaskFields returns only changed field names", () => {
    const before = { title: "Fix bug", projectId: "p1", status: "TODO", priority: "LOW", dueDate: null };
    const after = { title: "Fix bug", projectId: "p1", status: "TODO", priority: "HIGH", dueDate: null };
    expect(diffTaskFields(before, after)).toEqual(["priority"]);
  });

  it("diffTaskFields compares dueDate by time value, not object identity", () => {
    const before = {
      title: "Fix bug",
      projectId: "p1",
      status: "TODO",
      priority: "LOW",
      dueDate: new Date("2026-01-01T00:00:00Z"),
    };
    const changedDate = { ...before, dueDate: new Date("2026-02-01T00:00:00Z") };
    const sameInstantDifferentObject = { ...before, dueDate: new Date("2026-01-01T00:00:00Z") };
    expect(diffTaskFields(before, changedDate)).toEqual(["dueDate"]);
    expect(diffTaskFields(before, sameInstantDifferentObject)).toEqual([]);
  });

  it("buildTaskMetadata/StatusChanged/Updated carry actorName and never a raw project id", () => {
    const snapshot = buildTaskMetadata({ title: "Fix bug", status: "TODO", priority: "LOW" }, "Website", "Jane Doe");
    const statusChanged = buildTaskStatusChangedMetadata({ title: "Fix bug" }, "Website", "TODO", "DONE", "Jane Doe");
    const updated = buildTaskUpdatedMetadata(
      { title: "Fix bug", status: "TODO", priority: "LOW" },
      "Website",
      ["priority"],
      "Jane Doe",
    );
    for (const metadata of [snapshot, statusChanged, updated]) {
      expect(metadata).not.toHaveProperty("projectId");
      expect(metadata.actorName).toBe("Jane Doe");
    }
  });
});

describe("invoice-metadata", () => {
  function baseSnapshot(overrides: Partial<InvoiceTrackedSnapshot> = {}): InvoiceTrackedSnapshot {
    return {
      invoiceNumber: "INV-1",
      projectId: "p1",
      amount: "100.00",
      currency: "USD",
      issueDate: new Date("2026-08-16T00:00:00.000Z"),
      dueDate: null,
      notes: null,
      internalNotes: null,
      discountType: "NONE",
      discountValue: null,
      taxRatePercent: null,
      taxLabel: "TAX",
      lineItems: [],
      ...overrides,
    };
  }

  describe("diffInvoiceFields", () => {
    it("compares amount via Decimal, ignoring string/number/Decimal shape differences", () => {
      const before = baseSnapshot({ amount: "100.00" });
      const after = baseSnapshot({ amount: new Prisma.Decimal("100.00") });
      expect(diffInvoiceFields(before, after)).toEqual([]);
    });

    it("flags a real amount change", () => {
      const before = baseSnapshot({ amount: "100.00" });
      const after = baseSnapshot({ amount: "150.00" });
      expect(diffInvoiceFields(before, after)).toEqual(["amount"]);
    });

    it("never uses Number() conversion — detects a difference beyond float precision", () => {
      const before = baseSnapshot({ amount: "10000000.01" });
      const after = baseSnapshot({ amount: "10000000.02" });
      expect(diffInvoiceFields(before, after)).toContain("amount");
    });

    it("compares dates by timestamp", () => {
      const before = baseSnapshot({ dueDate: new Date("2026-09-01T00:00:00.000Z") });
      const after = baseSnapshot({ dueDate: new Date("2026-09-01T00:00:00.000Z") });
      expect(diffInvoiceFields(before, after)).toEqual([]);

      const changed = baseSnapshot({ dueDate: new Date("2026-09-02T00:00:00.000Z") });
      expect(diffInvoiceFields(before, changed)).toContain("dueDate");
    });

    it("null dueDate vs a set dueDate is a difference", () => {
      const before = baseSnapshot({ dueDate: null });
      const after = baseSnapshot({ dueDate: new Date("2026-09-01T00:00:00.000Z") });
      expect(diffInvoiceFields(before, after)).toContain("dueDate");
    });

    it("any line-item difference collapses to exactly one 'lineItems' entry — an add", () => {
      const before = baseSnapshot({ lineItems: [{ description: "A", quantity: "1", unitPrice: "10.00" }] });
      const after = baseSnapshot({
        lineItems: [
          { description: "A", quantity: "1", unitPrice: "10.00" },
          { description: "B", quantity: "1", unitPrice: "5.00" },
        ],
      });
      expect(diffInvoiceFields(before, after)).toEqual(["lineItems"]);
    });

    it("a reorder is detected as a lineItems difference", () => {
      const before = baseSnapshot({
        lineItems: [
          { description: "A", quantity: "1", unitPrice: "10.00" },
          { description: "B", quantity: "1", unitPrice: "5.00" },
        ],
      });
      const after = baseSnapshot({
        lineItems: [
          { description: "B", quantity: "1", unitPrice: "5.00" },
          { description: "A", quantity: "1", unitPrice: "10.00" },
        ],
      });
      expect(diffInvoiceFields(before, after)).toEqual(["lineItems"]);
    });

    it("identical line items produce no lineItems diff", () => {
      const items = [{ description: "A", quantity: "1", unitPrice: "10.00" }];
      const before = baseSnapshot({ lineItems: items });
      const after = baseSnapshot({ lineItems: [{ description: "A", quantity: new Prisma.Decimal("1"), unitPrice: new Prisma.Decimal("10.00") }] });
      expect(diffInvoiceFields(before, after)).toEqual([]);
    });

    it("internalNotes/notes changes produce only the field name, never the value, in the diff list itself", () => {
      const before = baseSnapshot({ internalNotes: null, notes: null });
      const after = baseSnapshot({ internalNotes: "a secret note", notes: "client note" });
      const diff = diffInvoiceFields(before, after);
      expect(diff).toContain("internalNotes");
      expect(diff).toContain("notes");
      expect(diff.join(",")).not.toContain("secret");
      expect(diff.join(",")).not.toContain("client note");
    });

    it("discount/currency/issueDate/discountType/taxRatePercent/taxLabel are all tracked", () => {
      const before = baseSnapshot();
      const after = baseSnapshot({
        currency: "EUR",
        issueDate: new Date("2026-09-01T00:00:00.000Z"),
        discountType: "PERCENTAGE",
        discountValue: "10",
        taxRatePercent: "8.25",
        taxLabel: "VAT",
      });
      const diff = diffInvoiceFields(before, after);
      expect(diff).toEqual(
        expect.arrayContaining(["currency", "issueDate", "discountType", "discountValue", "taxRatePercent", "taxLabel"]),
      );
    });

    it("a fully identical snapshot produces no diff at all (no-op detection)", () => {
      const snapshot = baseSnapshot({ dueDate: new Date("2026-09-01T00:00:00.000Z"), lineItems: [{ description: "A", quantity: "1", unitPrice: "10.00" }] });
      expect(diffInvoiceFields(snapshot, { ...snapshot })).toEqual([]);
    });

    it("never includes status — that is always its own STATUS_CHANGED event", () => {
      const before = baseSnapshot();
      const after = baseSnapshot({ invoiceNumber: "INV-2" });
      expect(diffInvoiceFields(before, after)).not.toContain("status");
    });
  });

  describe("buildInvoiceSnapshotMetadata — CREATED/DELETED, shared, null-safe", () => {
    it("stringifies amount and never includes a raw project/client id", () => {
      const metadata = buildInvoiceSnapshotMetadata(
        { invoiceNumber: "INV-1", status: "DRAFT", amount: 100, currency: "USD", subtotal: "100.00", discountType: "NONE", discountAmount: "0.00", taxRatePercent: null, taxAmount: "0.00", taxLabel: "TAX" },
        0,
        "Website",
        "Jane Doe",
      );
      expect(metadata.amount).toBe("100");
      expect(metadata.lineItemCount).toBe(0);
      expect(metadata).not.toHaveProperty("projectId");
      expect(metadata).not.toHaveProperty("clientId");
      expect(metadata).not.toHaveProperty("organizationId");
    });

    it("records the correct itemized line-item count", () => {
      const metadata = buildInvoiceSnapshotMetadata(
        { invoiceNumber: "INV-1", status: "DRAFT", amount: "300.00", currency: "USD", subtotal: "300.00", discountType: "NONE", discountAmount: "0.00", taxRatePercent: null, taxAmount: "0.00", taxLabel: "TAX" },
        3,
        "Website",
        "Jane Doe",
      );
      expect(metadata.lineItemCount).toBe(3);
    });

    it("is null-safe for a legacy row with unbackfilled nullable totals", () => {
      const metadata = buildInvoiceSnapshotMetadata(
        { invoiceNumber: "INV-1", status: "DRAFT", amount: "100.00", currency: "USD", subtotal: null, discountType: "NONE", discountAmount: null, taxRatePercent: null, taxAmount: null, taxLabel: "TAX" },
        0,
        "Website",
        "Jane Doe",
      );
      expect(metadata.subtotal).toBeNull();
      expect(metadata.discountAmount).toBeNull();
      expect(metadata.taxAmount).toBeNull();
      expect(metadata.amount).toBe("100.00");
    });

    it("never includes notes, internalNotes, or any line-item description/quantity/unitPrice value", () => {
      const metadata = buildInvoiceSnapshotMetadata(
        { invoiceNumber: "INV-1", status: "DRAFT", amount: "100.00", currency: "USD", subtotal: "100.00", discountType: "NONE", discountAmount: "0.00", taxRatePercent: null, taxAmount: "0.00", taxLabel: "TAX" },
        2,
        "Website",
        "Jane Doe",
      );
      const serialized = JSON.stringify(metadata);
      expect(metadata).not.toHaveProperty("notes");
      expect(metadata).not.toHaveProperty("internalNotes");
      expect(metadata).not.toHaveProperty("lineItems");
      expect(serialized).not.toContain("description");
    });
  });

  describe("buildInvoiceStatusChangedMetadata", () => {
    it("carries from/to and never a raw project id", () => {
      const metadata = buildInvoiceStatusChangedMetadata(
        { invoiceNumber: "INV-1" },
        "Website",
        "DRAFT",
        "SENT",
        "Jane Doe",
      );
      expect(metadata).toEqual({
        invoiceNumber: "INV-1",
        projectName: "Website",
        from: "DRAFT",
        to: "SENT",
        actorName: "Jane Doe",
      });
      expect(metadata).not.toHaveProperty("projectId");
    });
  });

  describe("buildInvoiceUpdatedMetadata — names only", () => {
    it("carries only changed field names — never a value", () => {
      const metadata = buildInvoiceUpdatedMetadata("INV-1", ["dueDate", "internalNotes"], "Website", "Jane Doe");
      expect(metadata).toEqual({
        invoiceNumber: "INV-1",
        projectName: "Website",
        changedFields: ["dueDate", "internalNotes"],
        actorName: "Jane Doe",
      });
      expect(metadata).not.toHaveProperty("amount");
      expect(metadata).not.toHaveProperty("status");
      expect(metadata).not.toHaveProperty("currency");
    });
  });
});
