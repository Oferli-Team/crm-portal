// Controllable fake for @/lib/storage/logo-storage (which imports
// "server-only" and would otherwise throw outside Next's own build — see
// test/integration/setup-mocks.ts for the vi.mock() that swaps it in).
// Mirrors test/support/storage-mock.ts's own shape exactly; kept as an
// independent module since logo Storage and Attachment Storage are
// deliberately separate systems (different bucket, different failure
// modes to control) — see logo-mutations.ts's own doc comment.

let uploadShouldFail = false;
export const removedLogoUrls: string[] = [];
let uploadCounter = 0;

export function setLogoUploadShouldFail(shouldFail: boolean): void {
  uploadShouldFail = shouldFail;
}

export function resetLogoStorageMock(): void {
  uploadShouldFail = false;
  removedLogoUrls.length = 0;
  uploadCounter = 0;
}

export async function mockUploadLogoObject(): Promise<
  { ok: true; publicUrl: string } | { ok: false; reason: string }
> {
  if (uploadShouldFail) return { ok: false, reason: "upload_failed" };
  uploadCounter += 1;
  return {
    ok: true,
    publicUrl: `https://mock.supabase.test/storage/v1/object/public/logos/mock-logo-${uploadCounter}.png`,
  };
}

export async function mockRemoveLogoObject({ publicUrl }: { publicUrl: string }): Promise<{ ok: true }> {
  removedLogoUrls.push(publicUrl);
  return { ok: true };
}
