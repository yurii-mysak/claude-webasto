import { describe, it, expect, vi } from "vitest";
import { createHandler, type HandlerDeps } from "./warmup";
import type { WarmupConfig } from "./config";

const config: WarmupConfig = {
  secretNamePrefix: "claude-webasto/prod/token",
  warmupMessage: "hi",
  model: "claude-haiku-4-5-20251001",
  maxTokens: 64,
  alertTopicArn: "arn:t",
  region: "eu-north-1",
};

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    config,
    tokenStore: {
      getToken: vi.fn().mockResolvedValue("tok"),
      invalidate: vi.fn(),
    },
    alerter: { publishFailure: vi.fn().mockResolvedValue(undefined) },
    fetchFn: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }),
    now: () => new Date("2026-07-22T06:00:00.000Z"),
    ...overrides,
  };
}

describe("createHandler", () => {
  it("warms the per-token secret named by the event", async () => {
    const deps = makeDeps();
    await createHandler(deps)({ tokenId: "alice" });
    expect(deps.tokenStore.getToken).toHaveBeenCalledWith("claude-webasto/prod/token/alice");
    expect(deps.alerter.publishFailure).not.toHaveBeenCalled();
  });

  it("falls back to the legacy secret when tokenId is absent", async () => {
    const deps = makeDeps();
    await createHandler(deps)({});
    expect(deps.tokenStore.getToken).toHaveBeenCalledWith("claude-webasto/prod/token");
  });

  it("invalidates the token and alerts on 401, then rethrows", async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    });
    await expect(createHandler(deps)({ tokenId: "alice" })).rejects.toThrow(/status 401/);
    expect(deps.tokenStore.invalidate).toHaveBeenCalledWith("claude-webasto/prod/token/alice");
    expect(deps.alerter.publishFailure).toHaveBeenCalledTimes(1);
    expect(deps.alerter.publishFailure).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: "alice", region: "eu-north-1" }),
    );
  });

  it("alerts but does NOT invalidate on 500", async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    });
    await expect(createHandler(deps)({ tokenId: "alice" })).rejects.toThrow(/status 500/);
    expect(deps.tokenStore.invalidate).not.toHaveBeenCalled();
    expect(deps.alerter.publishFailure).toHaveBeenCalledTimes(1);
  });

  it("alerts and rethrows when fetch itself throws", async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockRejectedValue(new Error("network down")),
    });
    await expect(createHandler(deps)({ tokenId: "alice" })).rejects.toThrow(/network down/);
    expect(deps.alerter.publishFailure).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: "alice", error: "network down" }),
    );
  });

  it("alerts with tokenId 'default' when the event has no tokenId", async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockRejectedValue(new Error("boom")),
    });
    await expect(createHandler(deps)({})).rejects.toThrow(/boom/);
    expect(deps.alerter.publishFailure).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: "default" }),
    );
  });

  it("rethrows the original error, not the SNS error, when publishFailure itself rejects", async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockRejectedValue(new Error("network down")),
      alerter: { publishFailure: vi.fn().mockRejectedValue(new Error("sns down")) },
    });
    await expect(createHandler(deps)({ tokenId: "alice" })).rejects.toThrow(/network down/);
  });
});
