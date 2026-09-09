export class TaigaError extends Error {
  readonly status?: number;
  readonly hint?: string;

  constructor(message: string, options: { status?: number; hint?: string } = {}) {
    super(options.hint ? `${message}\n${options.hint}` : message);
    this.name = "TaigaError";
    this.status = options.status;
    this.hint = options.hint;
  }
}

/** Pull a human-readable message out of Taiga's error body shapes. */
export function extractMessage(body: unknown): string | undefined {
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 500);
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    // Walk through candidate keys and accept the first one that is actually usable.
    // Skip candidates of other types instead of short-circuiting on them.
    for (const key of ["_error_message", "detail", "non_field_errors"]) {
      const candidate = record[key];
      if (typeof candidate === "string") return candidate;
      if (Array.isArray(candidate) && typeof candidate[0] === "string") return candidate[0];
    }

    const fieldErrors = Object.entries(record)
      .filter(([key]) => !key.startsWith("_"))
      .map(([key, value]) =>
        Array.isArray(value) ? `${key}: ${value.join(", ")}` : undefined,
      )
      .filter(Boolean);
    if (fieldErrors.length > 0) return fieldErrors.join("; ");
  }
  return undefined;
}

export function describeHttpError(status: number, body: unknown): TaigaError {
  const detail = extractMessage(body);
  switch (status) {
    case 401:
      return new TaigaError("Taiga rejected the credentials.", {
        status,
        hint: "Check TAIGA_USERNAME and TAIGA_PASSWORD.",
      });
    case 403:
      return new TaigaError(
        detail ?? "Taiga refused the request: not enough permissions.",
        { status, hint: "Your account may lack the required project role." },
      );
    case 404:
      return new TaigaError(detail ?? "Not found in Taiga.", { status });
    default:
      return new TaigaError(detail ?? `Taiga returned HTTP ${status}.`, { status });
  }
}
