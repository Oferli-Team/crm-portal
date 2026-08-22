import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  getPortalProject,
  getPortalInvoice,
  getPortalProjects,
  getPortalInvoices,
} from "@/lib/client-portal/queries";
import {
  getPortalClientAttachments,
  verifyPortalAttachmentAccess,
} from "@/lib/client-portal/attachments";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";

// These query/access functions are fully parameter-driven (clientId always
// passed explicitly, never resolved from a cookie internally) — no auth
// mocking needed at all, real Prisma end to end.

describe("Client Portal authorization — PortalUser A cannot see Client B's data", () => {
  let fixtures: TestFixtures;
  let projectB: { id: string };
  let invoiceB: { id: string };
  // fixtures.invoice is DRAFT and, since Invoice System Official Slice 5
  // (docs/invoicing-architecture.md §10), is correctly never Portal-visible
  // — these cross-client isolation proofs need an invoice that a
  // same-client lookup CAN resolve, so a dedicated SENT invoice for
  // Client A is used instead of relying on the fixed DRAFT-visibility bug.
  let visibleInvoiceA: { id: string };

  beforeAll(async () => {
    fixtures = await seedTestData();
    projectB = await prisma.project.create({
      data: {
        name: "Client B Project",
        clientId: fixtures.clientB.id,
        organizationId: fixtures.orgB.id,
        ownerId: fixtures.orgBOwner.id,
        status: "IN_PROGRESS",
      },
    });
    invoiceB = await prisma.invoice.create({
      data: {
        invoiceNumber: "INV-B-1",
        clientId: fixtures.clientB.id,
        projectId: projectB.id,
        organizationId: fixtures.orgB.id,
        amount: "200.00",
        status: "DRAFT",
        issueDate: new Date(),
      },
    });
    visibleInvoiceA = await prisma.invoice.create({
      data: {
        invoiceNumber: "INV-A-VISIBLE-1",
        clientId: fixtures.clientA.id,
        projectId: fixtures.project.id,
        organizationId: fixtures.orgA.id,
        amount: "300.00",
        status: "SENT",
        issueDate: new Date(),
      },
    });
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { id: { in: [invoiceB.id, visibleInvoiceA.id] } } });
    await prisma.project.deleteMany({ where: { id: projectB.id } });
    await cleanupTestData(fixtures);
  });

  it("getPortalProject: Client A's clientId cannot resolve Client B's project", async () => {
    const crossClient = await getPortalProject(fixtures.clientA.id, projectB.id);
    expect(crossClient).toBeNull();

    const ownProject = await getPortalProject(fixtures.clientA.id, fixtures.project.id);
    expect(ownProject?.id).toBe(fixtures.project.id);
  });

  it("getPortalInvoice: Client A's clientId cannot resolve Client B's invoice", async () => {
    const crossClient = await getPortalInvoice(fixtures.clientA.id, fixtures.orgA.id, invoiceB.id);
    expect(crossClient).toBeNull();

    const ownInvoice = await getPortalInvoice(fixtures.clientA.id, fixtures.orgA.id, visibleInvoiceA.id);
    expect(ownInvoice?.id).toBe(visibleInvoiceA.id);
  });

  it("getPortalProjects: never returns another Client's projects", async () => {
    const projects = await getPortalProjects(fixtures.clientA.id);
    expect(projects.some((p) => p.id === projectB.id)).toBe(false);
    expect(projects.some((p) => p.id === fixtures.project.id)).toBe(true);
  });

  it("getPortalInvoices: never returns another Client's invoices", async () => {
    const invoices = await getPortalInvoices(fixtures.clientA.id, fixtures.orgA.id, "all");
    expect(invoices.some((i) => i.id === invoiceB.id)).toBe(false);
    expect(invoices.some((i) => i.id === visibleInvoiceA.id)).toBe(true);
  });

  it("getPortalClientAttachments: scoped by clientId + organizationId together", async () => {
    const crossClient = await getPortalClientAttachments(fixtures.clientB.id, fixtures.orgA.id);
    expect(crossClient).toHaveLength(0);

    const ownClient = await getPortalClientAttachments(fixtures.clientA.id, fixtures.orgA.id);
    expect(ownClient.some((a) => a.id === fixtures.attachment.id)).toBe(true);
  });

  it("verifyPortalAttachmentAccess: denies a real Attachment row to the wrong Client identity", async () => {
    const attachment = await prisma.attachment.findUniqueOrThrow({ where: { id: fixtures.attachment.id } });

    const wrongIdentity = await verifyPortalAttachmentAccess(attachment, {
      clientId: fixtures.clientB.id,
      organizationId: fixtures.orgB.id,
    });
    expect(wrongIdentity).toBe(false);

    const rightIdentity = await verifyPortalAttachmentAccess(attachment, {
      clientId: fixtures.clientA.id,
      organizationId: fixtures.orgA.id,
    });
    expect(rightIdentity).toBe(true);
  });

  it("verifyPortalAttachmentAccess: fails closed for a mismatched organizationId even with the right clientId", async () => {
    const attachment = await prisma.attachment.findUniqueOrThrow({ where: { id: fixtures.attachment.id } });
    const result = await verifyPortalAttachmentAccess(attachment, {
      clientId: fixtures.clientA.id,
      organizationId: fixtures.orgB.id, // wrong org, right client — must still fail
    });
    expect(result).toBe(false);
  });
});
