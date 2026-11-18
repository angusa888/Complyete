"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { getPublicSupabaseEnv } from "@/lib/env";

let client: SupabaseClient<Database> | undefined;
export function getSupabaseBrowserClient() {
  const env = getPublicSupabaseEnv();
  if (!env) return null;
  client ??= createBrowserClient<Database>(env.url, env.key);
  return client;
}
