-- DropIndex
DROP INDEX "Client_email_key";

-- CreateIndex
CREATE UNIQUE INDEX "Client_userId_email_key" ON "Client"("userId", "email");

