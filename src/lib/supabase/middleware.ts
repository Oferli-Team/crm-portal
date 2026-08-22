import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseCookieOptions } from "./cookie-options";
import { TEST_MODE } from "@/lib/test-mode";

export async function updateSession(request: NextRequest) {
  const response = NextResponse.next({ request });

  // TEST_MODE has no real Supabase Auth session to refresh — the test
  // identity cookie (see src/lib/test-mode.ts) isn't a Supabase session
  // and needs no token-refresh call. Without this, every request would
  // make a real network call to NEXT_PUBLIC_SUPABASE_URL, which has no
  // real Auth service listening in this sandbox (see the Stage 4 report).
  if (TEST_MODE) {
    return response;
  }

  return updateRealSupabaseSession(request, response);
}

async function updateRealSupabaseSession(request: NextRequest, initialResponse: NextResponse) {
  let response = initialResponse;

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: getSupabaseCookieOptions(),
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Revalidates the token against Supabase Auth (and refreshes it if
  // expired) rather than trusting the cookie payload alone.
  await supabase.auth.getUser();

  return response;
}
