-- AlterTable
ALTER TABLE "PortalUser" ADD COLUMN     "lastLoginAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PortalDownloadRequest" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalDownloadRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortalUser_lastLoginAt_idx" ON "PortalUser"("lastLoginAt");

-- CreateIndex
CREATE INDEX "PortalDownloadRequest_organizationId_requestedAt_idx" ON "PortalDownloadRequest"("organizationId", "requestedAt");

-- AddForeignKey
ALTER TABLE "PortalDownloadRequest" ADD CONSTRAINT "PortalDownloadRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
