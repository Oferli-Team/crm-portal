"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { INVOICE_DISCOUNT_TYPES, INVOICE_TAX_LABELS } from "@/lib/validation/invoice";
import { calculateInvoiceTotals } from "@/lib/invoices/calculations";
import { formatInvoiceCurrencyAmount } from "@/lib/invoices/currencies";
import { encodeInvoiceLineItemsFormValue, type InvoiceLineItemFormValue } from "@/lib/invoices/line-items-form";
import { InvoiceLineItemRow } from "./invoice-line-item-row";
import type { InvoiceFormState } from "@/types";

const initialState: InvoiceFormState = { error: null };

type InvoiceFormDefaults = {
  invoiceNumber?: string;
  projectId?: string;
  mode?: "flat" | "itemized";
  amount?: string;
  lineItems?: InvoiceLineItemFormValue[];
  currency?: string;
  issueDate?: string;
  dueDate?: string;
  notes?: string;
  internalNotes?: string;
  discountType?: "NONE" | "PERCENTAGE" | "FIXED";
  discountValue?: string;
  taxRatePercent?: string;
  taxLabel?: "TAX" | "VAT" | "GST";
};

const BLANK_LINE_ITEM: InvoiceLineItemFormValue = { description: "", quantity: "", unitPrice: "" };

/**
 * Invoice System Slice 2b — the DRAFT create/edit form (real production
 * Client Component; this permanently exercises Slice 2a's browser-safe
 * calculateInvoiceTotals()/formatInvoiceCurrencyAmount() imports on every
 * `npm run build`, docs/invoicing-architecture.md §5).
 *
 * Every field that participates in the live preview (mode/amount/
 * lineItems/currency/discountType/discountValue/taxRatePercent) is
 * controlled local state, held as canonical strings — never JS arithmetic
 * for money, only handed to calculateInvoiceTotals(). The server
 * independently recomputes everything on submit and never trusts this
 * preview.
 */
