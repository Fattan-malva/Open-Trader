import { ExnessApiError } from "../exness/client.js";

export interface ToolFailure {
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
  hint?: string;
}

export type ToolResult<T> = { ok: true; data: T } | ToolFailure;

export function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

export function fail(
  code: string,
  message: string,
  retryable = false,
  hint?: string,
): ToolFailure {
  return { ok: false, code, message, retryable, hint };
}

export function fromToolError(error: unknown): ToolFailure {
  if (error instanceof ExnessApiError) {
    const retryable = error.status === 429 || error.status >= 500;
    const code =
      error.code !== undefined ? `EXNESS_${error.status}_${error.code}` : `EXNESS_${error.status}`;
    return fail(code, error.message, retryable, error.hint);
  }
  if (error instanceof Error) {
    return fail("INTERNAL", error.message, false);
  }
  return fail("INTERNAL", String(error), false);
}
