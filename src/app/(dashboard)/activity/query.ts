import { Prisma } from "@/generated/prisma/client";
import type { ActivityAction, ActivityEntityType } from "@/generated/prisma/enums";
import { parseSearchParam, parseEnumParam, type RawSearchParams } from "@/lib/list-params";
import { decodeActivityCursor, type ActivityCursor } from "@/lib/activity/cursor";

export const ACTIVITY_PAGE_SIZE = 25;

export const ACTIVITY_ENTITY_TYPES = [
  "CLIENT",
  "PROJECT",
  "TASK",
  "INVOICE",
  "MEMBERSHIP",
  "INVITATION",
  "PORTAL_USER",
] as const satisfies readonly ActivityEntityType[];

export const ACTIVITY_ACTION_GROUPS = {
  data: ["CREATED", "UPDATED", "STATUS_CHANGED", "DELETED", "FILE_UPLOADED", "FILE_DELETED"],
  invitations: [
    "INVITATION_SENT",
    "INVITATION_RESENT",
    "INVITATION_CANCELED",
    "INVITATION_ACCEPTED",
    "PORTAL_INVITATION_SENT",
    "PORTAL_INVITATION_RESENT",
    "PORTAL_INVITATION_CANCELED",
    "PORTAL_INVITATION_ACCEPTED",
  ],
  team: [
    "ROLE_CHANGED",
    "OWNERSHIP_TRANSFERRED",
    "MEMBER_REMOVED",
    "MEMBER_LEFT",
    "PORTAL_USER_REMOVED",
  ],
} as const satisfies Record<string, readonly ActivityAction[]>;

export const ACTIVITY_ACTION_GROUP_KEYS = Object.keys(
  ACTIVITY_ACTION_GROUPS,
) as (keyof typeof ACTIVITY_ACTION_GROUPS)[];

export type ActivityActionGroup = keyof typeof ACTIVITY_ACTION_GROUPS;

export type ActivityListParams = {
  entityType?: ActivityEntityType;
  actionGroup?: ActivityActionGroup;
  actorId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  cursor: ActivityCursor | null;
  /** True only when a cursor param was present but failed to decode. */
  cursorInvalid: boolean;
};

const UUID_PATTERN = /^[0-9a-f-]{36}$/i;

function parseDateInputParam(value: string | string[] | undefined): Date | undefined {
  const raw = parseSearchParam(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Formats a Date back to the "YYYY-MM-DD" shape <input type="date"> expects. */
export function dateInputValue(date: Date | undefined): string {
  return date ? date.toISOString().slice(0, 10) : "";
}

export function parseActivityListParams(searchParams: RawSearchParams): ActivityListParams {
  const entityType = parseEnumParam(searchParams.entityType, ACTIVITY_ENTITY_TYPES);
  const actionGroup = parseEnumParam(searchParams.actionGroup, ACTIVITY_ACTION_GROUP_KEYS);

  const actorIdRaw = parseSearchParam(searchParams.actorId);
  // Format-checked only (UUID column would otherwise error on garbage
  // input) — actual membership scoping is handled by organizationId in
  // buildActivityWhere, not by this check.
  const actorId = UUID_PATTERN.test(actorIdRaw) ? actorIdRaw : undefined;

  const dateFrom = parseDateInputParam(searchParams.dateFrom);
  const dateTo = parseDateInputParam(searchParams.dateTo);

  const cursorRaw = parseSearchParam(searchParams.cursor);
  const cursor = cursorRaw ? decodeActivityCursor(cursorRaw) : null;
  const cursorInvalid = cursorRaw.length > 0 && cursor === null;

  return { entityType, actionGroup, actorId, dateFrom, dateTo, cursor, cursorInvalid };
}

function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * organizationId is always the first, non-optional condition — every other
 * filter is layered on top of it, never a substitute for it. A foreign-org
 * actorId (or any other filter value that never co-occurred with this org)
 * simply yields zero rows; it can't surface another organization's data.
 */
export function buildActivityWhere(
  organizationId: string,
  params: ActivityListParams,
): Prisma.ActivityWhereInput {
  const where: Prisma.ActivityWhereInput = { organizationId };

  if (params.entityType) {
    where.entityType = params.entityType;
  }
  if (params.actionGroup) {
    where.action = { in: [...ACTIVITY_ACTION_GROUPS[params.actionGroup]] };
  }
  if (params.actorId) {
    where.actorId = params.actorId;
  }
  if (params.dateFrom || params.dateTo) {
    where.createdAt = {
      ...(params.dateFrom ? { gte: params.dateFrom } : {}),
      ...(params.dateTo ? { lte: endOfDay(params.dateTo) } : {}),
    };
  }

  if (params.cursor) {
    const cursorDate = new Date(params.cursor.createdAt);
    // Keyset pagination for ORDER BY createdAt DESC, id DESC: strictly
    // older createdAt, OR the same createdAt with a strictly smaller id —
    // this is what makes ties on createdAt not produce duplicates/gaps
    // across pages.
    where.OR = [
      { createdAt: { lt: cursorDate } },
      { createdAt: cursorDate, id: { lt: params.cursor.id } },
    ];
  }

  return where;
}
