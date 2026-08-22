-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ROLE_CHANGED', 'OWNERSHIP_TRANSFERRED', 'MEMBER_REMOVED', 'INVITATION_ACCEPTED', 'PORTAL_INVITATION_ACCEPTED', 'INVOICE_STATUS_CHANGED');

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "activityId" UUID,
    "type" "NotificationType" NOT NULL,
    "entityType" "ActivityEntityType",
    "entityId" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_recipientId_readAt_createdAt_id_idx" ON "Notification"("recipientId", "readAt", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Notification_organizationId_recipientId_createdAt_id_idx" ON "Notification"("organizationId", "recipientId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Notification_activityId_idx" ON "Notification"("activityId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

