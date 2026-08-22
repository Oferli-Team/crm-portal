import { prisma } from "@/lib/prisma";

export type MentionCandidate = {
  id: string;
  name: string;
  email: string;
};

/** Comments & Mentions Stage 4 §5/§20 — generous enough for real use, bounded so this never becomes an unbounded query as an org grows. */
export const MENTION_CANDIDATE_LIMIT = 50;

/**
 * Comments & Mentions Stage 4 (docs/comments-architecture.md §3/§8). The
 * composer's autocomplete source — deliberately server-resolved from the
 * *current* organizationId only (never a client-supplied org), staff
 * Membership only (a PortalUser has no Membership row at all, so it's
 * structurally impossible for one to appear here — not a filter that
 * could be forgotten). One bounded query, no per-keystroke round trip:
 * the caller (CommentsSection) fetches this once per page render and
 * passes the full list down as a prop; search/filtering as the user types
 * happens entirely client-side against this already-fetched list.
 *
 * This list is a UX convenience only, never an authorization source —
 * src/lib/comments/create-comment.ts and edit-comment.ts re-verify every
 * mentioned user's Membership independently, inside their own
 * transaction, regardless of what this query ever returned.
 */
export async function getMentionCandidates(organizationId: string): Promise<MentionCandidate[]> {
  const memberships = await prisma.membership.findMany({
    where: { organizationId },
    take: MENTION_CANDIDATE_LIMIT,
    orderBy: { createdAt: "asc" },
    select: { user: { select: { id: true, name: true, email: true } } },
  });

  return memberships.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email }));
}
