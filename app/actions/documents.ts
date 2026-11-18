"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getActiveStaff } from "@/lib/supabase/auth";
import type { Json } from "@/lib/database.types";
import { safeActionError, STAFF_REQUIRED_MESSAGE } from "@/lib/features/shared";
import { dateSchema, formText, uuidSchema } from "@/lib/features/validation";

const BUCKET = "project-documents";
const MAX_FILE_SIZE = 25_000_000;
const SIGNED_URL_TTL_SECONDS = 120;

const categorySchema = z.enum([
  "Proposal",
  "Transmittal",
  "Filings",
  "Permits",
  "Compliance docs",
  "Other",
]);

const dateEventSchema = z.object({
  type: z.enum(["hearing", "filing", "issuance", "closure"]),
  date: dateSchema,
  note: z.string().trim().max(1000).optional(),
}).strict();

const uploadInputSchema = z.object({
  project_id: uuidSchema,
  document_id: uuidSchema.optional(),
  title: z.string().trim().min(1).max(500),
  category: categorySchema,
  subtype: z.string().trim().max(200).optional().default(""),
  original_filename: z.string().trim().min(1).max(255),
  media_type: z.string().trim().toLowerCase().max(200),
  byte_size: z.number().int().min(1).max(MAX_FILE_SIZE),
  date_events: z.array(dateEventSchema).max(100),
}).strict();

type UploadInput = z.infer<typeof uploadInputSchema>;
type StaffContext = NonNullable<Awaited<ReturnType<typeof getActiveStaff>>>;

class UserInputError extends Error {}

const mimeTypesByExtension: Record<string, readonly string[]> = {
  pdf: ["application/pdf"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  png: ["image/png"],
  dwg: ["application/acad", "application/x-acad", "image/vnd.dwg", "image/x-dwg", "application/octet-stream"],
  dxf: ["application/dxf", "image/vnd.dxf", "application/octet-stream"],
  zip: ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
};

function validateFileType(input: UploadInput) {
  if (/[\\/\u0000-\u001f]/.test(input.original_filename)) {
    throw new UserInputError("The file name is invalid.");
  }
  const extension = input.original_filename.split(".").pop()?.toLowerCase();
  const acceptedTypes = extension ? mimeTypesByExtension[extension] : undefined;
  if (!acceptedTypes) throw new UserInputError("Choose a PDF, DOCX, XLSX, JPG, PNG, DWG, DXF, or ZIP file.");
  if (!acceptedTypes.includes(input.media_type)) {
    throw new UserInputError("The file extension and file type do not match.");
  }
}

function parseError(error: unknown) {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Check the document fields and try again.";
  if (error instanceof UserInputError) return error.message;
  return safeActionError(error, "The document request could not be completed. Please try again.");
}

function errorResult(error: unknown) {
  return { error: parseError(error) };
}

async function activeContext() {
  const context = await getActiveStaff();
  if (!context) throw new UserInputError(STAFF_REQUIRED_MESSAGE);
  return context;
}

async function getProjectPath(context: StaffContext, projectId: string) {
  const { data, error } = await context.supabase
    .from("projects")
    .select("id,archived_at")
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.archived_at) throw new UserInputError("Choose an active project.");
  return `/projects/${data.id}`;
}

function revalidateDocumentPaths(projectPath?: string) {
  for (const path of new Set(["/documents", "/projects", ...(projectPath ? [projectPath] : [])])) {
    revalidatePath(path);
  }
}

export type InitiateUploadResult = {
  error?: string;
  upload?: {
    documentId: string;
    versionId: string;
    path: string;
    token: string;
    signedUrl: string;
  };
};

