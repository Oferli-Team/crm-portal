"use client";

import type { SelectHTMLAttributes } from "react";
import { Select } from "@/components/ui/select";

/**
 * A <select> that submits its parent <form> on change. No state is held
 * here — the form (and the URL it navigates to) is the only source of
 * truth, so this stays a thin event-trigger, not client-side state.
 */
export function AutoSubmitSelect(
  props: SelectHTMLAttributes<HTMLSelectElement>,
) {
  return (
    <Select
      {...props}
      onChange={(event) => {
        event.currentTarget.form?.requestSubmit();
      }}
    />
  );
}
