import type { TaigaConfig } from "./config.js";
import type { TaigaAuth } from "./auth.js";
import { TaigaError, describeHttpError } from "./errors.js";

export type Params = Record<string, string | number | boolean | undefined>;

export interface ListResult<T> {
  items: T[];
  total: number;
  page: number;
  hasMore: boolean;
}

export class TaigaClient {
  private readonly base: string;
  private readonly origin: string;

  constructor(
    config: TaigaConfig,
    private readonly auth: TaigaAuth,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `${config.url}/api/v1`;
    this.origin = new URL(config.url).origin;
  }

  /** True when `url` points at the configured Taiga instance itself. */
  private isOwnOrigin(url: string): boolean {
    try {
      return new URL(url).origin === this.origin;
    } catch {
      return false;
    }
  }

  private buildUrl(path: string, params?: Params): string {
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * Perform a request against an absolute URL, re-authenticating once on 401.
   *
   * The session token goes out only to the configured Taiga origin. Taiga can
   * be run with an S3-style media backend, in which case the URL it hands back
   * for an attachment points at a third-party host — and that URL already
   * authorises itself through its `?token=` query parameter, so the header is
   * not merely unnecessary there, it would hand the user's Taiga session to
   * someone else's server.
   *
   * `redactUrl` keeps that same signed URL out of the network-error message:
   * a tool result carrying it would be a no-login-required download link
   * sitting in the transcript.
   */
  private async sendWithRetry(
    url: string,
    init: RequestInit,
    redactUrl = false,
  ): Promise<Response> {
    const ownOrigin = this.isOwnOrigin(url);
    const send = async (): Promise<Response> => {
      const headers = { ...(init.headers as Record<string, string> | undefined) };
      if (ownOrigin) headers.Authorization = `Bearer ${await this.auth.getToken()}`;
      try {
        return await this.fetchImpl(url, { ...init, headers });
      } catch {
        throw new TaigaError(
          redactUrl ? "Cannot reach the Taiga file service." : `Cannot reach Taiga at ${url}.`,
          { hint: "Check TAIGA_URL and that the instance is running." },
        );
      }
    };

    let response = await send();
    // Only worth retrying when we actually sent a token that could have expired.
    if (ownOrigin && response.status === 401) {
      this.auth.invalidate();
      response = await send();
    }
    return response;
  }

  /** Perform a request, re-authenticating once if the token has expired. */
  private async request(
    path: string,
    init: RequestInit,
    params?: Params,
  ): Promise<Response> {
    return this.sendWithRetry(this.buildUrl(path, params), init);
  }

  private async parse(response: Response): Promise<unknown> {
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private async unwrap<T>(response: Response): Promise<T> {
    const body = await this.parse(response);
    if (!response.ok) throw describeHttpError(response.status, body);
    return body as T;
  }

  async get<T>(path: string, params?: Params): Promise<T> {
    return this.unwrap<T>(await this.request(path, { method: "GET" }, params));
  }

  async list<T>(path: string, params?: Params): Promise<ListResult<T>> {
    const response = await this.request(path, { method: "GET" }, params);
    const items = await this.unwrap<T[]>(response);
    const total = Number(response.headers.get("x-pagination-count") ?? items.length);
    const page = Number(response.headers.get("x-pagination-current") ?? 1);
    // Taiga states outright whether another page exists. Trust that whenever
    // it says the response was paginated: the arithmetic below has no page
    // size to work with when the caller omitted `page_size`, and then reads a
    // short final page as "there is more".
    if (response.headers.get("x-paginated") === "true") {
      const next = response.headers.get("x-pagination-next");
      return { items, total, page, hasMore: Boolean(next) };
    }
    const pageSize = Number(params?.page_size ?? 0) || items.length;
    const consumed = (page - 1) * pageSize + items.length;
    return { items, total, page, hasMore: items.length > 0 && consumed < total };
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.unwrap<T>(
      await this.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  /**
   * Taiga uses optimistic locking: PATCH needs the object's current version.
   * Read it here so callers never have to think about it.
   */
  async patch<T>(
    path: string,
    id: number,
    changes: Record<string, unknown>,
  ): Promise<T> {
    const current = await this.get<{ version: number }>(`${path}/${id}`);
    const response = await this.request(`${path}/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...changes, version: current.version }),
    });

    if (response.status === 400) {
      const body = await this.parse(response);
      const hasVersionError =
        body !== null &&
        typeof body === "object" &&
        "version" in (body as Record<string, unknown>);
      if (hasVersionError) {
        throw new TaigaError(
          `This item changed in Taiga while we were editing it.`,
          { status: 400, hint: "Re-read the item and reapply the change." },
        );
      }
      throw describeHttpError(400, body);
    }
    return this.unwrap<T>(response);
  }

  async remove(path: string, id: number): Promise<void> {
    const response = await this.request(`${path}/${id}`, { method: "DELETE" });
    if (!response.ok && response.status !== 204) {
      throw describeHttpError(response.status, await this.parse(response));
    }
  }

  async postForm<T>(path: string, form: FormData): Promise<T> {
    return this.unwrap<T>(
      await this.request(path, { method: "POST", body: form }),
    );
  }

  async getBinary(url: string): Promise<{ data: Buffer; contentType: string }> {
    const response = await this.sendWithRetry(url, { method: "GET" }, true);
    if (!response.ok) {
      throw describeHttpError(response.status, await response.text());
    }
    return {
      data: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }
}
