/**
 * Every background job (retry, cleanup) returns this exact shape — safe to
 * hand straight back as a cron route's JSON response, logged, or asserted
 * on in tests. Deliberately excludes anything identifying: no email, no
 * user/organization name, no Notification/Delivery id, no provider
 * response, no metadata, no secret. Just aggregate counts.
 */
export type JobSummary = {
  scanned: number;
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  deleted: number;
};

export function emptyJobSummary(): JobSummary {
  return { scanned: 0, claimed: 0, sent: 0, failed: 0, skipped: 0, deleted: 0 };
}
