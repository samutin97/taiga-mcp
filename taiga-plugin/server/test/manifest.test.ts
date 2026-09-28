import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN = join(import.meta.dirname, "../../.claude-plugin/plugin.json");
const MARKET = join(import.meta.dirname, "../../../.claude-plugin/marketplace.json");

describe("plugin manifest", () => {
  const manifest = JSON.parse(readFileSync(PLUGIN, "utf8"));

  it("declares schema, author and version 0.4.0", () => {
    expect(manifest.$schema).toMatch(/plugin-manifest\.json$/);
    expect(manifest.author.name).toBeTruthy();
    expect(manifest.version).toBe("0.4.0");
  });

  it("asks for the four settings and marks the password sensitive", () => {
    expect(Object.keys(manifest.userConfig).sort()).toEqual(["taiga_password", "taiga_project", "taiga_url", "taiga_username"]);
    expect(manifest.userConfig.taiga_password.sensitive).toBe(true);
    expect(manifest.userConfig.taiga_project.required).toBeUndefined();
  });

  it("wires every setting into the server environment", () => {
    const env = manifest.mcpServers.taiga.env;
    expect(env).toEqual({
      TAIGA_URL: "${user_config.taiga_url}",
      TAIGA_USERNAME: "${user_config.taiga_username}",
      TAIGA_PASSWORD: "${user_config.taiga_password}",
      TAIGA_PROJECT: "${user_config.taiga_project}",
    });
  });
});

describe("local marketplace", () => {
  it("points at the plugin directory", () => {
    const market = JSON.parse(readFileSync(MARKET, "utf8"));
    expect(market.name).toBe("taiga-local");
    expect(market.plugins).toEqual([expect.objectContaining({ name: "taiga", source: "./taiga-plugin" })]);
  });
});
