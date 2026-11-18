import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getPublicSupabaseEnv } from "@/lib/env";
import type { Database } from "@/lib/database.types";

export async function getSupabaseServerClient() {
  const env = getPublicSupabaseEnv();
  if (!env) return null;
  const cookieStore = await cookies();
  return createServerClient<Database>(env.url, env.key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot write cookies. proxy.ts refreshes before render.
        }
      },
    },
  });
}

/** Legacy starter alias; callers should handle missing setup explicitly. */
export const createClient = getSupabaseServerClient;
