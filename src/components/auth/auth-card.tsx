import type { ReactNode } from "react";
import { siteConfig } from "@/config/site";

/**
 * Sale-Ready Phase E, S1.1 (P0). Shared presentational shell for every
 * staff auth page (login/signup/forgot-password/reset-password) —
 * previously each page duplicated the exact same unbranded
 * `<main>bg-gray-50<div>card</div></main>` wrapper with no product
 * identity anywhere on the page, so a buyer's very first screen carried
 * zero branding. Purely presentational: no auth logic, no new routes, no
 * behavior change — each page still owns its own heading/copy/form as
 * `children`, exactly as before, just wrapped in this shell instead of
 * duplicating it. `siteConfig` is the same existing branding source
 * `src/app/layout.tsx`'s own `<title>`/description already reads from —
 * not a new abstraction.
 */
export function AuthCard({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-gray-50 px-4">
      <span className="text-lg font-semibold tracking-tight text-gray-900">{siteConfig.name}</span>
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-8 shadow-sm">{children}</div>
    </main>
  );
}
