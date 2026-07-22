# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

AWS Lambda cron that sends a warmup message to the Anthropic messages API using a Claude Code OAuth token. This resets the 5-hour rolling rate limit window before work starts, giving two effective working windows per day.

**Key Technologies:**
- Runtime: TypeScript on Node.js 22 (AWS Lambda)
- Infrastructure: Serverless Framework (v3/v4 compatible)
- AWS Services: Lambda, EventBridge (scheduled rule), Secrets Manager, SNS, CloudWatch
- No runtime dependencies — uses native `fetch` and bundled AWS SDK v3

## Rate Limit Strategy

- Warmup fires at **8 AM Kyiv** (6 AM UTC) daily
- You start work at ~10 AM Kyiv with ~3 hours remaining in the warmup window
- At ~1 PM Kyiv the warmup window expires, your next request starts a fresh 5-hour window
- One cron job → two effective working windows (10 AM–1 PM + 1 PM–6 PM)
- During summer DST (UTC+3), the cron fires at 9 AM Kyiv — adjust in `serverless.yml` if needed

## Commands

```bash
# Build
npm run build                    # TypeScript → dist/

# Deploy (full pipeline)
./scripts/deploy.sh              # install + build + serverless deploy
npm run deploy                   # same thing

# Remove
./scripts/remove.sh              # serverless remove + optional secret deletion
npm run remove                   # same thing

# Secrets
./scripts/setup-secrets.sh       # Store OAuth token in AWS Secrets Manager

# Manual invocation (after deploy)
npx serverless invoke -f warmup --data '{"tokenId":"alice"}'  # Trigger warmup for one token

# Logs
npx serverless logs -f warmup --tail  # Stream CloudWatch logs
```

## Architecture

```
EventBridge schedule (alice) cron(0 6 * * ? *)  ─┐
EventBridge schedule (bob)   cron(0 14 * * ? *) ─┤
                                                  ▼
                                Lambda (warmup) — one function, N schedules
    ├── Reads event.tokenId, resolves per-token secret (cached across warm invocations)
    ├── POST https://api.anthropic.com/v1/messages
    │     model: claude-haiku-4-5-20251001, max_tokens: 64
    └── Logs structured JSON to CloudWatch

On failure:
    Handler publishes a detailed message (tokenId + error) to the SNS alert topic → Email (if subscribed)
    CloudWatch Errors/Throttles Alarm → SNS Topic → Email (backstop)
```

## Configuration

**Environment variables** (set in `serverless.yml`, overridable via `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `SECRET_NAME_PREFIX` | `claude-webasto/prod/token` | Secrets Manager name prefix; per-token secret is `<prefix>/<tokenId>` |
| `ALERT_TOPIC_ARN` | (set by serverless to the SNS topic) | Where per-token failure details are published |
| `WARMUP_MESSAGE` | (greeting + "say Warmed up!") | Message sent to Anthropic API |
| `MODEL` | `claude-haiku-4-5-20251001` | Model to use (use cheapest) |
| `MAX_TOKENS` | `64` | Max response tokens |
| `AWS_REGION` | `eu-north-1` | AWS deployment region |

**Secrets Manager secrets** (one per token, `claude-webasto/prod/token/<id>`):
```json
{
  "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-..."
}
```
A schedule with no `tokenId` falls back to the legacy `claude-webasto/prod/token`.

Generate the token with: `claude setup-token`

## Deployment

### Prerequisites
- Node.js 22+
- AWS CLI configured (`aws configure`)
- Claude Code OAuth token (`claude setup-token`)

### First-time setup
1. `./scripts/setup-secrets.sh` — stores OAuth token in Secrets Manager
2. `./scripts/deploy.sh` — builds and deploys the Lambda
3. (Optional) Subscribe to alerts: `aws sns subscribe --topic-arn <ARN> --protocol email --notification-endpoint you@email.com`

### Updating
- Change schedule: edit `cron()` in `serverless.yml` → `./scripts/deploy.sh`
- Rotate token: `./scripts/setup-secrets.sh` (no redeploy needed)

### Adding a token
1. `./scripts/setup-secrets.sh <id>` — store that token's OAuth token
2. Add a `schedule` block in `serverless.yml` with `input: { tokenId: <id> }` and its cron
3. `./scripts/deploy.sh`

## File Structure

```
src/
├── config.ts            # Load config from environment
├── secretName.ts        # Resolve per-token secret name
├── tokenStore.ts        # Per-token cache (Map) + Secrets Manager retrieval
├── alerter.ts           # SNS failure alert publisher
└── warmup.ts            # Handler that wires dependencies together
scripts/deploy.sh        # Build + deploy pipeline
scripts/remove.sh        # Stack teardown + optional secret deletion
scripts/setup-secrets.sh # Store OAuth token in Secrets Manager
serverless.yml           # IaC: Lambda + EventBridge + SNS + CloudWatch
```

## Code Style

- TypeScript strict mode
- 2-space indentation
- ES2022 target, Node16 module resolution
- No runtime dependencies — native fetch, bundled AWS SDK v3
- Structured JSON logging for CloudWatch

## Important Implementation Details

### OAuth Token Caching
Tokens are cached per secret name in a `Map` within `src/tokenStore.ts`. On a 401/403 response, only that token's cache entry is invalidated; other tokens' entries remain intact for the next invocation. This enables safe per-token retry logic without affecting other concurrent warmups.

### Anthropic API Headers
Required headers for Claude Code OAuth tokens:
- `anthropic-version: 2023-06-01`
- `anthropic-beta: claude-code-20250219,oauth-2025-04-20`

These beta headers are required for OAuth token authentication. If the API changes, check the [claude-code-warmup](https://github.com/tappress/claude-code-warmup) reference repo.

### Serverless Framework Reference
The `WarmupLambdaFunction` logical ID in CloudFormation is auto-generated by Serverless Framework from the function name `warmup` → `WarmupLambdaFunction`. This is used by CloudWatch alarms to reference the function.

## Common Issues

### "Secret string is empty" / "CLAUDE_CODE_OAUTH_TOKEN not found"
Run `./scripts/setup-secrets.sh` to store your token, or verify with:
```bash
aws secretsmanager get-secret-value --secret-id claude-webasto/prod/token --region eu-north-1
```

### Token expired
OAuth tokens from `claude setup-token` are valid for ~1 year. Regenerate and run `./scripts/setup-secrets.sh`.

### Lambda not firing
Check the schedule is enabled in `serverless.yml` and the function exists:
```bash
npx serverless info
```