/** Creates an authorized immutable version and a single-use signed upload URL. */
export async function initiateUpload(input: unknown): Promise<InitiateUploadResult> {
  let context: StaffContext | undefined;
  let createdDocumentId: string | undefined;
  let pendingVersionId: string | undefined;

  try {
    const parsed = uploadInputSchema.parse(input);
    validateFileType(parsed);
    context = await activeContext();
    const projectPath = await getProjectPath(context, parsed.project_id);

    let documentId = parsed.document_id;
    if (documentId) {
      const { data: document, error } = await context.supabase
        .from("documents")
        .select("id,project_id,archived_at")
        .eq("id", documentId)
        .maybeSingle();
      if (error) throw error;
      if (!document || document.archived_at || document.project_id !== parsed.project_id) {
        throw new UserInputError("Choose an active document from this project.");
      }
    } else {
      const { data: document, error } = await context.supabase
        .from("documents")
        .insert({
          project_id: parsed.project_id,
          title: parsed.title,
          category: parsed.category,
          subtype: parsed.subtype || null,
        })
        .select("id")
        .single();
      if (error) throw error;
      documentId = document.id;
      createdDocumentId = document.id;
    }

    const { data: version, error: beginError } = await context.supabase.rpc("begin_document_upload", {
      p_document_id: documentId,
      p_original_filename: parsed.original_filename,
      p_media_type: parsed.media_type,
      p_byte_size: parsed.byte_size,
      p_date_events: parsed.date_events as Json,
    });
    if (beginError) throw beginError;
    if (!version) throw new UserInputError("The upload could not be authorized.");
    pendingVersionId = version.id;

    const { data: signedUpload, error: signedError } = await context.supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(version.object_path, { upsert: false });
    if (signedError) throw signedError;
    if (!signedUpload?.token || !signedUpload.signedUrl) {
      throw new UserInputError("The upload URL could not be created.");
    }

    revalidateDocumentPaths(projectPath);
    return {
      upload: {
        documentId,
        versionId: version.id,
        path: version.object_path,
        token: signedUpload.token,
        signedUrl: signedUpload.signedUrl,
      },
    };
  } catch (error) {
    if (context && pendingVersionId) {
      try {
        await context.supabase.rpc("invalidate_document_version", { p_version_id: pendingVersionId });
      } catch {
        // Keep the original upload error as the user-facing result.
      }
    }
    if (context && createdDocumentId) {
      try {
        await context.supabase.from("documents").update({
          archived_at: new Date().toISOString(),
          archived_by: context.staff.id,
        }).eq("id", createdDocumentId).is("archived_at", null);
      } catch {
        // The abandoned row is inactive if best-effort cleanup fails.
      }
    }
    return errorResult(error);
  }
}

export async function finalizeUpload(versionId: string): Promise<{ error?: string }> {
  try {
    const id = uuidSchema.parse(versionId);
    const context = await activeContext();
    const { data: version, error: versionError } = await context.supabase
      .from("document_versions")
      .select("id,document_id,upload_state")
      .eq("id", id)
      .maybeSingle();
    if (versionError) throw versionError;
    if (!version || version.upload_state !== "pending") {
      throw new UserInputError("This upload is no longer pending.");
    }
    const { data: document, error: documentError } = await context.supabase
      .from("documents")
      .select("id,project_id,archived_at")
      .eq("id", version.document_id)
      .maybeSingle();
    if (documentError) throw documentError;
    if (!document || document.archived_at) throw new UserInputError("The document is archived or unavailable.");
    const projectPath = await getProjectPath(context, document.project_id);
    const { error } = await context.supabase.rpc("finalize_document_upload", { p_version_id: id });
    if (error) throw error;
    revalidateDocumentPaths(projectPath);
    return {};
  } catch (error) {
    return errorResult(error);
  }
}

export async function getDownloadUrl(versionId: string): Promise<{ error?: string; url?: string }> {
  try {
    const id = uuidSchema.parse(versionId);
    const context = await activeContext();
    const { data: version, error: versionError } = await context.supabase
      .from("document_versions")
      .select("document_id,object_path,upload_state")
      .eq("id", id)
      .maybeSingle();
    if (versionError) throw versionError;
    if (!version || version.upload_state !== "available") {
      throw new UserInputError("This document version is not available for download.");
    }
    const { data: document, error: documentError } = await context.supabase
      .from("documents")
      .select("id,archived_at")
      .eq("id", version.document_id)
      .maybeSingle();
    if (documentError) throw documentError;
    if (!document || document.archived_at) throw new UserInputError("This document is archived or unavailable.");
    const { data, error } = await context.supabase.storage
      .from(BUCKET)
      .createSignedUrl(version.object_path, SIGNED_URL_TTL_SECONDS);
    if (error) throw error;
    if (!data?.signedUrl) throw new UserInputError("A download link could not be created.");
    return { url: data.signedUrl };
  } catch (error) {
    return errorResult(error);
  }
}

async function archiveAction(form: FormData, restore: boolean) {
  let projectPath: string | undefined;
  try {
    const id = uuidSchema.parse(formText(form, "id"));
    const context = await activeContext();
    const query = context.supabase.from("documents");
    const { data, error } = restore
      ? await query.update({ archived_at: null, archived_by: null }).eq("id", id).not("archived_at", "is", null).select("project_id").maybeSingle()
      : await query.update({ archived_at: new Date().toISOString(), archived_by: context.staff.id }).eq("id", id).is("archived_at", null).select("project_id").maybeSingle();
    if (error) throw error;
    if (!data) throw new UserInputError(restore ? "Document not found or already active." : "Document not found or already archived.");
    projectPath = `/projects/${data.project_id}`;
    revalidateDocumentPaths(projectPath);
    return { success: restore ? "Document restored." : "Document archived." };
  } catch (error) {
    return { error: parseError(error) };
  }
}

export async function archiveDocumentAction(_previous: { error?: string; success?: string }, form: FormData) {
  return archiveAction(form, false);
}

export async function restoreDocumentAction(_previous: { error?: string; success?: string }, form: FormData) {
  return archiveAction(form, true);
}
