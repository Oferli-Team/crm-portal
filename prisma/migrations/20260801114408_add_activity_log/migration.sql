-- CreateEnum
CREATE TYPE "ActivityEntityType" AS ENUM ('CLIENT', 'PROJECT', 'TASK', 'INVOICE', 'MEMBERSHIP', 'INVITATION');

-- CreateEnum
CREATE TYPE "ActivityAction" AS ENUM ('CREATED', 'UPDATED', 'STATUS_CHANGED', 'DELETED', 'INVITATION_SENT', 'INVITATION_RESENT', 'INVITATION_CANCELED', 'INVITATION_ACCEPTED', 'ROLE_CHANGED', 'OWNERSHIP_TRANSFERRED', 'MEMBER_REMOVED', 'MEMBER_LEFT');

-- CreateTable
CREATE TABLE "Activity" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "actorId" UUID,
    "entityType" "ActivityEntityType" NOT NULL,
    "entityId" UUID NOT NULL,
    "action" "ActivityAction" NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Activity_organizationId_createdAt_id_idx" ON "Activity"("organizationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Activity_organizationId_entityType_entityId_createdAt_id_idx" ON "Activity"("organizationId", "entityType", "entityId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
