import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { headers } from "next/headers";
import { TEST_MODE } from "@/lib/test-mode";
import { testStorageUpload, testStorageRemove } from "./test-storage";
import { getStorageAdminClient } from "./admin-client";
import { LOGO_BUCKET } from "./logo-config";
import { extractLogoStoragePathFromPublicUrl } from "./logo-files";

/** Same Blob/ArrayBuffer/Uint8Array → Buffer conversion attachments-storage.ts's own toBuffer() uses, for the identical TEST_MODE reason. */
async function toBuffer(body: Blob | ArrayBuffer | Uint8Array): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return Buffer.from(await body.arrayBuffer());
}

export type LogoStorageFailureReason = "not_configured" | "upload_failed" | "remove_failed";

export type LogoUploadResult = { ok: true; publicUrl: string } | { ok: false; reason: LogoStorageFailureReason };
export type LogoRemoveResult = { ok: true } | { ok: false; reason: LogoStorageFailureReason };

function resolveClient(client?: SupabaseClient): SupabaseClient | null {
  if (client) return client;
  try {
    return getStorageAdminClient();
  } catch {
    return null;
  }
}

/** Same TEST_MODE-only stand-in URL shape createAttachmentSignedUrl() uses — a real, fetchable URL served by src/app/api/e2e-test-storage/[...path]/route.ts, since TEST_MODE has no real Supabase Storage to talk to at all. */
async function testModePublicUrlPrefix(): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "127.0.0.1";
  const proto = h.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}/api/e2e-test-storage/${LOGO_BUCKET}/`;
}

/**
 * Uploads to the dedicated public `logos` bucket (see logo-config.ts for
 * why this is never the private `attachments` bucket) and returns the
 * object's real public URL via Storage's own getPublicUrl() — never a
 * hand-built string. `upsert` is false: every call uses a fresh
 * server-generated path, so a collision is always a bug, never an intended
 * overwrite.
 */
export async function uploadLogoObject(
  { path, body, contentType }: { path: string; body: Blob | ArrayBuffer | Uint8Array; contentType: string },
  client?: SupabaseClient,
): Promise<LogoUploadResult> {
  if (TEST_MODE) {
    testStorageUpload(LOGO_BUCKET, path, await toBuffer(body), contentType);
    const prefix = await testModePublicUrlPrefix();
    return { ok: true, publicUrl: `${prefix}${path}` };
  }

  const resolved = resolveClient(client);
  if (!resolved) return { ok: false, reason: "not_configured" };

  try {
    const { error } = await resolved.storage.from(LOGO_BUCKET).upload(path, body, { contentType, upsert: false });
    if (error) return { ok: false, reason: "upload_failed" };

    const { data } = resolved.storage.from(LOGO_BUCKET).getPublicUrl(path);
    return { ok: true, publicUrl: data.publicUrl };
  } catch {
    return { ok: false, reason: "upload_failed" };
  }
}

/**
 * Removes exactly one object, identified by the public URL previously
 * returned by uploadLogoObject (recovered back to a Storage path via
 * extractLogoStoragePathFromPublicUrl) — never by a caller-supplied path
 * directly, so there is only ever one place (this function) that has to
 * agree with uploadLogoObject on the URL↔path mapping. An unparseable URL
 * is reported as remove_failed rather than thrown; every caller of this
 * function already treats removal as best-effort.
 */
export async function removeLogoObject(
  { publicUrl }: { publicUrl: string },
  client?: SupabaseClient,
): Promise<LogoRemoveResult> {
  if (TEST_MODE) {
    const prefix = await testModePublicUrlPrefix();
    if (!publicUrl.startsWith(prefix)) return { ok: true };
    testStorageRemove(LOGO_BUCKET, publicUrl.slice(prefix.length));
    return { ok: true };
  }

  const resolved = resolveClient(client);
  if (!resolved) return { ok: false, reason: "not_configured" };

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const path = supabaseUrl
    ? extractLogoStoragePathFromPublicUrl({ publicUrl, supabaseUrl, bucket: LOGO_BUCKET })
    : null;
  if (!path) return { ok: false, reason: "remove_failed" };

  try {
    const { error } = await resolved.storage.from(LOGO_BUCKET).remove([path]);
    return error ? { ok: false, reason: "remove_failed" } : { ok: true };
  } catch {
    return { ok: false, reason: "remove_failed" };
  }
}
