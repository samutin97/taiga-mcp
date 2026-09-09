import { TaigaError } from "./errors.js";

export interface TaigaConfig {
  url: string;
  username: string;
  password: string;
  defaultProject?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TaigaConfig {
  const url = (env.TAIGA_URL ?? "").trim().replace(/\/+$/, "");
  const username = (env.TAIGA_USERNAME ?? "").trim();
  const password = env.TAIGA_PASSWORD ?? "";

  const missing = [
    !url && "TAIGA_URL",
    !username && "TAIGA_USERNAME",
    !password && "TAIGA_PASSWORD",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new TaigaError(
      `The Taiga plugin is not configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set.`,
      {
        hint: "Set them in your Claude Code settings, then retry. TAIGA_URL is the instance address without /api/v1.",
      },
    );
  }

  const defaultProject = env.TAIGA_PROJECT?.trim() || undefined;
  return { url, username, password, defaultProject };
}
