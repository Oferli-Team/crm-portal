"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Portal-specific wrapper around the same Supabase sign-out used by staff
 * (@/app/(dashboard)/actions.ts) — that action is generic internally, but
 * its redirect target is hardcoded to /login, which is wrong here. A
 * portal identity must always land back on /portal/login, never /login.
 */
export async function portalSignOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/portal/login");
}
