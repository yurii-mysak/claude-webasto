# Multi-token Warmup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warm multiple Claude Code OAuth tokens, each on its own EventBridge schedule, from a single Lambda handler, with per-token failure alerts.

**Architecture:** One Lambda handler receives an `{ tokenId }` payload from each schedule, resolves it to a per-token Secrets Manager secret, warms it against the Anthropic API, and on failure publishes a detailed message to the existing SNS topic. The current single-file handler is refactored into small injectable units (`config`, `secretName`, `tokenStore`, `alerter`, `warmup`) so each has one responsibility and is unit-testable. No `tokenId` falls back to the legacy single-token secret (backward compatible).

**Tech Stack:** TypeScript (strict, ES2022, Node16 module resolution), AWS Lambda (nodejs22.x), Serverless Framework, AWS SDK v3 (`client-secrets-manager`, `client-sns` — bundled by the Lambda runtime, dev-only for build/types), Vitest for unit tests.

## Global Constraints

- TypeScript strict mode; 2-space indentation; ES2022 target; Node16 module resolution.
- **No runtime dependencies** shipped in the bundle — native `fetch`, AWS SDK v3 provided by the Lambda runtime. Vitest and `@aws-sdk/client-sns` are **devDependencies only**; the package `patterns` block already excludes `node_modules`.
- Relative imports are **extensionless** (project compiles as CommonJS — no `"type": "module"` in `package.json`).
- Structured **JSON** logging to stdout/stderr; every log line includes `tokenId` (literal `"default"` when absent).
- Secret shape unchanged: `{ "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-..." }`.
- Per-token secret name: `claude-webasto/prod/token/<id>`; legacy secret: `claude-webasto/prod/token`.
- `tokenId` validation regex: `^[a-z0-9-]+$`.
- Anthropic request unchanged: `POST https://api.anthropic.com/v1/messages`, headers `anthropic-version: 2023-06-01` and `anthropic-beta: claude-code-20250219,oauth-2025-04-20`, 25s fetch timeout.

---

## Task 1: Test tooling + `resolveSecretName`

**Files:**
- Modify: `package.json` (add devDeps + test scripts)
- Create: `vitest.config.ts`
- Modify: `tsconfig.json` (exclude test files from build)
- Create: `src/secretName.ts`
- Test: `src/secretName.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `resolveSecretName(prefix: string, tokenId?: string): string` — returns `prefix` when `tokenId` is `undefined`, `` `${prefix}/${tokenId}` `` for a valid id, and **throws** `Error` for any id not matching `^[a-z0-9-]+$` (including empty string).

- [ ] **Step 1: Add devDependencies and test scripts to `package.json`**

Set the `scripts` and `devDependencies` blocks to:

```json
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "deploy": "./scripts/deploy.sh",
    "remove": "./scripts/remove.sh"
  },
  "devDependencies": {
    "@aws-sdk/client-secrets-manager": "^3.1000.0",
    "@aws-sdk/client-sns": "^3.1000.0",
    "@types/aws-lambda": "^8",
    "@types/node": "^22",
    "@vitest/coverage-v8": "^2.1.0",
    "typescript": "^5.4.0",
    "vitest": "^2.1.0"
  }
```

Then install:

Run: `npm install`
Expected: exits 0; `node_modules/vitest` and `node_modules/@aws-sdk/client-sns` now exist.

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
```

- [ ] **Step 3: Exclude test files from the TypeScript build**

In `tsconfig.json`, add a top-level `"exclude"` key (sibling of `compilerOptions`) so `npm run build` never emits test files into `dist`:

```json
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts", "vitest.config.ts"]
```

- [ ] **Step 4: Write the failing test** — `src/secretName.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { resolveSecretName } from "./secretName";

const PREFIX = "claude-webasto/prod/token";

describe("resolveSecretName", () => {
  it("appends a valid tokenId to the prefix", () => {
    expect(resolveSecretName(PREFIX, "alice")).toBe(`${PREFIX}/alice`);
    expect(resolveSecretName(PREFIX, "bob-2")).toBe(`${PREFIX}/bob-2`);
  });

  it("returns the bare prefix when tokenId is undefined (legacy)", () => {
    expect(resolveSecretName(PREFIX)).toBe(PREFIX);
    expect(resolveSecretName(PREFIX, undefined)).toBe(PREFIX);
  });

  it("throws on an empty-string tokenId", () => {
    expect(() => resolveSecretName(PREFIX, "")).toThrow(/Invalid tokenId/);
  });

  it("throws on path-traversal, uppercase, and symbol ids", () => {
    for (const bad of ["../evil", "Alice", "a b", "a/b", "a_b", "a.b"]) {
      expect(() => resolveSecretName(PREFIX, bad)).toThrow(/Invalid tokenId/);
    }
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npm test -- src/secretName.test.ts`
Expected: FAIL — cannot resolve module `./secretName`.

