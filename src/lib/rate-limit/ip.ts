import { headers } from "next/headers";

const UNKNOWN_IP = "unknown";

function firstForwardedIp(value: string): string {
  return value.split(",")[0]?.trim() ?? "";
}

function extractIp(get: (name: string) => string | null): string {
  const realIp = get("x-real-ip");
  if (realIp) return realIp.trim();

  const forwardedFor = get("x-forwarded-for");
  if (forwardedFor) {
    const first = firstForwardedIp(forwardedFor);
    if (first) return first;
  }

  // Local/non-Vercel environments without either header — every such
  // request shares one bucket, a known limitation documented in Stage 4's
  // report rather than a silent gap.
  return UNKNOWN_IP;
}

/** For Server Actions, which receive no Request object of their own. */
export async function getRequestIp(): Promise<string> {
  const headerList = await headers();
  return extractIp((name) => headerList.get(name));
}

/** For Route Handlers, which do receive a real Request. */
export function getIpFromRequest(request: Request): string {
  return extractIp((name) => request.headers.get(name));
}
