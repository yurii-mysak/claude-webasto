# Multi-token warmup — design

**Date:** 2026-07-22
**Status:** Approved (pending spec review)

## Overview

Extend the existing single-token warmup Lambda to warm **multiple** Claude Code
OAuth tokens, each on its **own schedule**. This keeps the current
deploy-time / Serverless model — schedules live in `serverless.yml`, tokens live
in Secrets Manager, changes ship via `serverless deploy`. No new runtime
database, no dynamic config layer, and it remains **one app / one stack** (not a
second deployment).

## Goals

- Warm N tokens, each with an independent cron schedule / timezone.
- Add or remove a token by editing `serverless.yml` + storing a secret, then
  redeploying — the same workflow used today.
- On failure, the alert names **which** token failed.
- Keep the existing single-token deployment working unchanged (backward compat).

## Non-goals (YAGNI)

- Runtime token management without redeploy (rejected in brainstorming).
- Per-token CloudWatch alarms (single shared alarm + detailed SNS message).
- Per-token separate Lambda functions (one handler, N schedules).
- Shared-schedule / schedule-group modes (per-token schedules only).

## Architecture

```
EventBridge schedule (alice, cron A)  ─┐
EventBridge schedule (bob,   cron B)  ─┼─▶ Lambda: warmup handler
EventBridge schedule (carol, cron C)  ─┘        │  event.tokenId → secret name
                                                │  fetch token (per-token cache)
                                                │  POST /v1/messages
                                                ├─ success → structured log (tokenId)
                                                └─ failure → structured log (tokenId)
                                                            + SNS publish (tokenId, error)
                                                            + throw (trips Errors alarm backstop)
```

Single handler. Each EventBridge schedule carries `input: { tokenId: <id> }`.
The handler resolves that to a per-token secret, warms it, and reports per-token
outcome.

## Components

### 1. Token identity & storage

- **One secret per token:** `claude-webasto/prod/token/<id>`, each containing
  `{ "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-..." }`.
- `<id>` is a short slug (`[a-z0-9-]`), e.g. `alice`, `bob`.
- Already covered by the existing IAM resource `claude-webasto/*` — **no policy
  change** for reads. Adds `sns:Publish` on the alert topic (see Alerting).

### 2. Handler (`src/warmup.ts` + extracted modules)

Refactor the single-file handler into small, testable units:

- `src/config.ts` — reads env (`SECRET_NAME_PREFIX`, `WARMUP_MESSAGE`, `MODEL`,
  `MAX_TOKENS`, `ALERT_TOPIC_ARN`, `AWS_REGION`) and validates them.
- `src/secretName.ts` — pure `resolveSecretName(prefix, tokenId?)`:
  - `tokenId` present → `${prefix}/${tokenId}`.
  - `tokenId` absent → `${prefix}` (legacy single-token secret).
  - Validates `tokenId` against `^[a-z0-9-]+$`; rejects empty / path-y values.
- `src/tokenStore.ts` — fetches + caches tokens keyed by secret name
  (`Map<secretName, token>`); parses secret JSON; invalidates a single entry on
  demand. Injects a `SecretsManagerClient` for testability.
- `src/alerter.ts` — `publishFailure({ tokenId, error, timestamp })` to SNS when
  `ALERT_TOPIC_ARN` is set; no-op (warn-log only) when unset so local/manual
  invokes don't fail. Injects an `SNSClient`.
- `src/warmup.ts` — thin `ScheduledHandler`: pull `tokenId` from the event,
  resolve secret, warm via `fetch`, log, and on failure publish + rethrow.

Behavioral rules preserved from today:
- 401/403 → invalidate that token's cache entry (only that entry).
- Structured JSON logs, now always including `tokenId` (or `"default"`).
- 25s fetch timeout; handler timeout stays 30s.

### 3. Scheduling (`serverless.yml`)

The `warmup` function gets one `schedule` event per token:

```yaml
functions:
  warmup:
    handler: dist/warmup.handler
    events:
      - schedule:
          rate: cron(0 6 * * ? *)      # alice — 8 AM Kyiv (UTC+2)
          enabled: true
          input:
            tokenId: alice
      - schedule:
          rate: cron(0 14 * * ? *)     # bob — own timezone
          enabled: true
          input:
            tokenId: bob
```

Add a token = add a secret + add a schedule block + redeploy.
Environment gains `ALERT_TOPIC_ARN: !Ref AlertTopic` and
`SECRET_NAME_PREFIX: claude-webasto/prod/token`.

