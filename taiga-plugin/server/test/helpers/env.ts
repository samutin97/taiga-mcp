/**
 * Point tests at the local Taiga stand unless the caller has already set its
 * own values. See infra/README.md for how the stand is created.
 */
export function ensureStandEnv(): void {
  process.env.TAIGA_URL ??= "http://localhost:9000";
  process.env.TAIGA_USERNAME ??= "admin";
  process.env.TAIGA_PASSWORD ??= "TaigaLocal2026!";
}
