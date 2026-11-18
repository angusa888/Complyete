export type ActionState = {
  error?: string;
  success?: string;
  data?: unknown;
};

export const STAFF_REQUIRED_MESSAGE = "Sign in with an active staff account to continue.";
export const WORKSPACE_LOAD_ERROR = "Workspace data could not be loaded. Refresh the page or contact your administrator.";

/** Keep database/provider diagnostics out of staff-facing action results. */
export function safeActionError(error: unknown, fallback = "The request could not be completed. Please try again.") {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    switch (error.code) {
      case "23505": return "That value is already in use.";
      case "23503": return "A linked record could not be found.";
      case "23514": return "The record does not meet the required completion rules.";
      case "42501": return "Your staff account does not have access to that record.";
    }
  }
  return fallback;
}
