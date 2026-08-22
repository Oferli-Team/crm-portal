-- DropIndex
DROP INDEX "Invoice_invoiceNumber_key";

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_clientId_invoiceNumber_key" ON "Invoice"("clientId", "invoiceNumber");

