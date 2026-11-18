import { afterEach, describe, expect, it, vi } from "vitest";
import { getPublicSupabaseEnv, safeRedirectPath } from "./env";

afterEach(() => vi.unstubAllEnvs());

describe("public Supabase configuration", () => {
  it("allows the app to show setup guidance without credentials", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    expect(getPublicSupabaseEnv()).toBeNull();
  });
  it.each(["sb_secret_private", `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({role: "service_role"}))}.signature`])("rejects privileged browser key %s", (key) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", key);
    expect(getPublicSupabaseEnv()).toBeNull();
  });
  it("accepts public publishable configuration", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_example");
    expect(getPublicSupabaseEnv()?.url).toBe("https://example.supabase.co");
  });
});

describe("post-auth redirects", () => {
  it.each(["https://example.com", "//example.com", "/\\example.com", "/%5cexample.com", "/%2fexample.com", "/%0aLocation:evil", "javascript:alert(1)", "/%invalid", null])("rejects unsafe destination %s", (value) => {
    expect(safeRedirectPath(value, "/account")).toBe("/account");
  });
  it("preserves a local path and query", () => {
    expect(safeRedirectPath("/projects/123?tab=tasks")).toBe("/projects/123?tab=tasks");
  });
});