- [ ] **Step 6: Write minimal implementation** — `src/secretName.ts`

```ts
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
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test -- src/secretName.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vitest.config.ts tsconfig.json src/secretName.ts src/secretName.test.ts
git commit -m "feat: add vitest + resolveSecretName for per-token secrets"
```

---

## Task 2: `loadConfig`

**Files:**
- Create: `src/config.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface WarmupConfig { secretNamePrefix: string; warmupMessage: string; model: string; maxTokens: number; alertTopicArn: string | undefined; region: string; }`
  - `loadConfig(env?: NodeJS.ProcessEnv): WarmupConfig` — defaults `env` to `process.env`; throws on non-numeric or `<= 0` `MAX_TOKENS`.

- [ ] **Step 1: Write the failing test** — `src/config.test.ts`

```ts
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
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/config.test.ts`
Expected: FAIL — cannot resolve module `./config`.

- [ ] **Step 3: Write minimal implementation** — `src/config.ts`

```ts
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
  const maxTokens = parseInt(maxTokensRaw, 10);
  if (Number.isNaN(maxTokens) || maxTokens <= 0) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: add loadConfig with SECRET_NAME_PREFIX and ALERT_TOPIC_ARN"
```

---

## Task 3: `tokenStore` (per-token cache)

**Files:**
- Create: `src/tokenStore.ts`
- Test: `src/tokenStore.test.ts`

**Interfaces:**
- Consumes: nothing (takes an injected `SecretsManagerClient`).
- Produces:
  - `interface TokenStore { getToken(secretName: string): Promise<string>; invalidate(secretName: string): void; }`
  - `createTokenStore(client: SecretsManagerClient): TokenStore` — caches tokens keyed by secret name; throws `Secret string is empty: <name>` when `SecretString` is falsy, a JSON parse error on malformed JSON, and `CLAUDE_CODE_OAUTH_TOKEN not found in secret: <name>` when the key is missing.

- [ ] **Step 1: Write the failing test** — `src/tokenStore.test.ts`

```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/tokenStore.test.ts`
Expected: FAIL — cannot resolve module `./tokenStore`.

- [ ] **Step 3: Write minimal implementation** — `src/tokenStore.ts`

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/tokenStore.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tokenStore.ts src/tokenStore.test.ts
git commit -m "feat: add per-token cache in tokenStore"
```

---

## Task 4: `alerter` (SNS failure detail)

**Files:**
- Create: `src/alerter.ts`
- Test: `src/alerter.test.ts`

**Interfaces:**
- Consumes: nothing (takes an injected `SNSClient` and topic ARN).
- Produces:
  - `interface FailureDetails { tokenId: string; error: string; timestamp: string; region: string; }`
  - `interface Alerter { publishFailure(details: FailureDetails): Promise<void>; }`
  - `createAlerter(client: SNSClient, topicArn: string | undefined): Alerter` — publishes a `PublishCommand` when `topicArn` is set; when unset, warn-logs and does **not** call `client.send`.

- [ ] **Step 1: Write the failing test** — `src/alerter.test.ts`

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/alerter.test.ts`
Expected: FAIL — cannot resolve module `./alerter`.

- [ ] **Step 3: Write minimal implementation** — `src/alerter.ts`

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/alerter.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/alerter.ts src/alerter.test.ts
git commit -m "feat: add SNS alerter for per-token failure detail"
```

---

## Task 5: `warmup` handler wiring

**Files:**
- Modify: `src/warmup.ts` (replace entire file)
- Test: `src/warmup.test.ts`

**Interfaces:**
- Consumes: `loadConfig`/`WarmupConfig` (Task 2), `resolveSecretName` (Task 1), `createTokenStore`/`TokenStore` (Task 3), `createAlerter`/`Alerter` (Task 4).
- Produces:
  - `interface WarmupEvent { tokenId?: string; }`
  - `interface HandlerDeps { config: WarmupConfig; tokenStore: TokenStore; alerter: Alerter; fetchFn: typeof fetch; now: () => Date; }`
  - `createHandler(deps: HandlerDeps): (event: WarmupEvent) => Promise<void>`
  - `export const handler` — the Lambda entrypoint (`dist/warmup.handler`), built from real dependencies.

- [ ] **Step 1: Write the failing test** — `src/warmup.test.ts`

```ts
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
    expect((deps.alerter.publishFailure as any).mock.calls[0][0]).toMatchObject({
      tokenId: "alice",
      region: "eu-north-1",
    });
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/warmup.test.ts`
Expected: FAIL — `createHandler` is not exported (old `warmup.ts` only exports `handler`).

- [ ] **Step 3: Replace `src/warmup.ts` entirely**

```ts
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
      await alerter.publishFailure({
        tokenId,
        error: message,
        timestamp,
        region: config.region,
      });
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/warmup.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full suite + build**

