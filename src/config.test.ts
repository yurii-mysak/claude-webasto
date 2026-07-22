import { describe, it, expect } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("applies defaults when env is empty", () => {
    const c = loadConfig({});
    expect(c.secretNamePrefix).toBe("claude-webasto/prod/token");
    expect(c.model).toBe("claude-haiku-4-5-20251001");
    expect(c.maxTokens).toBe(64);
    expect(c.alertTopicArn).toBeUndefined();
    expect(c.region).toBe("eu-north-1");
    expect(c.warmupMessage).toMatch(/Warmed up/);
  });

  it("reads overrides from env", () => {
    const c = loadConfig({
      SECRET_NAME_PREFIX: "custom/prefix",
      WARMUP_MESSAGE: "hi",
      MODEL: "claude-x",
      MAX_TOKENS: "128",
      ALERT_TOPIC_ARN: "arn:aws:sns:eu-north-1:1:topic",
      AWS_REGION: "us-east-1",
    });
    expect(c).toEqual({
      secretNamePrefix: "custom/prefix",
      warmupMessage: "hi",
      model: "claude-x",
      maxTokens: 128,
      alertTopicArn: "arn:aws:sns:eu-north-1:1:topic",
      region: "us-east-1",
    });
  });

  it("throws on invalid MAX_TOKENS", () => {
    expect(() => loadConfig({ MAX_TOKENS: "0" })).toThrow(/Invalid MAX_TOKENS/);
    expect(() => loadConfig({ MAX_TOKENS: "-5" })).toThrow(/Invalid MAX_TOKENS/);
    expect(() => loadConfig({ MAX_TOKENS: "abc" })).toThrow(/Invalid MAX_TOKENS/);
    expect(() => loadConfig({ MAX_TOKENS: "128notanumber" })).toThrow(/Invalid MAX_TOKENS/);
    expect(() => loadConfig({ MAX_TOKENS: "64.9" })).toThrow(/Invalid MAX_TOKENS/);
  });
});
