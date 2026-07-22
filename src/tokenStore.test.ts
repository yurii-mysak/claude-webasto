import { describe, it, expect, vi } from "vitest";
import { createTokenStore } from "./tokenStore";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

function fakeClient(send: ReturnType<typeof vi.fn>): SecretsManagerClient {
  return { send } as unknown as SecretsManagerClient;
}

function secretOf(token: string): { SecretString: string } {
  return { SecretString: JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: token }) };
}

describe("createTokenStore", () => {
  it("fetches and parses a token", async () => {
    const send = vi.fn().mockResolvedValue(secretOf("tok-a"));
    const store = createTokenStore(fakeClient(send));
    await expect(store.getToken("s/a")).resolves.toBe("tok-a");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("caches by secret name (no second AWS call)", async () => {
    const send = vi.fn().mockResolvedValue(secretOf("tok-a"));
    const store = createTokenStore(fakeClient(send));
    await store.getToken("s/a");
    await store.getToken("s/a");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("caches different secret names independently", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(secretOf("tok-a"))
      .mockResolvedValueOnce(secretOf("tok-b"));
    const store = createTokenStore(fakeClient(send));
    await expect(store.getToken("s/a")).resolves.toBe("tok-a");
    await expect(store.getToken("s/b")).resolves.toBe("tok-b");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("invalidate removes only the named entry", async () => {
    const send = vi.fn().mockResolvedValue(secretOf("tok-a"));
    const store = createTokenStore(fakeClient(send));
    await store.getToken("s/a");
    store.invalidate("s/a");
    await store.getToken("s/a");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("invalidate only affects the named entry, leaving other cached entries untouched", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(secretOf("tok-a"))
      .mockResolvedValueOnce(secretOf("tok-b"))
      .mockResolvedValueOnce(secretOf("tok-a2"));
    const store = createTokenStore(fakeClient(send));

    await expect(store.getToken("s/a")).resolves.toBe("tok-a");
    await expect(store.getToken("s/b")).resolves.toBe("tok-b");
    expect(send).toHaveBeenCalledTimes(2);

    store.invalidate("s/a");

    await expect(store.getToken("s/a")).resolves.toBe("tok-a2");
    expect(send).toHaveBeenCalledTimes(3);

    await expect(store.getToken("s/b")).resolves.toBe("tok-b");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("throws when SecretString is empty", async () => {
    const send = vi.fn().mockResolvedValue({ SecretString: "" });
    const store = createTokenStore(fakeClient(send));
    await expect(store.getToken("s/a")).rejects.toThrow(/Secret string is empty/);
  });

  it("throws when the token key is missing", async () => {
    const send = vi.fn().mockResolvedValue({ SecretString: JSON.stringify({ other: 1 }) });
    const store = createTokenStore(fakeClient(send));
    await expect(store.getToken("s/a")).rejects.toThrow(/not found in secret/);
  });

  it("rejects when SecretString is malformed JSON", async () => {
    const send = vi.fn().mockResolvedValue({ SecretString: "not json{" });
    const store = createTokenStore(fakeClient(send));
    await expect(store.getToken("s/a")).rejects.toThrow();
  });
});
