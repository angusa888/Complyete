"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getActiveStaff } from "@/lib/supabase/auth";
import { safeRedirectPath, SUPABASE_SETUP_MESSAGE } from "@/lib/env";

export type AuthActionState = { error?: string; success?: string; data?: unknown };
const emailSchema = z.string().trim().email().max(254);
const passwordSchema = z.string().min(12, "Use at least 12 characters.").max(256);
const connectionError = "Unable to connect. Please try again.";

function confirmationUrl() {
  try {
    const origin = new URL(process.env.NEXT_PUBLIC_APP_URL || "https://admin.ese-llc.com");
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) return null;
    return `${origin.origin}/auth/confirm?next=/account`;
  } catch { return null; }
}

export async function loginAction(_previous: AuthActionState, form: FormData): Promise<AuthActionState> {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return { error: SUPABASE_SETUP_MESSAGE };
  const email = emailSchema.safeParse(form.get("email"));
  const password = z.string().min(1).max(256).safeParse(form.get("password"));
  if (!email.success || !password.success) return { error: "Enter your email and password." };
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.data, password: password.data });
    if (error || !data.user) return { error: "Unable to sign in with those credentials." };
    const { data: staff, error: staffError } = await supabase.from("staff").select("id").eq("auth_user_id", data.user.id).eq("is_active", true).maybeSingle();
    if (staffError || !staff) {
      await supabase.auth.signOut({ scope: "local" });
      return { error: "Staff access is unavailable. Contact your administrator." };
    }
  } catch { return { error: connectionError }; }
  revalidatePath("/", "layout");
  redirect(safeRedirectPath(form.get("next")));
}

export async function logoutAction(): Promise<void> {
  const supabase = await getSupabaseServerClient();
  if (supabase) await supabase.auth.signOut({ scope: "local" });
  revalidatePath("/", "layout");
  redirect("/login");
}

export async function updateEmailAction(_previous: AuthActionState, form: FormData): Promise<AuthActionState> {
  const context = await getActiveStaff();
  if (!context) return { error: "Sign in with an active staff account to continue." };
  const email = emailSchema.safeParse(form.get("email"));
  if (!email.success) return { error: "Enter a valid email address." };
  const emailRedirectTo = confirmationUrl();
  if (!emailRedirectTo) return { error: "The account confirmation URL requires administrator setup." };
  try {
    const { error } = await context.supabase.auth.updateUser({ email: email.data }, { emailRedirectTo });
    if (error) return { error: "Email could not be updated. Check the address or try again later." };
    return { success: "Check your email to confirm the change. Your staff directory email is managed by your administrator." };
  } catch { return { error: connectionError }; }
}

export async function updatePasswordAction(_previous: AuthActionState, form: FormData): Promise<AuthActionState> {
  const context = await getActiveStaff();
  if (!context) return { error: "Sign in with an active staff account to continue." };
  const password = passwordSchema.safeParse(form.get("password"));
  if (!password.success) return { error: "Use a password with 12 to 256 characters." };
  if (form.get("confirmPassword") !== password.data) return { error: "Passwords must match." };
  try {
    const { error } = await context.supabase.auth.updateUser({ password: password.data });
    if (error) return { error: "Password could not be updated. Sign in again or request a new recovery email." };
    return { success: "Password updated." };
  } catch { return { error: connectionError }; }
}

export async function resetPasswordAction(_previous: AuthActionState, form: FormData): Promise<AuthActionState> {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return { error: SUPABASE_SETUP_MESSAGE };
  const email = emailSchema.safeParse(form.get("email"));
  if (!email.success) return { error: "Enter a valid email address." };
  const redirectTo = confirmationUrl();
  if (!redirectTo) return { error: "The account recovery URL requires administrator setup." };
  try {
    await supabase.auth.resetPasswordForEmail(email.data, { redirectTo });
    // Same response for known and unknown addresses; no public registration.
    return { success: "If the account exists, a recovery email has been requested." };
  } catch { return { error: connectionError }; }
}
