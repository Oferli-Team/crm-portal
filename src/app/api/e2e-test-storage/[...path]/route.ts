import { NextResponse } from "next/server";
import { TEST_MODE } from "@/lib/test-mode";
import { testStorageRead } from "@/lib/storage/test-storage";

/**
 * The TEST_MODE-only stand-in for a real Supabase Storage signed-URL
 * target — src/lib/storage/attachments-storage.ts's createAttachmentSignedUrl
 * redirects here instead of a real bucket when TEST_MODE is on. Gated on
 * the exact same flag as everywhere else (see src/lib/test-mode.ts): with
 * TEST_MODE unset (every real build/deployment), this 404s unconditionally
 * before touching the in-memory test store at all, so there is nothing here
 * for a normal production app to ever serve.
 */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/e2e-test-storage/[...path]">,
) {
  if (!TEST_MODE) {
    return new NextResponse("Not found", { status: 404 });
  }

  const { path: segments } = await ctx.params;
  if (segments.length < 2) {
    return new NextResponse("Not found", { status: 404 });
  }

  const [bucket, ...rest] = segments;
  const object = testStorageRead(bucket, rest.join("/"));
  if (!object) {
    return new NextResponse("Not found", { status: 404 });
  }

  return new NextResponse(new Uint8Array(object.body), {
    status: 200,
    headers: { "Content-Type": object.contentType },
  });
}
