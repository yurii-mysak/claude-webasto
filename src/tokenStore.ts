import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

export interface TokenStore {
  getToken(secretName: string): Promise<string>;
  invalidate(secretName: string): void;
}

export function createTokenStore(client: SecretsManagerClient): TokenStore {
  const cache = new Map<string, string>();

  return {
    async getToken(secretName: string): Promise<string> {
      const cached = cache.get(secretName);
      if (cached) return cached;

      const response = await client.send(
        new GetSecretValueCommand({ SecretId: secretName }),
      );

      if (!response.SecretString) {
        throw new Error(`Secret string is empty: ${secretName}`);
      }

      const parsed = JSON.parse(response.SecretString) as {
        CLAUDE_CODE_OAUTH_TOKEN?: string;
      };
      const token = parsed.CLAUDE_CODE_OAUTH_TOKEN;
      if (!token) {
        throw new Error(`CLAUDE_CODE_OAUTH_TOKEN not found in secret: ${secretName}`);
      }

      cache.set(secretName, token);
      return token;
    },

    invalidate(secretName: string): void {
      cache.delete(secretName);
    },
  };
}
