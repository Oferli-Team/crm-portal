// Shared mutable state between test/integration/setup-mocks.ts's vi.mock()
// registrations and whatever integration test currently needs to "be"
// a particular authenticated identity. This is the ONLY thing mocked —
// everything downstream (getOrCreateUser, getCurrentMembership,
// getCurrentPortalUser, and every real Server Action built on top of them)
// runs unmocked, against the real Prisma-backed test database. Per the
// user's explicit constraint, Prisma itself is never mocked.

export type MockAuthUser = {
  id: string;
  email: string;
  user_metadata?: Record<string, unknown>;
};

let currentUser: MockAuthUser | null = null;

/** The identity the mocked Supabase client's auth.getUser() resolves to. */
export function setMockAuthUser(user: MockAuthUser | null): void {
  currentUser = user;
}

export function getMockAuthUser(): MockAuthUser | null {
  return currentUser;
}

/** In-memory cookie jar backing the mocked next/headers cookies(). */
const cookieStore = new Map<string, string>();

export function mockCookies() {
  return {
    get(name: string) {
      const value = cookieStore.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set(name: string, value: string) {
      cookieStore.set(name, value);
    },
    delete(name: string) {
      cookieStore.delete(name);
    },
  };
}

export function resetMockCookies(): void {
  cookieStore.clear();
}

// Matches current-user.ts's own ACTIVE_ORG_COOKIE constant exactly. Real
// requests set this via the org switcher; tests must set it explicitly
// before acting as anyone other than an OWNER — resolveActiveOrganizationId
// only auto-resolves an org from a bare identity via an OWNER membership
// (getOrCreateOrganizationId), so an ADMIN/MEMBER fixture user with no
// cookie set would otherwise have a brand-new personal org silently
// auto-provisioned for them instead of resolving to the fixture org.
const ACTIVE_ORG_COOKIE = "active_organization_id";

export function setMockActiveOrganization(organizationId: string): void {
  cookieStore.set(ACTIVE_ORG_COOKIE, organizationId);
}

/**
 * SaaS Signup Foundation (Stage 6.1): what the mocked Supabase client's
 * auth.signUp() should do next — configured explicitly per test, one-shot
 * (consumed and cleared by consumeMockSignUpConfig()), the same "must be
 * set before use" discipline as setMockAuthUser() already has for
 * getUser(). "session" mirrors a project with email confirmation
 * disabled (this app's own demo/seed accounts) — the caller is
 * immediately authenticated, so it also sets this as the current mock
 * auth user, exactly like the real SSR client persisting a session
 * cookie that a subsequent getUser() call in the same request then
 * reads back. "pending-confirmation" mirrors a project requiring email
 * confirmation — a real auth user id exists but no session yet, so
 * getUser() must NOT resolve to them. "error" mirrors Supabase rejecting
 * the signup outright (e.g. a duplicate email).
 */
export type MockSignUpConfig =
  | { kind: "session"; id?: string }
  | { kind: "pending-confirmation"; id?: string }
  | { kind: "error"; message: string };

let mockSignUpConfig: MockSignUpConfig | null = null;

export function setMockSignUpConfig(config: MockSignUpConfig): void {
  mockSignUpConfig = config;
}

/** Reads and clears the configured response — throws if a test invoked signUp() without configuring one first, rather than silently guessing a default. */
export function consumeMockSignUpConfig(): MockSignUpConfig {
  if (!mockSignUpConfig) {
    throw new Error(
      "setMockSignUpConfig(...) must be called before invoking a Server Action that calls supabase.auth.signUp().",
    );
  }
  const config = mockSignUpConfig;
  mockSignUpConfig = null;
  return config;
}

/**
 * Portal Analytics persistence foundation (docs/analytics-architecture.md
 * §12, Slice 1) — same one-shot, "must be set before use" discipline as
 * MockSignUpConfig, for the one remaining unmocked Supabase Auth method
 * this stage's tests need: signInWithPassword(). "success" mirrors a real
 * credential match — the caller is immediately authenticated, so it also
 * sets this as the current mock auth user, the same "reflects a persisted
 * session a subsequent getUser() call reads back" behavior signUp's own
 * "session" kind already has. "error" mirrors Supabase rejecting the
 * credentials (never distinguishing wrong-password from unknown-email, the
 * same generic behavior the real portalLogin/login actions already rely
 * on Supabase itself to provide).
 */
export type MockSignInConfig =
  | { kind: "success"; user: MockAuthUser }
  | { kind: "error"; message: string };

let mockSignInConfig: MockSignInConfig | null = null;

export function setMockSignInConfig(config: MockSignInConfig): void {
  mockSignInConfig = config;
}

/** Reads and clears the configured response — throws if a test invoked signInWithPassword() without configuring one first, rather than silently guessing a default. */
export function consumeMockSignInConfig(): MockSignInConfig {
  if (!mockSignInConfig) {
    throw new Error(
      "setMockSignInConfig(...) must be called before invoking a Server Action that calls supabase.auth.signInWithPassword().",
    );
  }
  const config = mockSignInConfig;
  mockSignInConfig = null;
  return config;
}

/** Call in afterEach — clears both the identity and the cookie jar so one test's "logged in as" state never leaks into the next. */
export function resetAuthMock(): void {
  currentUser = null;
  mockSignUpConfig = null;
  mockSignInConfig = null;
  cookieStore.clear();
}

/** Convenience: "log in as" a fixture user, in the given organization. */
export function actAs(user: MockAuthUser, organizationId: string): void {
  setMockAuthUser(user);
  setMockActiveOrganization(organizationId);
}
