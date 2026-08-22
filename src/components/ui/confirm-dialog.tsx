"use client";

import { useId, useImperativeHandle, useRef, type Ref } from "react";

export type ConfirmDialogHandle = {
  open: () => void;
};

/**
 * An accessible confirmation dialog built on the native <dialog> element —
 * modal focus trapping, Escape-to-close, and backdrop are all provided by
 * the browser, no extra dependency needed. Opened imperatively via a ref
 * so any trigger (a plain button, a table row action, etc.) can control it.
 */
export function ConfirmDialog({
  ref,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
}: {
  ref?: Ref<ConfirmDialogHandle>;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useImperativeHandle(ref, () => ({
    open: () => dialogRef.current?.showModal(),
  }));

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClick={(event) => {
        if (event.target === dialogRef.current) {
          dialogRef.current?.close();
        }
      }}
      className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 shadow-xl backdrop:bg-black/40"
    >
      <h2 id={titleId} className="text-base font-semibold text-gray-900">
        {title}
      </h2>
      <p id={descriptionId} className="mt-2 text-sm text-gray-600">
        {description}
      </p>
      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={() => {
            dialogRef.current?.close();
            onConfirm();
          }}
          className={`rounded-md px-4 py-2 text-sm font-medium text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
            destructive
              ? "bg-red-600 hover:bg-red-700 focus-visible:ring-red-600"
              : "bg-black hover:bg-gray-800 focus-visible:ring-black"
          }`}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
