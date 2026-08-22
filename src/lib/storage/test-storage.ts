import "server-only";
import { TEST_MODE } from "@/lib/test-mode";

/**
 * E2E-only in-memory object store standing in for Supabase Storage — exists
 * for exactly the same reason src/lib/test-mode.ts's identity bypass does
 * (this sandbox has no real Supabase to talk to at all, so real Storage is
 * equally unreachable). Gated on the identical TEST_MODE flag, never a
 * second independent check.
 *
 * Attached to globalThis rather than a plain module-level variable — the
 * same reasoning as src/lib/prisma.ts's globalForPrisma. Next.js compiles
 * Server Actions (the upload path, via attachment-mutations.ts) and Route
 * Handlers (both download routes, and this module's own serving route)
 * into separate bundle graphs even within one `next start` process;
 * verified empirically that a plain module-level Map ends up as two
 * independent instances across that split, silently 404ing every
 * TEST_MODE download. globalThis is the one thing guaranteed to be the
 * same JS heap object across any number of separate module instantiations
 * within a single process.
 */
const globalForTestStorage = globalThis as unknown as {
  e2eTestStorage: Map<string, { body: Buffer; contentType: string }> | undefined;
};

const store = globalForTestStorage.e2eTestStorage ?? new Map<string, { body: Buffer; contentType: string }>();
globalForTestStorage.e2eTestStorage = store;

function key(bucket: string, path: string): string {
  return `${bucket}/${path}`;
}

export function testStorageUpload(bucket: string, path: string, body: Buffer, contentType: string): void {
  if (!TEST_MODE) throw new Error("testStorageUpload() called outside TEST_MODE");
  store.set(key(bucket, path), { body, contentType });
}

export function testStorageRemove(bucket: string, path: string): void {
  if (!TEST_MODE) throw new Error("testStorageRemove() called outside TEST_MODE");
  store.delete(key(bucket, path));
}

export function testStorageRead(bucket: string, path: string): { body: Buffer; contentType: string } | null {
  if (!TEST_MODE) return null;
  return store.get(key(bucket, path)) ?? null;
}

/**
 * Invoice System Slice 3, sub-PR 3b — create-only counterpart to
 * testStorageUpload() above, for exactly one caller
 * (src/lib/invoices/pdf/storage.ts): an archived invoice PDF is an
 * immutable legal artifact, so silently overwriting an existing Map entry
 * (testStorageUpload's own documented, correct behavior for every other
 * TEST_MODE caller — attachments/logos, which always use a fresh
 * server-generated id per upload anyway) would be the wrong contract here.
 * Mirrors real Supabase Storage's own `upsert: false` — an existing key at
 * this exact (bucket, path) is always a bug, never an intended overwrite,
 * so this returns a failure instead of touching the existing entry.
 */
export function testStorageUploadIfAbsent(
  bucket: string,
  path: string,
  body: Buffer,
  contentType: string,
): { ok: true } | { ok: false } {
  if (!TEST_MODE) throw new Error("testStorageUploadIfAbsent() called outside TEST_MODE");
  const k = key(bucket, path);
  if (store.has(k)) return { ok: false };
  store.set(k, { body, contentType });
  return { ok: true };
}
