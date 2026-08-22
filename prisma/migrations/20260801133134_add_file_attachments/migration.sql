-- CreateEnum
CREATE TYPE "AttachmentEntityType" AS ENUM ('CLIENT', 'PROJECT', 'INVOICE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityAction" ADD VALUE 'FILE_UPLOADED';
ALTER TYPE "ActivityAction" ADD VALUE 'FILE_DELETED';

-- AlterEnum
ALTER TYPE "ActivityEntityType" ADD VALUE 'ATTACHMENT';

-- CreateTable
CREATE TABLE "Attachment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "uploadedById" UUID,
    "entityType" "AttachmentEntityType" NOT NULL,
    "entityId" UUID NOT NULL,
    "storageBucket" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_storagePath_key" ON "Attachment"("storagePath");

-- CreateIndex
CREATE INDEX "Attachment_organizationId_entityType_entityId_createdAt_id_idx" ON "Attachment"("organizationId", "entityType", "entityId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Attachment_organizationId_createdAt_id_idx" ON "Attachment"("organizationId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
