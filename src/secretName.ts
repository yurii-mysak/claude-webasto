const TOKEN_ID_PATTERN = /^[a-z0-9-]+$/;

export function resolveSecretName(prefix: string, tokenId?: string): string {
  if (tokenId === undefined) {
    return prefix;
  }
  if (!TOKEN_ID_PATTERN.test(tokenId)) {
    throw new Error(`Invalid tokenId: ${JSON.stringify(tokenId)}`);
  }
  return `${prefix}/${tokenId}`;
}
