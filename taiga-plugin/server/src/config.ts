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
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        `Set them in your Claude Code settings before using the Taiga plugin.`,
    );
  }

  const defaultProject = env.TAIGA_PROJECT?.trim() || undefined;
  return { url, username, password, defaultProject };
}
