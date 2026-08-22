/**
 * Appends a one-shot toast message to a redirect target. The destination
 * page's <ToastListener /> reads and strips these params on mount.
 */
export function withToast(
  path: string,
  message: string,
  variant: "success" | "error" = "success",
): string {
  const params = new URLSearchParams({ toast: message });
  if (variant === "error") {
    params.set("toastVariant", "error");
  }
  return `${path}?${params.toString()}`;
}
