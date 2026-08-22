import { cache } from "react";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { getSupabaseCookieOptions } from "./cookie-options";
import { TEST_MODE, TEST_USER_COOKIE, decodeTestModeIdentity } from "@/lib/test-mode";

/**
 * TEST_MODE-only stand-in for a real Supabase client, exposing just the
 * two methods this app's server code actually calls on the result of
 * createClient() in every path E2E tests exercise: auth.getUser() and
 * auth.signOut(). See src/lib/test-mode.ts for the full justification and
 * the exact gating guarantee — this branch is unreachable whenever
 * TEST_MODE is false, which is always true outside Playwright's own E2E
 * webServer process. Cast to SupabaseClient so every call site keeps its
 * real type — signInWithPassword/signUp/verifyOtp/etc. are intentionally
 * NOT implemented here, since E2E tests inject a session directly rather
 * than exercising the login/signup forms (there is no real Supabase Auth
 * to sign in against locally); calling one in TEST_MODE would throw "is
 * not a function", loudly, rather than silently doing nothing. updateUser()
 * is the one exception (Sale-Ready Phase B, PR1, Password Recovery): the
 * reset-password Server Action calls it generically, the same call for
 * every session regardless of how it was established, so it needs a real
 * stub here rather than being routed around — TEST_MODE has no real
 * password to actually change, so this just reports success
 * unconditionally, mirroring signOut()'s own "no real backing state,
 * simulate the observable effect" shape below.
 */
function createTestModeClient(): SupabaseClient {
  return {
    auth: {
      async getUser() {
        const cookieStore = await cookies();
        const identity = decodeTestModeIdentity(cookieStore.get(TEST_USER_COOKIE)?.value);
        const user: User | null = identity
          ? {
              id: identity.id,
              email: identity.email,
              user_metadata: {},
              app_metadata: {},
              aud: "authenticated",
              created_at: new Date(0).toISOString(),
            }
          : null;
        return { data: { user }, error: null };
      },
      async updateUser() {
        return { data: { user: null }, error: null };
      },
      async signOut() {
        const cookieStore = await cookies();
        try {
          cookieStore.delete(TEST_USER_COOKIE);
        } catch {
          // Called from a Server Component context; safe to ignore, same
          // as the real client's setAll() below.
        }
        return { error: null };
      },
    },
  } as unknown as SupabaseClient;
}

export async function createClient() {
  if (TEST_MODE) {
    return createTestModeClient();
  }

  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: getSupabaseCookieOptions(),
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // setAll called from a Server Component; safe to ignore
            // when middleware handles session refresh instead.
          }
        },
      },
    },
  );
}

/**
 * Stage 6.2.1 (session-redirect / Server Action UX stabilization).
 * Request-scoped memoized resolution of the currently authenticated
 * Supabase user via a real auth.getUser() call — never trusts the
 * cookie payload alone, exactly like every existing call site already
 * didn't. A single dashboard request routinely resolves "who is the
 * current user?" several times over — the root (dashboard) layout, then
 * getOrCreateUser() (itself called from ~20 pages/actions, per that
 * function's own doc comment), then the page being rendered, then any
 * Server Action it invokes — and until now each of those created its
 * own createClient() and made its own independent network round-trip to
 * Supabase Auth. When the access token is near expiry, Supabase rotates
 * the refresh token on every refresh call; several of these redundant,
 * unmemoized calls landing within the same request could race each
 * other, and every call after the first would present an
 * already-rotated (now-invalid) refresh token and fail — surfacing as a
 * `redirect("/login")` from a *later* call site, even though the very
 * first call in that same request had already succeeded (the mutation
 * itself, gated by that first call, would have already committed).
 *
 * React's cache() scopes this function's result to exactly one request
 * (or one Server Action invocation) — no matter how many call sites ask
 * this question during that one request, the real network validation
 * now happens exactly once, and every caller shares the same answer.
 * This changes nothing about *how* auth is verified (the same real
 * getUser() call, against the same real Supabase Auth server, same
 * cookies, same TEST_MODE branch) — only how many times it was
 * redundantly repeated per request. getOrCreateUser() and
 * (dashboard)/layout.tsx's own top-level check are this helper's first
 * two callers; every other existing auth.getUser() call site (login/
 * signup pages, the Client Portal side) is unchanged.
 */
export const getVerifiedAuthUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});
