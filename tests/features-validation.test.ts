import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formChecked, formJson, formOptionalText, formStringList, formText, dateSchema } from "@/lib/features/validation";

describe("feature form validation helpers", () => {
  it("reads trimmed text and optional empty fields consistently", () => {
    const form = new FormData();
    form.set("name", "  Staking  ");
    form.set("empty", "  ");
    expect(formText(form, "name")).toBe("Staking");
    expect(formOptionalText(form, "empty")).toBeNull();
  });

  it("preserves valid zero and false values in JSON answers", () => {
    const form = new FormData();
    form.set("answers", '{"count":0,"approved":false}');
    expect(formJson(form, "answers", z.object({ count: z.number(), approved: z.boolean() }), { count: 1, approved: true }))
      .toEqual({ count: 0, approved: false });
  });

  it("reads checkbox and repeated multiselect values", () => {
    const form = new FormData();
    form.set("enabled", "on");
    form.append("staff_ids", "staff-a");
    form.append("staff_ids", "staff-b");
    expect(formChecked(form, "enabled")).toBe(true);
    expect(formStringList(form, "staff_ids")).toEqual(["staff-a", "staff-b"]);
  });

  it("accepts only real calendar dates", () => {
    expect(dateSchema.safeParse("2024-02-29").success).toBe(true);
    expect(dateSchema.safeParse("2025-02-29").success).toBe(false);
    expect(dateSchema.safeParse("2025-13-01").success).toBe(false);
  });
});
