import { z } from "zod";
import { loadConfig, type TaigaConfig } from "./config.js";
import { TaigaAuth } from "./auth.js";
import { TaigaClient } from "./client.js";
import { SchemaCache } from "./schema-cache.js";
import type { FieldMode } from "./projections.js";

export interface ToolContext {
  config: TaigaConfig;
  auth: TaigaAuth;
  client: TaigaClient;
  cache: SchemaCache;
}

/**
 * Configuration is resolved on first use, not at construction, so an
 * unconfigured plugin still completes the MCP handshake and can report the
 * problem through the normal guarded tool-error path instead of dying first.
 */
class LazyToolContext implements ToolContext {
  private built?: {
    config: TaigaConfig;
    auth: TaigaAuth;
    client: TaigaClient;
    cache: SchemaCache;
  };

  constructor(private readonly override?: TaigaConfig) {}

  private build() {
    if (!this.built) {
      const config = this.override ?? loadConfig();
      const auth = new TaigaAuth(config);
      const client = new TaigaClient(config, auth);
      const cache = new SchemaCache(client, { defaultProject: config.defaultProject });
      this.built = { config, auth, client, cache };
    }
    return this.built;
  }

  get config(): TaigaConfig {
    return this.build().config;
  }
  get auth(): TaigaAuth {
    return this.build().auth;
  }
  get client(): TaigaClient {
    return this.build().client;
  }
  get cache(): SchemaCache {
    return this.build().cache;
  }
}

export function createContext(config?: TaigaConfig): ToolContext {
  return new LazyToolContext(config);
}

export const FIELDS_SCHEMA = z
  .union([z.literal("slim"), z.literal("full"), z.array(z.string())])
  .optional()
  .describe(
    "How much detail to return: 'slim' (default, ~10 key fields), " +
      "'full' (every field Taiga returns — expensive), or an explicit list of field names.",
  );

export function asFieldMode(value: unknown): FieldMode {
  if (value === "full") return "full";
  if (Array.isArray(value)) return value as string[];
  return "slim";
}

export function ok(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 1) },
    ],
  };
}

/** Wrap a tool handler so failures come back as readable text, not stack traces. */
export function guard<T extends Record<string, unknown>>(
  handler: (args: T) => Promise<ReturnType<typeof ok>>,
) {
  return async (args: T) => {
    try {
      return await handler(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text" as const, text: message }],
      };
    }
  };
}
