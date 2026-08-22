-- AlterEnum
ALTER TYPE "NotificationDeliveryStatus" ADD VALUE 'PROCESSING';

-- AlterTable
ALTER TABLE "NotificationDelivery" ADD COLUMN     "lockedAt" TIMESTAMP(3),
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);

