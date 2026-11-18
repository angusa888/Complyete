export const SUPABASE_SETUP_MESSAGE =
  "Connect Supabase to continue. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, then restart the app.";

/** Public credentials only. Missing configuration deliberately leaves setup screens usable. */
export function getPublicSupabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    // A privileged Supabase key must never be accepted as browser configuration.
    if (key.startsWith("sb_secret_")) return null;
    if (key.startsWith("eyJ")) {
      const payload = JSON.parse(atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { role?: string };
      if (payload.role !== "anon") return null;
    }
    return { url, key };
  } catch {
    return null;
  }
}

/** Restrict redirects to local paths, including encoded browser-normalized separators. */
export function safeRedirectPath(value: unknown, fallback = "/") {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return fallback;
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith("//") || /[\\\r\n]/.test(decoded)) return fallback;
    const parsed = new URL(value, "https://admin.ese-llc.com");
    return parsed.origin === "https://admin.ese-llc.com" ? `${parsed.pathname}${parsed.search}${parsed.hash}` : fallback;
  } catch {
    return fallback;
  }
}