Run: `npm test`
Expected: PASS — all suites (secretName, config, tokenStore, alerter, warmup).

Run: `npm run build`
Expected: exits 0; `dist/warmup.js` emitted and `dist/*.test.js` **absent**.

- [ ] **Step 6: Commit**

```bash
git add src/warmup.ts src/warmup.test.ts
git commit -m "feat: wire multi-token warmup handler with injectable deps"
```

---

## Task 6: Serverless config — per-token schedules, env, IAM

**Files:**
- Modify: `serverless.yml`

**Interfaces:**
- Consumes: `handler` at `dist/warmup.handler`; env vars `SECRET_NAME_PREFIX`, `ALERT_TOPIC_ARN` (read by `loadConfig`); event payload `{ tokenId }` (read by the handler).
- Produces: deployed stack with one function, N schedules, SNS publish permission.

- [ ] **Step 1: Update the IAM `statements` block** to add SNS publish (keep the existing secrets + logs statements). Under `provider.iam.role.statements`, add:

```yaml
        - Effect: Allow
          Action:
            - sns:Publish
          Resource:
            - !Ref AlertTopic
```

- [ ] **Step 2: Replace the `provider.environment` block** — drop `AWS_SECRET_NAME`, add prefix + topic ARN:

```yaml
  environment:
    SECRET_NAME_PREFIX: claude-webasto/prod/token
    ALERT_TOPIC_ARN: !Ref AlertTopic
    WARMUP_MESSAGE: "Hello! This is an automated warm-up message to reset my Claude Code rate limit window. Please just say 'Warmed up!' in response."
    MODEL: claude-haiku-4-5-20251001
    MAX_TOKENS: '64'
```

- [ ] **Step 3: Replace the `functions.warmup.events` block** with one schedule per token (example: `alice`, `bob` — real deployments edit these):

```yaml
functions:
  warmup:
    handler: dist/warmup.handler
    description: Warm up Claude Code rate limit windows (multi-token)
    events:
      - schedule:
          rate: cron(0 6 * * ? *)
          enabled: true
          description: "alice - 8 AM Kyiv (UTC+2)"
          input:
            tokenId: alice
      - schedule:
          rate: cron(0 14 * * ? *)
          enabled: true
          description: "bob - own timezone"
          input:
            tokenId: bob
```

- [ ] **Step 4: Validate the config compiles (no deploy)**

Run: `npx serverless print`
Expected: exits 0; printed output shows two `schedule` events each with an `input.tokenId`, `SECRET_NAME_PREFIX` and `ALERT_TOPIC_ARN` under environment, and the `sns:Publish` statement. (If AWS credentials are required by your Serverless version and unavailable, `npx serverless package` is an equivalent offline check.)

- [ ] **Step 5: Commit**

```bash
git add serverless.yml
git commit -m "feat: per-token schedules, SECRET_NAME_PREFIX env, sns:Publish IAM"
```

---

## Task 7: `setup-secrets.sh` — per-token id argument

**Files:**
- Modify: `scripts/setup-secrets.sh`

**Interfaces:**
- Consumes: optional positional arg `$1` = token id.
- Produces: creates/updates secret `claude-webasto/prod/token` (no arg) or `claude-webasto/prod/token/<id>` (with a valid `^[a-z0-9-]+$` arg).

- [ ] **Step 1: Add token-id handling** — replace the fixed `SECRET_NAME="claude-webasto/prod/token"` line (currently line 41) with:

```bash
TOKEN_ID="${1:-}"
SECRET_BASE="claude-webasto/prod/token"

if [ -n "$TOKEN_ID" ]; then
    if ! echo "$TOKEN_ID" | grep -Eq '^[a-z0-9-]+$'; then
        echo -e "${RED}Error: token id must match ^[a-z0-9-]+\$ (got: ${TOKEN_ID})${NC}"
        exit 1
    fi
    SECRET_NAME="${SECRET_BASE}/${TOKEN_ID}"
else
    SECRET_NAME="${SECRET_BASE}"
    echo -e "${YELLOW}No token id given; using legacy secret ${SECRET_NAME}.${NC}"
    echo -e "${YELLOW}For multi-token, re-run as: ./scripts/setup-secrets.sh <id>${NC}"
    echo ""
fi
```

