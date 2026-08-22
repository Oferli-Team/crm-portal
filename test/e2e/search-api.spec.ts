import { test, expect, type BrowserContext } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

/**
 * Global Search Stage 2 — direct HTTP/API contract coverage only. No
 * Search UI exists yet (Stage 4's own concern), so this file deliberately
 * never opens a `page` or navigates a browser — every request here goes
 * through Playwright's `request` API context (`context.request`, which
 * shares cookies with a real `BrowserContext` set up the exact same way
 * every other E2E spec in this suite already authenticates), against the
 * real production build (`next start`) this whole E2E suite already runs
 * against. This is "integration + HTTP coverage" per Stage 2's own scope,
 * not a browser regression test.
 */

async function setActiveOrg(context: BrowserContext, baseURL: string, organizationId: string): Promise<void> {
  await context.addCookies([
    {
      name: "active_organization_id",
      value: organizationId,
      domain: new URL(baseURL).hostname,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

test("no session -> 401 JSON, no redirect Location, no HTML", async ({ context, baseURL }) => {
  const response = await context.request.get(`${baseURL}/api/search?q=acme`);
  expect(response.status()).toBe(401);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(response.headers()["location"]).toBeUndefined();
  const body = await response.json();
  expect(body).toEqual({ error: expect.any(String) });
  const text = JSON.stringify(body);
  expect(text.toLowerCase()).not.toContain("<html");
});

test("portal session -> 403 JSON", async ({ context, baseURL }) => {
  await injectTestSession(context, { id: fixtures.portalUser.id, email: fixtures.portalUser.email }, baseURL!);
  const response = await context.request.get(`${baseURL}/api/search?q=acme`);
  expect(response.status()).toBe(403);
  expect(response.headers()["content-type"]).toContain("application/json");
  const body = await response.json();
  expect(body).toEqual({ error: expect.any(String) });
});

test("staff session -> 200 JSON with the stable response shape", async ({ context, baseURL }) => {
  await injectTestSession(context, { id: fixtures.owner.id, email: fixtures.owner.email }, baseURL!);
  await setActiveOrg(context, baseURL!, fixtures.orgA.id);

  const response = await context.request.get(`${baseURL}/api/search?q=${encodeURIComponent(fixtures.project.name)}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");

  const body = await response.json();
  expect(body).toHaveProperty("query");
  expect(Array.isArray(body.groups)).toBe(true);
  const projectGroup = body.groups.find((g: { type: string }) => g.type === "PROJECT");
  expect(projectGroup).toBeDefined();
  expect(projectGroup.items.some((r: { id: string }) => r.id === fixtures.project.id)).toBe(true);
});

test("Cache-Control is private, no-store on a real search response", async ({ context, baseURL }) => {
  await injectTestSession(context, { id: fixtures.owner.id, email: fixtures.owner.email }, baseURL!);
  await setActiveOrg(context, baseURL!, fixtures.orgA.id);
  const response = await context.request.get(`${baseURL}/api/search?q=acme`);
  const cacheControl = response.headers()["cache-control"] ?? "";
  expect(cacheControl).toContain("no-store");
  expect(cacheControl).toContain("private");
});

test("a query below the minimum length returns 200 with an empty groups array", async ({ context, baseURL }) => {
  await injectTestSession(context, { id: fixtures.owner.id, email: fixtures.owner.email }, baseURL!);
  await setActiveOrg(context, baseURL!, fixtures.orgA.id);
  const response = await context.request.get(`${baseURL}/api/search?q=a`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.groups).toEqual([]);
});

test("security headers (CSP etc.) are still present on the API route", async ({ context, baseURL }) => {
  await injectTestSession(context, { id: fixtures.owner.id, email: fixtures.owner.email }, baseURL!);
  await setActiveOrg(context, baseURL!, fixtures.orgA.id);
  const response = await context.request.get(`${baseURL}/api/search?q=acme`);
  const headers = response.headers();
  expect(headers["content-security-policy"]).toBeTruthy();
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
});

test("rate limiting: enough requests in a burst eventually returns 429 JSON, without leaking counters", async ({
  context,
  baseURL,
}) => {
  await injectTestSession(context, { id: fixtures.owner.id, email: fixtures.owner.email }, baseURL!);
  await setActiveOrg(context, baseURL!, fixtures.orgA.id);

  let limitedResponse: Awaited<ReturnType<typeof context.request.get>> | null = null;
  // SEARCH_LIMIT is 200/15min (src/lib/rate-limit/limits.ts) — comfortably
  // exceeded by 210 sequential requests within this one test.
  for (let i = 0; i < 210; i++) {
    const response = await context.request.get(`${baseURL}/api/search?q=burst${i}`);
    if (response.status() === 429) {
      limitedResponse = response;
      break;
    }
  }

  expect(limitedResponse).not.toBeNull();
  expect(limitedResponse!.headers()["content-type"]).toContain("application/json");
  const body = await limitedResponse!.json();
  expect(body).toEqual({ error: "Too many requests. Please try again later." });
});
