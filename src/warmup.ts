import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import type { ScheduledHandler } from "aws-lambda";

// Cache OAuth token across warm Lambda invocations
let cachedToken: string | null = null;

const secretsClient = new SecretsManagerClient({});

// Config from environment
const SECRET_NAME = process.env.AWS_SECRET_NAME ?? "claude-webasto/prod/token";
const WARMUP_MESSAGE =
  process.env.WARMUP_MESSAGE ??
  "Hello! This is an automated warm-up message to reset my Claude Code rate limit window. Please just say 'Warmed up!' in response.";
const MODEL = process.env.MODEL ?? "claude-haiku-4-5-20251001";
const MAX_TOKENS = (() => {
  const parsed = parseInt(process.env.MAX_TOKENS ?? "64", 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid MAX_TOKENS: ${process.env.MAX_TOKENS}`);
  }
  return parsed;
})();

async function getOAuthToken(): Promise<string> {
  if (cachedToken) return cachedToken;

  const command = new GetSecretValueCommand({ SecretId: SECRET_NAME });
  const response = await secretsClient.send(command);

  if (!response.SecretString) {
    throw new Error("Secret string is empty");
  }

  const secret = JSON.parse(response.SecretString) as {
    CLAUDE_CODE_OAUTH_TOKEN: string;
  };
  cachedToken = secret.CLAUDE_CODE_OAUTH_TOKEN;

  if (!cachedToken) {
    throw new Error("CLAUDE_CODE_OAUTH_TOKEN not found in secret");
  }

  return cachedToken;
}

export const handler: ScheduledHandler = async () => {
  const timestamp = new Date().toISOString();

  try {
    const token = await getOAuthToken();

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(25_000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: WARMUP_MESSAGE }],
      }),
    });

    const data = (await response.json()) as Record<string, unknown>;

    const logEntry = {
      timestamp,
      status: response.status,
      model: MODEL,
      responseExcerpt: JSON.stringify(data).slice(0, 200),
    };

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        cachedToken = null;
      }
      console.error(JSON.stringify({ ...logEntry, error: "API request failed" }));
      throw new Error(`API request failed with status ${response.status}`);
    }

    console.log(JSON.stringify({ ...logEntry, success: true }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ timestamp, error: message, model: MODEL }));
    cachedToken = null;
    throw error;
  }
};
