export interface WarmupConfig {
  secretNamePrefix: string;
  warmupMessage: string;
  model: string;
  maxTokens: number;
  alertTopicArn: string | undefined;
  region: string;
}

const DEFAULT_MESSAGE =
  "Hello! This is an automated warm-up message to reset my Claude Code rate limit window. Please just say 'Warmed up!' in response.";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WarmupConfig {
  const maxTokensRaw = env.MAX_TOKENS ?? "64";
  const maxTokens = Number(maxTokensRaw.trim());
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(`Invalid MAX_TOKENS: ${maxTokensRaw}`);
  }

  return {
    secretNamePrefix: env.SECRET_NAME_PREFIX ?? "claude-webasto/prod/token",
    warmupMessage: env.WARMUP_MESSAGE ?? DEFAULT_MESSAGE,
    model: env.MODEL ?? "claude-haiku-4-5-20251001",
    maxTokens,
    alertTopicArn: env.ALERT_TOPIC_ARN,
    region: env.AWS_REGION ?? "eu-north-1",
  };
}
