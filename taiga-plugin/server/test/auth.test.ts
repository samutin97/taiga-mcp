import { describe, it, expect, vi } from "vitest";
import { TaigaAuth } from "../src/auth.js";

const config = {
  url: "http://taiga.test",
  username: "admin",
  password: "s3cret",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TaigaAuth", () => {
  it("logs in once and caches the token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ auth_token: "tok-1", id: 5 }));
    const auth = new TaigaAuth(config, fetchImpl as unknown as typeof fetch);

    expect(await auth.getToken()).toBe("tok-1");
    expect(await auth.getToken()).toBe("tok-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://taiga.test/api/v1/auth");
    expect(JSON.parse(init.body)).toEqual({
      type: "normal",
      username: "admin",
      password: "s3cret",
    });
  });

  it("logs in again after invalidate()", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ auth_token: "tok-1", id: 5 }))
      .mockResolvedValueOnce(jsonResponse({ auth_token: "tok-2", id: 5 }));
    const auth = new TaigaAuth(config, fetchImpl as unknown as typeof fetch);

    expect(await auth.getToken()).toBe("tok-1");
    auth.invalidate();
    expect(await auth.getToken()).toBe("tok-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never leaks the password in the error message", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ _error_message: "Invalid credentials" }, 400),
      );
    const auth = new TaigaAuth(config, fetchImpl as unknown as typeof fetch);

    await expect(auth.getToken()).rejects.toThrow(/TAIGA_USERNAME/);
    await expect(auth.getToken()).rejects.not.toThrow(/s3cret/);
  });

  it("exposes the authenticated user id", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ auth_token: "tok-1", id: 42 }));
    const auth = new TaigaAuth(config, fetchImpl as unknown as typeof fetch);
    await auth.getToken();
    expect(auth.userId).toBe(42);
  });

  it("login returning HTTP 503 produces error that does not mention credentials", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({}, 503));
    const auth = new TaigaAuth(config, fetchImpl as unknown as typeof fetch);

    await expect(auth.getToken()).rejects.toThrow(/503/);
    await expect(auth.getToken()).rejects.not.toThrow(/TAIGA_USERNAME/);
    await expect(auth.getToken()).rejects.not.toThrow(/TAIGA_PASSWORD/);
  });
});
