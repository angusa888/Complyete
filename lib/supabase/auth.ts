import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "./server";

/** Verify with Supabase Auth, then independently enforce the active domain staff link. */
export const getActiveStaff = cache(async () => {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return null;
  try {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return null;
    const { data: staff, error: staffError } = await supabase.from("staff")
      .select("*").eq("auth_user_id", user.id).eq("is_active", true).maybeSingle();
    if (staffError || !staff) return null;
    return { supabase, user, staff };
  } catch {
    return null;
  }
});

export async function requireActiveStaff() {
  const context = await getActiveStaff();
  if (!context) redirect("/login");
  return context;
}
