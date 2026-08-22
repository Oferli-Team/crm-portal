export type ActivityCursor = { createdAt: string; id: string };

const UUID_PATTERN = /^[0-9a-f-]{36}$/i;

/**
 * Base64url-encoded JSON of { createdAt, id } — the keyset pagination
 * cursor for the Activity timeline (ORDER BY createdAt DESC, id DESC).
 *
 * This is never an authorization boundary: it only narrows a WHERE clause
 * that already requires organizationId (see buildActivityWhere), so a
 * forged, stale, or foreign-org cursor can't leak anything — at worst it
 * silently returns zero or unexpected-but-still-own-org rows.
 */
export function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Returns null for anything malformed — callers treat that as "start over". */
export function decodeActivityCursor(raw: string): ActivityCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("createdAt" in parsed) ||
    !("id" in parsed) ||
    typeof (parsed as Record<string, unknown>).createdAt !== "string" ||
    typeof (parsed as Record<string, unknown>).id !== "string"
  ) {
    return null;
  }

  const { createdAt, id } = parsed as { createdAt: string; id: string };
  if (Number.isNaN(new Date(createdAt).getTime())) return null;
  if (!UUID_PATTERN.test(id)) return null;

  return { createdAt, id };
}
