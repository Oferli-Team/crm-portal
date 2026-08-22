import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Thrown when NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is
 * missing. Callers in this module (attachments-storage.ts) catch this and
 * convert it into a typed { ok: false, reason: "not_configured" } result —
 * this file itself only ever throws, never returns a sentinel value, so a
 * missing client can never be silently mistaken for "operation succeeded".
 */
export class StorageNotConfiguredError extends Error {
  constructor() {
    super("Supabase Storage is not configured on this server.");
    this.name = "StorageNotConfiguredError";
  }
}

/**
 * Server-only Supabase client authenticated with the service-role key —
 * bypasses Storage RLS entirely, the same trust boundary prisma/seed.ts's
 * Admin API client already uses for Auth. `import "server-only"` above
 * turns any accidental import from a Client Component into a build-time
 * error instead of a leaked secret.
 *
 * Never logs the key or the resolved env values — only ever throws a
 * generic, secret-free error when configuration is missing.
 */
export function getStorageAdminClient(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new StorageNotConfiguredError();
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
