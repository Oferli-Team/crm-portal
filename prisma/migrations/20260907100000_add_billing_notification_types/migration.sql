-- Billing & Subscriptions Stage 4 (docs/billing-architecture.md §17).
-- Purely additive: 4 new NotificationType enum values, nothing removed or
-- renamed. TRIAL_ENDING is deliberately not added here — deferred to a
-- future cron stage (see the enum's own comment in schema.prisma).

ALTER TYPE "NotificationType" ADD VALUE 'SUBSCRIPTION_ACTIVATED';
ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_FAILED';
ALTER TYPE "NotificationType" ADD VALUE 'SUBSCRIPTION_CANCELED';
ALTER TYPE "NotificationType" ADD VALUE 'PLAN_CHANGED';
