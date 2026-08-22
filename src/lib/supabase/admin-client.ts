import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Thrown when NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is
 * missing. Sale-Ready Phase B, PR1 (Password Recovery) — mirrors
 * src/lib/storage/admin-client.ts's own StorageNotConfiguredError exactly,
 * kept as its own domain-scoped error/getter rather than reusing the
 * Storage one: same shape, different concern (Auth admin operations, not
 * Storage), matching this codebase's existing convention of small,
 * independent, self-contained modules per domain.
 */
export class SupabaseAuthAdminNotConfiguredError extends Error {
  constructor() {
    super("Supabase Auth admin API is not configured on this server.");
    this.name = "SupabaseAuthAdminNotConfiguredError";
  }
}

/**
 * Server-only Supabase client authenticated with the service-role key —
 * required for admin.generateLink(), which the regular anon-key request
 * client (src/lib/supabase/server.ts) cannot call. `import "server-only"`
 * turns any accidental import from a Client Component into a build-time
 * error instead of a leaked secret.
 *
 * Never logs the key or the resolved env values — only ever throws a
 * generic, secret-free error when configuration is missing.
 */
export function getSupabaseAuthAdminClient(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new SupabaseAuthAdminNotConfiguredError();
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
