"use client";

import { FormLabel } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import type { InvoiceLineItemFormValue } from "@/lib/invoices/line-items-form";
import type { InvoiceLineItemFieldKey } from "@/types";

function RowField({
  id,
  label,
  value,
  error,
  onChange,
  className = "",
}: {
  id: string;
  label: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <FormLabel htmlFor={id}>{label}</FormLabel>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1 text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

export function InvoiceLineItemRow({
  index,
  value,
  errors,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}: {
  index: number;
  value: InvoiceLineItemFormValue;
  errors?: Partial<Record<InvoiceLineItemFieldKey, string>>;
  onChange: (next: InvoiceLineItemFormValue) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  return (
    <fieldset
      aria-label={`Line item ${index + 1}`}
      className="grid grid-cols-1 gap-3 rounded-md border border-gray-200 p-3 sm:grid-cols-[1fr_7rem_8rem_auto]"
    >
      <RowField
        id={`lineItems.${index}.description`}
        label="Description"
        value={value.description}
        error={errors?.description}
        onChange={(next) => onChange({ ...value, description: next })}
      />
      <RowField
        id={`lineItems.${index}.quantity`}
        label="Qty"
        value={value.quantity}
        error={errors?.quantity}
        onChange={(next) => onChange({ ...value, quantity: next })}
      />
      <RowField
        id={`lineItems.${index}.unitPrice`}
        label="Unit price"
        value={value.unitPrice}
        error={errors?.unitPrice}
        onChange={(next) => onChange({ ...value, unitPrice: next })}
      />
      <div className="flex items-end gap-1 pb-0.5">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={!canMoveUp}
          aria-label={`Move line item ${index + 1} up`}
          className="rounded-md border border-gray-300 px-2 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-black disabled:cursor-not-allowed disabled:opacity-40"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={!canMoveDown}
          aria-label={`Move line item ${index + 1} down`}
          className="rounded-md border border-gray-300 px-2 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-black disabled:cursor-not-allowed disabled:opacity-40"
        >
          ↓
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove line item ${index + 1}`}
          className="rounded-md border border-gray-300 px-2 py-2 text-sm text-red-600 transition-colors hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-600"
        >
          Remove
        </button>
      </div>
    </fieldset>
  );
}
