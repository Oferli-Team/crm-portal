"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/components/toast/toast-provider";

/**
 * Fires a toast for a one-shot "?toast=...&toastVariant=..." pair left on
 * the URL by a server action's post-redirect response, then strips those
 * params so a refresh doesn't re-show it.
 */
export function ToastListener() {
  const { showToast } = useToast();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const message = searchParams.get("toast");
    if (!message) return;

    const variant = searchParams.get("toastVariant") === "error" ? "error" : "success";
    showToast(message, variant);

    const params = new URLSearchParams(searchParams.toString());
    params.delete("toast");
    params.delete("toastVariant");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    // Only re-run when the URL's search params actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return null;
}