### 4. Secret setup (`scripts/setup-secrets.sh`)

- Accept an optional token-id argument: `./scripts/setup-secrets.sh alice`
  → creates/updates `claude-webasto/prod/token/alice`.
- No argument → legacy secret `claude-webasto/prod/token` (unchanged behavior).
- Validate the id against `^[a-z0-9-]+$` before use.

### 5. Alerting

- **Detailed SNS message on failure:** the handler publishes
  `{ tokenId, error, timestamp, region }` to the alert topic so the email/SMS
  says which token failed and why. Requires `sns:Publish` on `AlertTopic` in the
  IAM policy.
- **Backstop unchanged:** the existing `Errors` and `Throttles` CloudWatch
  alarms stay — they catch cases where the handler can't publish (throttle,
  crash before the catch, OOM).
- No per-token alarms.

## Edge cases

| Case | Behavior |
|------|----------|
| Schedule fires with **no** `tokenId` | Legacy secret `claude-webasto/prod/token`; logs `tokenId: "default"`. |
| `tokenId` present but secret missing | `GetSecretValue` throws `ResourceNotFoundException` → logged with tokenId, SNS published, rethrow (alarm trips). |
| Invalid `tokenId` (empty, `../`, uppercase, symbols) | `resolveSecretName` throws before any AWS call; logged + alerted. |
| Secret exists but empty / not JSON | Throws "Secret string is empty" / parse error → logged + alerted. |
| Secret JSON missing `CLAUDE_CODE_OAUTH_TOKEN` | Throws "token not found in secret" → logged + alerted. |
| Two schedules, same warm container | Per-token cache map holds both; no cross-token bleed. |
| One token 401s, another valid | Only the 401 token's cache entry invalidated; others untouched. |
| `ALERT_TOPIC_ARN` unset (local/manual invoke) | `publishFailure` warn-logs and no-ops; handler still throws. |
| Zero schedules configured | Valid deploy; nothing fires (documented, not an error). |
| API returns non-JSON / network error | Caught, logged with tokenId, alerted, rethrown (as today). |

## Testing strategy

Add **vitest** as a dev dependency (dev-only; the Lambda bundle keeps zero
runtime deps). Add `"test"` and `"test:coverage"` scripts. Target ≥80% coverage
on the extracted modules.

**Unit tests (pure / injected, no network):**

- `secretName.test.ts`
  - resolves `${prefix}/${tokenId}` with a valid id.
  - falls back to bare `prefix` when tokenId absent/undefined.
  - throws on empty string, uppercase, `../`, spaces, and other non-slug input.
- `config.test.ts`
  - valid env parses; `MAX_TOKENS` non-numeric / ≤0 throws; defaults applied.
- `tokenStore.test.ts` (mock `SecretsManagerClient`)
  - fetches + parses token; caches (second call: no second AWS call).
  - two different secret names cached independently.
  - invalidate removes only the named entry.
  - empty secret string / bad JSON / missing key each throw the right error.
- `alerter.test.ts` (mock `SNSClient`)
  - publishes with tokenId + error when ARN set.
  - no-ops (no publish) when ARN unset.
- `warmup.test.ts` (mock tokenStore, alerter, `global.fetch`)
  - success path: logs success with tokenId, no publish, resolves.
  - `tokenId` from event used to resolve the right secret.
  - missing tokenId → uses default/legacy path.
  - 401 → invalidates that token, publishes, rethrows.
  - 500 → publishes, rethrows, does **not** invalidate cache.
  - fetch timeout/throw → publishes, rethrows.

**Manual / integration verification (documented, not automated):**

- `npx serverless invoke -f warmup --data '{"tokenId":"alice"}'` → 200 log line.
- `npx serverless invoke -f warmup --data '{"tokenId":"nope"}'` → error log +
  SNS alert received.

## Docs

- `CLAUDE.md`: multi-token model, per-token secrets, per-token schedules,
  `setup-secrets.sh <id>`, SNS-detail alerting.
- `README.md`: same, with an "adding a token" walkthrough.
- `.env.example`: add `SECRET_NAME_PREFIX` (drop/deprecate `AWS_SECRET_NAME`).

## Rollout / backward compatibility

Existing deployments keep working: a schedule with no `tokenId` reads the legacy
secret. Migration path: add per-token secrets + schedules alongside the old one,
verify, then remove the legacy schedule when ready.
