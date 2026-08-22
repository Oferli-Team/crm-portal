// Controllable fake for @/lib/storage/attachments-storage (which imports
// "server-only" and would otherwise throw outside Next's own build — see
// test/integration/setup-mocks.ts for the vi.mock() that swaps it in).
// This never touches a real Supabase Storage bucket; it only lets
// attachment integration tests exercise the REAL uploadAttachmentForEntity/
// deleteAttachmentForEntity Prisma+Activity logic, including the
// upload-succeeds-but-DB-fails compensation path.

let uploadShouldFail = false;
export const removedPaths: string[] = [];

export function setUploadShouldFail(shouldFail: boolean): void {
  uploadShouldFail = shouldFail;
}

// Portal Analytics persistence foundation (docs/analytics-architecture.md
// §12, Slice 1) — controllable fake for createAttachmentSignedUrl, the one
// export this module previously left unmocked (nothing needed it until the
// portal download route's own analytics-write-ordering tests did). A
// deterministic successful URL by default, so tests that don't care about
// the signed-URL step at all don't need to configure anything; resettable
// to a forced failure for the one test that specifically needs the 502
// path.
let signedUrlShouldFail = false;

export function setSignedUrlShouldFail(shouldFail: boolean): void {
  signedUrlShouldFail = shouldFail;
}

export function resetStorageMock(): void {
  uploadShouldFail = false;
  signedUrlShouldFail = false;
  removedPaths.length = 0;
}

export async function mockUploadAttachmentObject(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (uploadShouldFail) return { ok: false, reason: "upload_failed" };
  return { ok: true };
}

export async function mockRemoveAttachmentObject({
  path,
}: {
  path: string;
}): Promise<{ ok: true }> {
  removedPaths.push(path);
  return { ok: true };
}

export async function mockCreateAttachmentSignedUrl(): Promise<
  { ok: true; url: string } | { ok: false; reason: string }
> {
  if (signedUrlShouldFail) return { ok: false, reason: "provider_error" };
  return { ok: true, url: "https://mock-storage.test/signed/mock-object" };
}
