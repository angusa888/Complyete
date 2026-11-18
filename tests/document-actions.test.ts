import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getActiveStaff: vi.fn() }));

vi.mock("@/lib/supabase/auth", () => ({ getActiveStaff: mocks.getActiveStaff }));

import { initiateUpload } from "@/app/actions/documents";

const validInput = {
  project_id: "11111111-1111-4111-8111-111111111111",
  title: "Permit",
  category: "Permits",
  subtype: "Building",
  original_filename: "permit.pdf",
  media_type: "application/pdf",
  byte_size: 1200,
  date_events: [{ type: "hearing", date: "2026-11-18", note: "First" }, { type: "hearing", date: "2026-11-18", note: "Continued" }],
};

describe("document upload validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getActiveStaff.mockResolvedValue(null);
  });

  it("rejects files over the 25 MB project limit before database access", async () => {
    const result = await initiateUpload({ ...validInput, byte_size: 25_000_001 });
    expect(result.error).toBeTruthy();
    expect(mocks.getActiveStaff).not.toHaveBeenCalled();
  });

  it("requires an allowed extension and matching MIME type", async () => {
    const result = await initiateUpload({ ...validInput, original_filename: "permit.exe", media_type: "application/pdf" });
    expect(result.error).toContain("Choose a PDF");
    expect(mocks.getActiveStaff).not.toHaveBeenCalled();
  });

  it("accepts repeatable hearing dates but rejects impossible dates", async () => {
    const valid = await initiateUpload({ ...validInput, original_filename: "plan.dwg", media_type: "application/octet-stream" });
    expect(valid.error).toBe("Sign in with an active staff account to continue.");
    expect(mocks.getActiveStaff).toHaveBeenCalledOnce();

    mocks.getActiveStaff.mockClear();
    const invalid = await initiateUpload({ ...validInput, date_events: [{ type: "filing", date: "2025-02-29" }] });
    expect(invalid.error).toBeTruthy();
    expect(mocks.getActiveStaff).not.toHaveBeenCalled();
  });

  it("rejects path separators in filenames", async () => {
    const result = await initiateUpload({ ...validInput, original_filename: "../permit.pdf" });
    expect(result.error).toBe("The file name is invalid.");
    expect(mocks.getActiveStaff).not.toHaveBeenCalled();
  });
});
