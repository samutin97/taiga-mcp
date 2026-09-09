import type { TaigaConfig } from "./config.js";
import type { TaigaAuth } from "./auth.js";
import { TaigaError, describeHttpError, extractMessage } from "./errors.js";

export type Params = Record<string, string | number | boolean | undefined>;

export interface ListResult<T> {
  items: T[];
  total: number;
  page: number;
  hasMore: boolean;
}

export class TaigaClient {
  private readonly base: string;

  constructor(
    config: TaigaConfig,
    private readonly auth: TaigaAuth,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `${config.url}/api/v1`;
  }

  private buildUrl(path: string, params?: Params): string {
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** Perform a request, re-authenticating once if the token has expired. */
  private async request(
    path: string,
    init: RequestInit,
    params?: Params,
  ): Promise<Response> {
    const url = this.buildUrl(path, params);

    const send = async (): Promise<Response> => {
      const token = await this.auth.getToken();
      const headers = { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` };
      try {
        return await this.fetchImpl(url, { ...init, headers });
      } catch {
        throw new TaigaError(`Cannot reach Taiga at ${url}.`, {
          hint: "Check TAIGA_URL and that the instance is running.",
        });
      }
    };

    let response = await send();
    if (response.status === 401) {
      this.auth.invalidate();
      response = await send();
    }
    return response;
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
    return { items, total, page, hasMore: page * items.length < total };
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
      const message = extractMessage(body) ?? "";
      if (/version/i.test(message)) {
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
    const token = await this.auth.getToken();
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw describeHttpError(response.status, await response.text());
    }
    return {
      data: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }
}