export function InvoiceForm({
  action,
  projects,
  currencyOptions,
  currencyFallbackNotice,
  defaultValues,
  submitLabel = "Create invoice",
  pendingLabel = "Creating…",
  onDirtyChange,
}: {
  action: (prevState: InvoiceFormState, formData: FormData) => Promise<InvoiceFormState>;
  projects: { id: string; label: string }[];
  currencyOptions: readonly string[];
  currencyFallbackNotice?: string;
  defaultValues?: InvoiceFormDefaults;
  submitLabel?: string;
  pendingLabel?: string;
  /**
   * Invoice System Official Slice 3, sub-PR 3b — fires the first time (and
   * every time) the user changes anything, via this component's own
   * existing centralized error-dismissal path below — every editable
   * field already routes through dismissCurrentErrors() on change, so
   * this needed no new per-field wiring. Never fires on initial mount.
   * Optional so every other current caller of InvoiceForm (the plain
   * create page, the duplicate page) is unaffected.
   */
  onDirtyChange?: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);

  // Stale-error dismissal (docs/invoicing-architecture.md corrected design):
  // errors are visible only when the CURRENT action-state object has not
  // been locally dismissed. A fresh action result is always a NEW object
  // identity, so submitting again automatically un-dismisses.
  const [dismissedState, setDismissedState] = useState<InvoiceFormState | null>(null);
  const errorsVisible = state !== dismissedState;
  const fieldErrors = errorsVisible ? (state.fieldErrors ?? {}) : {};
  const lineItemErrors = errorsVisible ? (state.lineItemErrors ?? {}) : {};

  function dismissCurrentErrors() {
    setDismissedState(state);
    onDirtyChange?.();
  }

  const [mode, setMode] = useState<"flat" | "itemized">(defaultValues?.mode ?? "flat");
  const [amount, setAmount] = useState(defaultValues?.amount ?? "");
  const [lineItems, setLineItems] = useState<InvoiceLineItemFormValue[]>(
    defaultValues?.lineItems && defaultValues.lineItems.length > 0 ? defaultValues.lineItems : [BLANK_LINE_ITEM],
  );
  const [currency, setCurrency] = useState(defaultValues?.currency ?? currencyOptions[0] ?? "USD");
  const [discountType, setDiscountType] = useState<"NONE" | "PERCENTAGE" | "FIXED">(defaultValues?.discountType ?? "NONE");
  const [discountValue, setDiscountValue] = useState(defaultValues?.discountValue ?? "");
  const [taxRatePercent, setTaxRatePercent] = useState(defaultValues?.taxRatePercent ?? "");

  function updateLineItem(index: number, next: InvoiceLineItemFormValue) {
    setLineItems((items) => items.map((item, i) => (i === index ? next : item)));
    dismissCurrentErrors();
  }
  function addLineItem() {
    setLineItems((items) => [...items, { ...BLANK_LINE_ITEM }]);
    dismissCurrentErrors();
  }
  function removeLineItem(index: number) {
    setLineItems((items) => (items.length > 1 ? items.filter((_, i) => i !== index) : items));
    dismissCurrentErrors();
  }
  function moveLineItem(index: number, direction: -1 | 1) {
    setLineItems((items) => {
      const target = index + direction;
      if (target < 0 || target >= items.length) return items;
      const next = [...items];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    dismissCurrentErrors();
  }

  const preview = calculateInvoiceTotals({
    subtotalSource: mode === "flat" ? { mode: "flat", amount } : { mode: "lineItems", lineItems },
    discount: discountType === "NONE" ? { type: "NONE" } : { type: discountType, value: discountValue },
    taxRatePercent: taxRatePercent === "" ? null : taxRatePercent,
  });
  const previewText = preview.ok ? formatInvoiceCurrencyAmount(preview.total, currency) : null;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="mode" value={mode} />
      {mode === "itemized" && (
        <input type="hidden" name="lineItems" value={encodeInvoiceLineItemsFormValue(lineItems)} readOnly />
      )}

      <FormField label="Invoice number" htmlFor="invoiceNumber" required error={fieldErrors.invoiceNumber}>
        <Input
          id="invoiceNumber"
          name="invoiceNumber"
          defaultValue={defaultValues?.invoiceNumber}
          required
          onChange={dismissCurrentErrors}
          aria-invalid={!!fieldErrors.invoiceNumber}
          aria-describedby={fieldErrors.invoiceNumber ? "invoiceNumber-error" : undefined}
        />
      </FormField>

      <FormField label="Project" htmlFor="projectId" required error={fieldErrors.projectId}>
        <Select
          id="projectId"
          name="projectId"
          defaultValue={defaultValues?.projectId ?? ""}
          required
          onChange={dismissCurrentErrors}
          aria-invalid={!!fieldErrors.projectId}
          aria-describedby={fieldErrors.projectId ? "projectId-error" : undefined}
        >
          <option value="" disabled>
            Select a project
          </option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.label}
            </option>
          ))}
        </Select>
      </FormField>

      <fieldset aria-describedby={fieldErrors.mode ? "mode-error" : undefined}>
        <legend className="block text-sm font-medium text-gray-700">Invoice type</legend>
        <div className="mt-1 flex gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="radio"
              name="mode-selector"
              checked={mode === "flat"}
              onChange={() => {
                setMode("flat");
                dismissCurrentErrors();
              }}
            />
            Flat amount
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="radio"
              name="mode-selector"
              checked={mode === "itemized"}
              onChange={() => {
                setMode("itemized");
                dismissCurrentErrors();
              }}
            />
            Itemized
          </label>
        </div>
        {fieldErrors.mode && (
          <p id="mode-error" role="alert" className="mt-1 text-sm text-red-600">
            {fieldErrors.mode}
          </p>
        )}
      </fieldset>

      {mode === "flat" ? (
        <FormField label="Amount" htmlFor="amount" required error={fieldErrors.amount}>
          <Input
            id="amount"
            name="amount"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              dismissCurrentErrors();
            }}
            required
            aria-invalid={!!fieldErrors.amount}
            aria-describedby={fieldErrors.amount ? "amount-error" : undefined}
          />
        </FormField>
      ) : (
        <div>
          <FormLabel htmlFor="lineItems-list">Line items</FormLabel>
          {fieldErrors.lineItems && (
            <p id="lineItems-error" role="alert" className="mt-1 text-sm text-red-600">
              {fieldErrors.lineItems}
            </p>
          )}
          <div id="lineItems-list" className="mt-2 space-y-3">
            {lineItems.map((item, index) => (
              <InvoiceLineItemRow
                key={index}
                index={index}
                value={item}
                errors={lineItemErrors[index]}
                onChange={(next) => updateLineItem(index, next)}
                onRemove={() => removeLineItem(index)}
                onMoveUp={() => moveLineItem(index, -1)}
                onMoveDown={() => moveLineItem(index, 1)}
                canMoveUp={index > 0}
                canMoveDown={index < lineItems.length - 1}
              />
            ))}
          </div>
          <Button type="button" onClick={addLineItem} variant="secondary" className="mt-3">
            Add line
          </Button>
        </div>
      )}

      <div aria-live="polite" className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm">
        {previewText ? (
          <span className="font-medium text-gray-900">Total: {previewText}</span>
        ) : (
          <span className="text-gray-500">Enter valid amounts to see a total preview.</span>
        )}
      </div>

      <FormField label="Currency" htmlFor="currency" required error={fieldErrors.currency}>
        <Select
          id="currency"
          name="currency"
          value={currency}
          onChange={(event) => {
            setCurrency(event.target.value);
            dismissCurrentErrors();
          }}
          required
          aria-invalid={!!fieldErrors.currency}
          aria-describedby={fieldErrors.currency ? "currency-error" : undefined}
        >
          {currencyOptions.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </Select>
        {currencyFallbackNotice && <p className="mt-1 text-sm text-amber-700">{currencyFallbackNotice}</p>}
      </FormField>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Issue date" htmlFor="issueDate" required error={fieldErrors.issueDate}>
          <Input
            id="issueDate"
            name="issueDate"
            type="date"
            defaultValue={defaultValues?.issueDate}
            required
            onChange={dismissCurrentErrors}
            aria-invalid={!!fieldErrors.issueDate}
            aria-describedby={fieldErrors.issueDate ? "issueDate-error" : undefined}
          />
        </FormField>

        <FormField label="Due date" htmlFor="dueDate" error={fieldErrors.dueDate}>
          <Input
            id="dueDate"
            name="dueDate"
            type="date"
            defaultValue={defaultValues?.dueDate ?? ""}
            onChange={dismissCurrentErrors}
            aria-invalid={!!fieldErrors.dueDate}
            aria-describedby={fieldErrors.dueDate ? "dueDate-error" : undefined}
          />
        </FormField>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Discount type" htmlFor="discountType" error={fieldErrors.discountType}>
          <Select
            id="discountType"
            name="discountType"
            value={discountType}
            onChange={(event) => {
              setDiscountType(event.target.value as "NONE" | "PERCENTAGE" | "FIXED");
              dismissCurrentErrors();
            }}
            aria-invalid={!!fieldErrors.discountType}
            aria-describedby={fieldErrors.discountType ? "discountType-error" : undefined}
          >
            {INVOICE_DISCOUNT_TYPES.map((option) => (
              <option key={option} value={option}>
                {option === "NONE" ? "No discount" : option === "PERCENTAGE" ? "Percentage" : "Fixed amount"}
              </option>
            ))}
          </Select>
        </FormField>

        {discountType !== "NONE" && (
          <FormField
            label={discountType === "PERCENTAGE" ? "Discount (%)" : "Discount amount"}
            htmlFor="discountValue"
            required
            error={fieldErrors.discountValue}
          >
            <Input
              id="discountValue"
              name="discountValue"
              value={discountValue}
              onChange={(event) => {
                setDiscountValue(event.target.value);
                dismissCurrentErrors();
              }}
              required
              aria-invalid={!!fieldErrors.discountValue}
              aria-describedby={fieldErrors.discountValue ? "discountValue-error" : undefined}
            />
          </FormField>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Tax rate (%)" htmlFor="taxRatePercent" error={fieldErrors.taxRatePercent}>
          <Input
            id="taxRatePercent"
            name="taxRatePercent"
            value={taxRatePercent}
            onChange={(event) => {
              setTaxRatePercent(event.target.value);
              dismissCurrentErrors();
            }}
            aria-invalid={!!fieldErrors.taxRatePercent}
            aria-describedby={fieldErrors.taxRatePercent ? "taxRatePercent-error" : undefined}
          />
        </FormField>

        <FormField label="Tax label" htmlFor="taxLabel" error={fieldErrors.taxLabel}>
          <Select
            id="taxLabel"
            name="taxLabel"
            defaultValue={defaultValues?.taxLabel ?? "TAX"}
            onChange={dismissCurrentErrors}
            aria-invalid={!!fieldErrors.taxLabel}
            aria-describedby={fieldErrors.taxLabel ? "taxLabel-error" : undefined}
          >
            {INVOICE_TAX_LABELS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </FormField>
      </div>

      <FormField label="Notes" htmlFor="notes" error={fieldErrors.notes}>
        <Textarea
          id="notes"
          name="notes"
          rows={3}
          defaultValue={defaultValues?.notes ?? ""}
          onChange={dismissCurrentErrors}
          aria-invalid={!!fieldErrors.notes}
          aria-describedby={fieldErrors.notes ? "notes-error" : undefined}
        />
      </FormField>

      <FormField label="Internal notes" htmlFor="internalNotes" error={fieldErrors.internalNotes}>
        <Textarea
          id="internalNotes"
          name="internalNotes"
          rows={3}
          defaultValue={defaultValues?.internalNotes ?? ""}
          onChange={dismissCurrentErrors}
          aria-invalid={!!fieldErrors.internalNotes}
          aria-describedby={fieldErrors.internalNotes ? "internalNotes-error" : undefined}
        />
        <p className="mt-1 text-xs text-gray-500">Staff-only — never shown to the client.</p>
      </FormField>

      {state.error && errorsVisible && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}

      <div className="flex gap-3 pt-2">
        <Button type="submit" loading={pending}>
          {pending ? pendingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}
