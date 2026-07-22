import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

export interface FailureDetails {
  tokenId: string;
  error: string;
  timestamp: string;
  region: string;
}

export interface Alerter {
  publishFailure(details: FailureDetails): Promise<void>;
}

export function createAlerter(
  client: SNSClient,
  topicArn: string | undefined,
): Alerter {
  return {
    async publishFailure(details: FailureDetails): Promise<void> {
      if (!topicArn) {
        console.warn(
          JSON.stringify({ warn: "ALERT_TOPIC_ARN unset; skipping SNS publish", ...details }),
        );
        return;
      }

      await client.send(
        new PublishCommand({
          TopicArn: topicArn,
          Subject: `Claude warmup failed: ${details.tokenId}`.slice(0, 100),
          Message: JSON.stringify(details, null, 2),
        }),
      );
    },
  };
}
