// Sale-Ready Phase A.1 (Business Identity), PR4. A dedicated, public
// bucket — deliberately NOT the private "attachments" bucket. A logo must
// resolve to a real, permanent public URL usable directly in <img src>
// anywhere (including unauthenticated contexts, e.g. a public invoice),
// which the private "attachments" bucket's 60-second signed URLs cannot
// provide (see OrganizationProfile.logoUrl's own schema comment). This
// bucket must be created (and marked public) in the Supabase project
// before a real upload can succeed — see this PR's report for the exact
// step; getStorageAdminClient() itself never creates buckets.
export const LOGO_BUCKET = "logos";

export const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB

export type AllowedLogoType = {
  mimeType: string;
  /** Lowercase, no leading dot. */
  extensions: readonly string[];
};

/**
 * Deliberately narrower than ALLOWED_ATTACHMENT_TYPES — a logo is always
 * rendered directly as an <img>, so only real raster formats a browser can
 * render safely are allowed. No SVG (can carry embedded scripts, same
 * reasoning ALLOWED_ATTACHMENT_TYPES's own doc comment gives for excluding
 * it), no GIF, nothing else.
 */
export const ALLOWED_LOGO_TYPES: readonly AllowedLogoType[] = [
  { mimeType: "image/png", extensions: ["png"] },
  { mimeType: "image/jpeg", extensions: ["jpg", "jpeg"] },
  { mimeType: "image/webp", extensions: ["webp"] },
] as const;