- [ ] **Step 2: Update the "Next Steps" hint** — after the deploy hint, remind the operator to add a matching schedule. Change the `echo "1. Deploy the Lambda function:"` block to include:

```bash
echo "1. Add a matching schedule in serverless.yml with:"
echo "     input: { tokenId: ${TOKEN_ID:-<none, legacy>} }"
echo ""
echo "2. Deploy the Lambda function:"
echo "   npm run deploy"
```

(Renumber the remaining "Subscribe to alerts" / "Verify" steps to 3 and 4.)

- [ ] **Step 3: Syntax-check the script**

Run: `bash -n scripts/setup-secrets.sh`
Expected: exits 0 (no output).

Run: `bash scripts/setup-secrets.sh 'BAD_ID' < /dev/null`
Expected: prints the `token id must match` error and exits non-zero **before** any AWS call. (If AWS CLI/credentials are absent it may exit earlier at the credentials check — that is acceptable; the id validation is covered by reading the script.)

- [ ] **Step 4: Commit**

```bash
git add scripts/setup-secrets.sh
git commit -m "feat: setup-secrets.sh accepts a per-token id argument"
```

---

## Task 8: Documentation

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above (final task; no code depends on it).
- Produces: docs describing the multi-token model.

- [ ] **Step 1: Update `.env.example`** — replace the warmup config comment block so it references `SECRET_NAME_PREFIX` instead of a single secret name:

```
# AWS Configuration
AWS_REGION=eu-north-1

# Warmup Configuration (these are also set in serverless.yml defaults)
SECRET_NAME_PREFIX=claude-webasto/prod/token
WARMUP_MESSAGE=Hello! This is an automated warm-up message to reset my Claude Code rate limit window. Please just say 'Warmed up!' in response.
MODEL=claude-haiku-4-5-20251001
MAX_TOKENS=64
```

- [ ] **Step 2: Update `CLAUDE.md`** — make these concrete edits:
  - In the **Configuration → Environment variables** table: remove the `AWS_SECRET_NAME` row; add a `SECRET_NAME_PREFIX` row (default `claude-webasto/prod/token`, "Secrets Manager name prefix; per-token secret is `<prefix>/<tokenId>`") and an `ALERT_TOPIC_ARN` row (default "(set by serverless to the SNS topic)", "Where per-token failure details are published").
  - Replace the **Secrets Manager secret** section so it documents per-token secrets:

    ```
    **Secrets Manager secrets** (one per token, `claude-webasto/prod/token/<id>`):
    ```json
    { "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-..." }
    ```
    A schedule with no `tokenId` falls back to the legacy `claude-webasto/prod/token`.
    ```
  - Replace the **Architecture** diagram's single-cron top line with the multi-schedule shape and note the handler reads `event.tokenId`, and that on failure it publishes a detailed message to SNS (tokenId + error).
  - Update the **Manual invocation** command to `npx serverless invoke -f warmup --data '{"tokenId":"alice"}'`.
  - Add a short **Adding a token** subsection under Deployment:

    ```
    ### Adding a token
    1. `./scripts/setup-secrets.sh <id>` — store that token's OAuth token
    2. Add a `schedule` block in `serverless.yml` with `input: { tokenId: <id> }` and its cron
    3. `./scripts/deploy.sh`
    ```

- [ ] **Step 3: Update `README.md`** — mirror the same three points wherever the README covers config/usage: per-token secrets via `setup-secrets.sh <id>`, per-token `schedule` blocks with `input.tokenId`, and the `--data '{"tokenId":"alice"}'` manual-invoke form. Keep the existing tone/structure; only edit the affected sections.

- [ ] **Step 4: Verify no stale single-token references remain**

Run: `grep -rn "AWS_SECRET_NAME" CLAUDE.md README.md .env.example serverless.yml src`
Expected: no matches (exit 1 from grep is the success signal here).

- [ ] **Step 5: Commit**

```bash
git add .env.example CLAUDE.md README.md
git commit -m "docs: document multi-token warmup model"
```

---

## Final verification

- [ ] **Run the full test suite with coverage**

Run: `npm run test:coverage`
Expected: PASS; coverage on `src/*.ts` (excluding tests) ≥ 80%.

- [ ] **Confirm the production build is clean**

Run: `npm run build`
Expected: exits 0; `dist/` contains `warmup.js`, `config.js`, `secretName.js`, `tokenStore.js`, `alerter.js` and **no** `*.test.js`.
