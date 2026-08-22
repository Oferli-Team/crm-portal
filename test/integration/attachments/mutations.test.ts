import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  uploadAttachmentForEntity,
  deleteAttachmentForEntity,
  deleteAttachmentsForParent,
} from "@/lib/attachments/attachment-mutations";
import { verifyPortalAttachmentAccess } from "@/lib/client-portal/attachments";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { setUploadShouldFail, resetStorageMock, removedPaths } from "../../support/storage-mock";

function makeFormData(name = "report.pdf", content = "hello"): FormData {
  const fd = new FormData();
  fd.set("file", new File([content], name, { type: "application/pdf" }));
  return fd;
}

describe("attachment mutations — real Prisma, mocked Storage (see test/support/storage-mock.ts)", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(() => {
    resetStorageMock();
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("valid upload creates an Attachment row and a FILE_UPLOADED Activity", async () => {
    const result = await uploadAttachmentForEntity({
      organizationId: fixtures.orgA.id,
      actorId: fixtures.owner.id,
      actorName: fixtures.owner.name,
      entityType: "CLIENT",
      entityId: fixtures.clientA.id,
      parentEntityLabel: fixtures.clientA.name,
      formData: makeFormData("new-valid-upload.pdf"),
    });

    expect(result.error).toBeNull();
    const attachment = await prisma.attachment.findFirst({
      where: { organizationId: fixtures.orgA.id, entityId: fixtures.clientA.id, originalName: "new-valid-upload.pdf" },
    });
    expect(attachment).not.toBeNull();

    const activity = await prisma.activity.findFirst({
      where: { entityId: attachment!.id, action: "FILE_UPLOADED" },
    });
    expect(activity).not.toBeNull();

    await prisma.activity.deleteMany({ where: { entityId: attachment!.id } });
    await prisma.attachment.deleteMany({ where: { id: attachment!.id } });
  });

  it("Storage upload failure is reported without ever creating an Attachment row", async () => {
    setUploadShouldFail(true);

    const result = await uploadAttachmentForEntity({
      organizationId: fixtures.orgA.id,
      actorId: fixtures.owner.id,
      actorName: fixtures.owner.name,
      entityType: "CLIENT",
      entityId: fixtures.clientA.id,
      parentEntityLabel: fixtures.clientA.name,
      formData: makeFormData("upload-fail-test.pdf"),
    });

    expect(result.error).toBe("Failed to upload the file. Please try again.");
    const row = await prisma.attachment.findFirst({ where: { originalName: "upload-fail-test.pdf" } });
    expect(row).toBeNull();
  });

  it("delete removes the Attachment row, logs FILE_DELETED, and removes the Storage object", async () => {
    const uploadResult = await uploadAttachmentForEntity({
      organizationId: fixtures.orgA.id,
      actorId: fixtures.owner.id,
      actorName: fixtures.owner.name,
      entityType: "CLIENT",
      entityId: fixtures.clientA.id,
      parentEntityLabel: fixtures.clientA.name,
      formData: makeFormData("to-delete.pdf"),
    });
    expect(uploadResult.error).toBeNull();
    const attachment = await prisma.attachment.findFirstOrThrow({ where: { originalName: "to-delete.pdf" } });

    await deleteAttachmentForEntity({
      organizationId: fixtures.orgA.id,
      actorId: fixtures.owner.id,
      actorName: fixtures.owner.name,
      attachmentId: attachment.id,
      entityType: "CLIENT",
      resolveParentLabel: async () => fixtures.clientA.name,
    });

    const gone = await prisma.attachment.findUnique({ where: { id: attachment.id } });
    expect(gone).toBeNull();
    const deletedActivity = await prisma.activity.findFirst({
      where: { entityId: attachment.id, action: "FILE_DELETED" },
    });
    expect(deletedActivity).not.toBeNull();
    expect(removedPaths).toContain(attachment.storagePath);

    await prisma.activity.deleteMany({ where: { entityId: attachment.id } });
  });

  it("an orphan attachment (entityId pointing at a Project/Invoice that no longer exists) is denied by verifyPortalAttachmentAccess, not crashed", async () => {
    const nonExistentProjectId = randomUUID();
    const orphan = await prisma.attachment.create({
      data: {
        organizationId: fixtures.orgA.id,
        uploadedById: fixtures.owner.id,
        entityType: "PROJECT",
        entityId: nonExistentProjectId,
        storageBucket: "attachments",
        storagePath: `organizations/${fixtures.orgA.id}/PROJECT/${nonExistentProjectId}/${randomUUID()}/orphan.pdf`,
        originalName: "orphan.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
      },
    });

    const allowed = await verifyPortalAttachmentAccess(orphan, {
      clientId: fixtures.clientA.id,
      organizationId: fixtures.orgA.id,
    });
    expect(allowed).toBe(false);

    await prisma.attachment.delete({ where: { id: orphan.id } });
  });

  it("deleteAttachmentsForParent cascades a batch of attachments and logs one FILE_DELETED each", async () => {
    const upload1 = await uploadAttachmentForEntity({
      organizationId: fixtures.orgA.id,
      actorId: fixtures.owner.id,
      actorName: fixtures.owner.name,
      entityType: "CLIENT",
      entityId: fixtures.clientA.id,
      parentEntityLabel: fixtures.clientA.name,
      formData: makeFormData("cascade-1.pdf"),
    });
    const upload2 = await uploadAttachmentForEntity({
      organizationId: fixtures.orgA.id,
      actorId: fixtures.owner.id,
      actorName: fixtures.owner.name,
      entityType: "CLIENT",
      entityId: fixtures.clientA.id,
      parentEntityLabel: fixtures.clientA.name,
      formData: makeFormData("cascade-2.pdf"),
    });
    expect(upload1.error).toBeNull();
    expect(upload2.error).toBeNull();

    const { storagePaths } = await prisma.$transaction((tx) =>
      deleteAttachmentsForParent(tx, {
        organizationId: fixtures.orgA.id,
        actorId: fixtures.owner.id,
        actorName: fixtures.owner.name,
        targets: [{ entityType: "CLIENT", entityId: fixtures.clientA.id, parentEntityLabel: fixtures.clientA.name }],
      }),
    );

    expect(storagePaths.length).toBeGreaterThanOrEqual(2);
    const remaining = await prisma.attachment.count({
      where: { entityId: fixtures.clientA.id, originalName: { in: ["cascade-1.pdf", "cascade-2.pdf"] } },
    });
    expect(remaining).toBe(0);
  });

  // Run last, deliberately: this is the one test in this file that forces
  // a real transaction ROLLBACK (an FK violation on a bogus
  // organizationId). Empirically, PGlite's single connection (see
  // src/lib/prisma.ts's PGLITE_TEST_DB pool cap) does not fully recover
  // its wire-protocol state after servicing a rolled-back transaction —
  // subsequent queries on that same connection started failing with an
  // unrelated-looking Prisma deserialization error
  // ("_count$_all" field mismatch) until the process's Prisma client was
  // recreated. Real Postgres does not have this problem (rollback is a
  // normal, fully-recoverable operation there); this is specifically a
  // PGlite limitation. Keeping this test last means every other test in
  // this file still runs against a known-good connection. See the Stage 4
  // report for the full explanation — not something to paper over with a
  // fake assertion.
  it("invalid organizationId: DB insert fails (real FK constraint), and the compensating Storage removal runs — this is the transaction-rollback path", async () => {
    const bogusOrgId = randomUUID(); // syntactically valid UUID, no such Organization row

    const result = await uploadAttachmentForEntity({
      organizationId: bogusOrgId,
      actorId: fixtures.owner.id,
      actorName: fixtures.owner.name,
      entityType: "CLIENT",
      entityId: fixtures.clientA.id,
      parentEntityLabel: fixtures.clientA.name,
      formData: makeFormData("rollback-test.pdf"),
    });

    expect(result.error).toBe("Failed to save the uploaded file. Please try again.");
    // The mocked Storage "upload" succeeded, then the DB write failed on
    // the FK violation — uploadAttachmentForEntity's catch block must call
    // removeAttachmentObject to compensate, exactly as it would for a real
    // Storage-backed upload.
    expect(removedPaths).toHaveLength(1);

    const orphanedRow = await prisma.attachment.findFirst({ where: { organizationId: bogusOrgId } });
    expect(orphanedRow).toBeNull(); // never committed — the transaction rolled back
  });
});
