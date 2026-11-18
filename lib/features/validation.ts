import { z } from "zod";

export const uuidSchema = z.string().uuid();
export const requiredTextSchema = (max = 500) => z.string().trim().min(1).max(max);
export const optionalTextSchema = (max = 5000) => z.string().trim().max(max);
export const emailSchema = z.string().trim().email().max(254);
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Enter a valid calendar date.");

export function formText(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function formOptionalText(form: FormData, key: string, max = 5000) {
  const value = formText(form, key);
  return value ? optionalTextSchema(max).parse(value) : null;
}

export function formStringList(form: FormData, key: string) {
  return form.getAll(key).filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean);
}

export function formChecked(form: FormData, key: string) {
  const value = form.get(key);
  return value === "on" || value === "true" || value === "1";
}

/** Parse an optional JSON form field without treating absent values as malformed JSON. */
export function formJson<T>(form: FormData, key: string, schema: z.ZodType<T>, fallback: T): T {
  const raw = formText(form, key);
  if (!raw) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`The ${key.replaceAll("_", " ")} field is not valid JSON.`);
  }
  return schema.parse(parsed);
}
