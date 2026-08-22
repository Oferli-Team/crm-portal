-- Emergency lockdown: revoke direct Postgres/PostgREST access to the
-- `public` schema from the `anon` and `authenticated` roles.
--
-- Context: this application's only data-access path is Prisma, connected
-- as the `postgres` role via DATABASE_URL/DIRECT_URL (confirmed via
-- `SELECT current_user`). Supabase is used exclusively for Auth (the
-- `auth` schema, untouched here) and Storage (the `storage` schema,
-- untouched here, authorized via the service-role key rather than these
-- public-schema grants). A repository-wide search confirms zero use of
-- `supabase.from(...)` or any other PostgREST/Data API call for business
-- data anywhere in the application.
--
-- Prior to this migration, every table in `public` — and, via a
-- pre-existing default-privilege rule owned by the `postgres` role, every
-- future table created by that role too — granted full CRUD
-- (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER) to `anon` and
-- `authenticated`. Since NEXT_PUBLIC_SUPABASE_ANON_KEY is, by Next.js
-- convention, embedded in the public client bundle, this meant anyone
-- holding it could read/write/delete every row of every table directly via
-- Supabase's REST API, completely bypassing this application's own
-- authorization logic. Verified live with a single minimal read-only
-- request before this migration was written.
--
-- This migration closes that path with plain REVOKE statements rather than
-- Row-Level Security policies — RLS would be unnecessary complexity here,
-- since neither `anon` nor `authenticated` should ever reach these tables
-- at all; there is no legitimate PostgREST access pattern to carve a
-- policy out for.
--
-- Deliberately NOT touched by this migration:
--   - the `postgres` role's own privileges (the Prisma connection role;
--     confirmed as the owner of every existing table, so its access is
--     structurally unaffected by REVOKEs scoped to anon/authenticated)
--   - the `service_role` role's own privileges (relied on by Supabase's
--     own internal services; the application's Storage client uses the
--     service-role key against the separate `storage` schema, not these
--     grants, so this table lockdown has no bearing on Storage either way)
--   - table/column structure, indexes, foreign keys, or any row of data
--   - the `auth` and `storage` schemas
--   - USAGE on the `public` schema for anon/authenticated (left in place;
--     schema USAGE alone exposes no data once every table/sequence grant
--     is revoked, and Supabase's own tooling may reasonably expect the
--     schema to remain visible)
--   - default privileges owned by `supabase_admin` (a second, Supabase-
--     managed default-privilege rule exists for that role in this schema;
--     Prisma never creates objects as `supabase_admin`, so it is out of
--     scope for "future Prisma tables" and is not modified here)
--   - EXECUTE privileges on functions (no custom functions exist in this
--     schema today; out of scope for this table/sequence-focused fix)

-- 1. Revoke currently-granted privileges on every existing table.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- 2. Revoke currently-granted privileges on every existing sequence. No
-- sequences exist in this schema today (every model uses a UUID primary
-- key via @default(uuid()) or an application-assigned value, never a
-- serial/identity column) — included for completeness and to cover any
-- sequence a future migration might introduce before the default-privilege
-- rule below has a chance to apply to it.
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- 3. Prevent the same exposure from reappearing on tables/sequences
-- created by future Prisma migrations. Prisma always connects — and
-- therefore creates objects — as the `postgres` role, so the
-- default-privilege rule must be registered FOR ROLE postgres to actually
-- govern anything Prisma creates from here on; this replaces the
-- pre-existing postgres-owned rule that granted anon/authenticated full
-- access on every new table/sequence with one that grants them nothing.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon, authenticated;

-- 4. Belt-and-suspenders: anon/authenticated already had no CREATE
-- privilege on this schema (verified via has_schema_privilege before
-- writing this migration) — kept explicit so the invariant is asserted
-- here rather than only relied upon implicitly.
REVOKE CREATE ON SCHEMA public FROM anon, authenticated;
