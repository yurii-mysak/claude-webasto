import { describe, it, expect, vi } from "vitest";
import { createAlerter } from "./alerter";
import type { SNSClient } from "@aws-sdk/client-sns";

function fakeClient(send: ReturnType<typeof vi.fn>): SNSClient {
  return { send } as unknown as SNSClient;
}

const details = {
  tokenId: "alice",
  error: "boom",
  timestamp: "2026-07-22T06:00:00.000Z",
  region: "eu-north-1",
};

describe("createAlerter", () => {
  it("publishes to SNS when a topic ARN is set", async () => {
    const send = vi.fn().mockResolvedValue({});
    const alerter = createAlerter(fakeClient(send), "arn:aws:sns:eu-north-1:1:t");
    await alerter.publishFailure(details);
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0];
    expect(command.input.TopicArn).toBe("arn:aws:sns:eu-north-1:1:t");
    expect(command.input.Message).toContain("alice");
    expect(command.input.Message).toContain("boom");
  });

  it("no-ops (no publish) when the topic ARN is unset", async () => {
    const send = vi.fn();
    const alerter = createAlerter(fakeClient(send), undefined);
    await alerter.publishFailure(details);
    expect(send).not.toHaveBeenCalled();
  });
});
