import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

const ENV = { TAIGA_URL: "https://t.example/", TAIGA_USERNAME: "dima", TAIGA_PASSWORD: "pw" };

describe("loadConfig", () => {
  it("reads TAIGA_* and strips the trailing slash", () => {
    expect(loadConfig(ENV)).toEqual({ url: "https://t.example", username: "dima", password: "pw", defaultProject: undefined });
  });

  it("falls back to CLAUDE_PLUGIN_OPTION_TAIGA_* per key", () => {
    const cfg = loadConfig({
      TAIGA_URL: "https://t.example",
      CLAUDE_PLUGIN_OPTION_TAIGA_USERNAME: "dima",
      CLAUDE_PLUGIN_OPTION_TAIGA_PASSWORD: "pw",
      CLAUDE_PLUGIN_OPTION_TAIGA_PROJECT: "sandbox",
    });
    expect(cfg).toEqual({ url: "https://t.example", username: "dima", password: "pw", defaultProject: "sandbox" });
  });

  it("falls back to CLAUDE_PLUGIN_DATA/config.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "taiga-cfg-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ url: "https://f.example", username: "f", password: "fp", project: "p" }));
    expect(loadConfig({ CLAUDE_PLUGIN_DATA: dir })).toEqual({ url: "https://f.example", username: "f", password: "fp", defaultProject: "p" });
  });

  it("prefers env over option over file, key by key", () => {
    const dir = mkdtempSync(join(tmpdir(), "taiga-cfg-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ url: "https://file", username: "file", password: "file" }));
    const cfg = loadConfig({
      TAIGA_URL: "https://env",
      CLAUDE_PLUGIN_OPTION_TAIGA_USERNAME: "option",
      CLAUDE_PLUGIN_DATA: dir,
    });
    expect(cfg).toEqual({ url: "https://env", username: "option", password: "file", defaultProject: undefined });
  });

  it("treats an unsubstituted ${...} placeholder as unset", () => {
    const cfg = loadConfig({ ...ENV, TAIGA_PROJECT: "${user_config.taiga_project}" });
    expect(cfg.defaultProject).toBeUndefined();
    expect(() => loadConfig({ ...ENV, TAIGA_PASSWORD: "${user_config.taiga_password}" })).toThrow(/TAIGA_PASSWORD/);
  });

  it("ignores a missing or malformed config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "taiga-cfg-"));
    writeFileSync(join(dir, "config.json"), "{not json");
    expect(() => loadConfig({ CLAUDE_PLUGIN_DATA: dir })).toThrow(/TAIGA_URL, TAIGA_USERNAME, TAIGA_PASSWORD/);
  });

  it("names the plugin settings in its hint", () => {
    try {
      loadConfig({});
      throw new Error("did not throw");
    } catch (e) {
      expect(String((e as { hint?: string }).hint)).toMatch(/\/plugin/);
    }
  });
});
