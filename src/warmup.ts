import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SNSClient } from "@aws-sdk/client-sns";
import { loadConfig, type WarmupConfig } from "./config";
import { resolveSecretName } from "./secretName";
import { createTokenStore, type TokenStore } from "./tokenStore";
import { createAlerter, type Alerter } from "./alerter";

export interface WarmupEvent {
  tokenId?: string;
}

export interface HandlerDeps {
  config: WarmupConfig;
  tokenStore: TokenStore;
  alerter: Alerter;
  fetchFn: typeof fetch;
  now: () => Date;
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const FETCH_TIMEOUT_MS = 25_000;
const UNAUTHORIZED_STATUSES = new Set([401, 403]);

export function createHandler(
  deps: HandlerDeps,
): (event: WarmupEvent) => Promise<void> {
  const { config, tokenStore, alerter, fetchFn, now } = deps;

  return async (event: WarmupEvent): Promise<void> => {
    const tokenId = event?.tokenId ?? "default";
    const timestamp = now().toISOString();

    try {
      const secretName = resolveSecretName(config.secretNamePrefix, event?.tokenId);
      const token = await tokenStore.getToken(secretName);

      const response = await fetchFn(ANTHROPIC_URL, {
        method: "POST",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.maxTokens,
          messages: [{ role: "user", content: config.warmupMessage }],
        }),
      });

      const data = (await response.json()) as Record<string, unknown>;
      const logEntry = {
        timestamp,
        tokenId,
        status: response.status,
        model: config.model,
        responseExcerpt: JSON.stringify(data).slice(0, 200),
      };

      if (!response.ok) {
        if (UNAUTHORIZED_STATUSES.has(response.status)) {
          tokenStore.invalidate(secretName);
        }
        console.error(JSON.stringify({ ...logEntry, error: "API request failed" }));
        throw new Error(`API request failed with status ${response.status}`);
      }

      console.log(JSON.stringify({ ...logEntry, success: true }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({ timestamp, tokenId, error: message, model: config.model }),
      );
      try {
        await alerter.publishFailure({
          tokenId,
          error: message,
          timestamp,
          region: config.region,
        });
      } catch (alertError) {
        const alertMessage =
          alertError instanceof Error ? alertError.message : String(alertError);
        console.error(
          JSON.stringify({
            timestamp,
            tokenId,
            error: `SNS publish failed: ${alertMessage}`,
            model: config.model,
          }),
        );
      }
      throw error;
    }
  };
}

function defaultDeps(): HandlerDeps {
  const config = loadConfig();
  return {
    config,
    tokenStore: createTokenStore(new SecretsManagerClient({})),
    alerter: createAlerter(new SNSClient({}), config.alertTopicArn),
    fetchFn: fetch,
    now: () => new Date(),
  };
}

export const handler = createHandler(defaultDeps());
