import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TaigaError } from "./errors.js";

export interface TaigaConfig {
  url: string;
  username: string;
  password: string;
  defaultProject?: string;
}

type Key = "URL" | "USERNAME" | "PASSWORD" | "PROJECT";
const KEYS: Key[] = ["URL", "USERNAME", "PASSWORD", "PROJECT"];
const FILE_KEYS: Record<Key, string> = { URL: "url", USERNAME: "username", PASSWORD: "password", PROJECT: "project" };

/** A value the host failed to substitute (e.g. "${user_config.taiga_project}") is no value. */
function clean(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return /^\$\{.*\}$/.test(trimmed) ? "" : trimmed;
}

function fromFile(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const dir = env.CLAUDE_PLUGIN_DATA;
  if (!dir) return {};
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Three sources, first non-empty wins per key:
 *   1. TAIGA_<KEY>                      — plain environment / mcpServers.env
 *   2. CLAUDE_PLUGIN_OPTION_TAIGA_<KEY> — exported by Claude Code from userConfig
 *   3. ${CLAUDE_PLUGIN_DATA}/config.json — {url, username, password, project}
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): TaigaConfig {
  const file = fromFile(env);
  const pick = (key: Key) =>
    clean(env[`TAIGA_${key}`]) ||
    clean(env[`CLAUDE_PLUGIN_OPTION_TAIGA_${key}`]) ||
    clean(file[FILE_KEYS[key]]);

  const values = Object.fromEntries(KEYS.map((k) => [k, pick(k)])) as Record<Key, string>;
  const url = values.URL.replace(/\/+$/, "");
  const missing = (["URL", "USERNAME", "PASSWORD"] as Key[])
    .filter((k) => !values[k])
    .map((k) => `TAIGA_${k}`);

  if (missing.length > 0) {
    throw new TaigaError(
      `The Taiga plugin is not configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set.`,
      {
        hint: "Run /plugin, open the taiga plugin and fill in its settings (address, login, password), " +
          "or set TAIGA_URL, TAIGA_USERNAME and TAIGA_PASSWORD in the environment. " +
          "TAIGA_URL is the instance address without /api/v1.",
      },
    );
  }

  return { url, username: values.USERNAME, password: values.PASSWORD, defaultProject: values.PROJECT || undefined };
}
