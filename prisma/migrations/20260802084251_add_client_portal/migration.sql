-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityAction" ADD VALUE 'PORTAL_INVITATION_SENT';
ALTER TYPE "ActivityAction" ADD VALUE 'PORTAL_INVITATION_RESENT';
ALTER TYPE "ActivityAction" ADD VALUE 'PORTAL_INVITATION_CANCELED';
ALTER TYPE "ActivityAction" ADD VALUE 'PORTAL_INVITATION_ACCEPTED';
ALTER TYPE "ActivityAction" ADD VALUE 'PORTAL_USER_REMOVED';

-- AlterEnum
ALTER TYPE "ActivityEntityType" ADD VALUE 'PORTAL_USER';

-- CreateTable
CREATE TABLE "PortalUser" (
    "id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortalUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientInvitation" (
    "id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invitedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortalUser_clientId_idx" ON "PortalUser"("clientId");

-- CreateIndex
CREATE INDEX "PortalUser_email_idx" ON "PortalUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ClientInvitation_token_key" ON "ClientInvitation"("token");

-- CreateIndex
CREATE INDEX "ClientInvitation_clientId_idx" ON "ClientInvitation"("clientId");

-- CreateIndex
CREATE INDEX "ClientInvitation_email_idx" ON "ClientInvitation"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ClientInvitation_clientId_email_key" ON "ClientInvitation"("clientId", "email");

-- AddForeignKey
ALTER TABLE "PortalUser" ADD CONSTRAINT "PortalUser_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientInvitation" ADD CONSTRAINT "ClientInvitation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientInvitation" ADD CONSTRAINT "ClientInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
