import type { TaigaConfig } from "./config.js";
import { TaigaError, describeHttpError } from "./errors.js";

export class TaigaAuth {
  private token?: string;
  private pending?: Promise<string>;
  private authenticatedUserId?: number;

  constructor(
    private readonly config: TaigaConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get userId(): number | undefined {
    return this.authenticatedUserId;
  }

  invalidate(): void {
    this.token = undefined;
    this.pending = undefined;
  }

  async getToken(): Promise<string> {
    if (this.token) return this.token;
    this.pending ??= this.login().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async login(): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.url}/api/v1/auth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "normal",
          username: this.config.username,
          password: this.config.password,
        }),
      });
    } catch (cause) {
      throw new TaigaError(`Cannot reach Taiga at ${this.config.url}.`, {
        hint: "Check TAIGA_URL and that the instance is running.",
      });
    }

    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      // Login failures are always a credentials problem — say so explicitly
      // rather than passing Taiga's terse message through.
      throw new TaigaError(`Taiga rejected the login for user "${this.config.username}".`, {
        status: response.status,
        hint: "Check TAIGA_USERNAME and TAIGA_PASSWORD.",
      });
    }

    const record = (body ?? {}) as Record<string, unknown>;
    const token = record.auth_token;
    if (typeof token !== "string") {
      throw describeHttpError(response.status, body);
    }

    this.token = token;
    this.authenticatedUserId =
      typeof record.id === "number" ? record.id : undefined;
    return token;
  }
}
