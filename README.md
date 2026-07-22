# Claude Webasto

Automated AWS Lambda warmup for Claude Code rate limits — start every workday with full capacity.

[![AWS Lambda](https://img.shields.io/badge/AWS-Lambda-orange)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)]()
[![Serverless](https://img.shields.io/badge/Serverless-Framework-red)]()
[![Node.js](https://img.shields.io/badge/Node.js-22-green)]()

---

## 🎯 Problem & Solution

Claude Code enforces rate limits on a **rolling 5-hour window** starting from your first request. If your first request is at 10 AM, the window runs until 3 PM — and you're stuck with whatever quota remains.

**Claude Webasto** sends an automated warmup message early in the morning, so the 5-hour window starts *before* you sit down to work. By the time you open your laptop, the window is about to expire — giving you a fresh allocation right when you need it.

**One cron job → two working windows per day.**

---

## ⏰ Schedule Strategy

```
6 AM UTC    8 AM Kyiv       10 AM            1 PM              6 PM
  │            │               │                │                 │
  ▼            ▼               ▼                ▼                 ▼
  🔥 warmup   ·····Window 1····│··(3h remain)··│                 │
                               │  You work     │                 │
                               │  here         │                 │
                               │               ▼                 │
                               │          Window expires         │
                               │          🔄 Fresh window ·······│
                               │               │  Full 5h quota  │
                               │               │  You work here  │
```

---

## ✨ Features

- ✅ **Multi-token warmup** — one Lambda, one EventBridge schedule per token (`input: { tokenId }`)
- ✅ **Secure token storage** — one OAuth token per person/token in AWS Secrets Manager (not env vars)
- ✅ **Failure alerts** — SNS notifications on Lambda errors or throttles
- ✅ **Zero runtime dependencies** — native `fetch` + bundled AWS SDK v3
- ✅ **Token caching** — Secrets Manager called once, cached across warm invocations
- ✅ **Auto-refresh on auth failure** — 401/403 invalidates cache, next invocation retries
- ✅ **Minimal footprint** — 128 MB Lambda, ~1s execution, focused modular design
- ✅ **Cost: FREE** — well within AWS free tier

---

## 🚀 Quick Start

### Prerequisites
- Node.js 22+
- AWS CLI configured (`aws configure`)
- Claude Code installed (`claude setup-token` to generate OAuth token)

### 1. Clone & Install
```bash
git clone <your-repo-url>
cd claude-webasto
npm install
```

### 2. Store OAuth Token
```bash
./scripts/setup-secrets.sh <id>
```
This prompts for your token and stores it in AWS Secrets Manager under `claude-webasto/prod/token/<id>`. Repeat per person/token you want warmed up (e.g. `alice`, `bob`) — each needs a matching `schedule` block in `serverless.yml` with `input: { tokenId: <id> }`.

### 3. Deploy
```bash
./scripts/deploy.sh
```
Builds TypeScript, deploys Lambda + EventBridge cron + SNS + CloudWatch alarms.

### 4. (Optional) Subscribe to Alerts
```bash
aws sns subscribe \
  --topic-arn <AlertTopicArn from deploy output> \
  --protocol email \
  --notification-endpoint you@email.com \
  --region eu-north-1
```

### 5. Verify
```bash
npx serverless invoke -f warmup --data '{"tokenId":"alice"}'  # Manual trigger for one token
npx serverless logs -f warmup                                 # Check logs
```

---

## 🏗️ Architecture

```
┌────────────────────┐   ┌────────────────────┐
│  EventBridge        │   │  EventBridge        │   ← one schedule per token
│  schedule (alice)   │   │  schedule (bob)     │      input: { tokenId }
└──────────┬──────────┘   └──────────┬──────────┘
           │                          │
           └────────────┬─────────────┘
                         ▼
              ┌──────────────────────┐     ┌──────────────┐
              │  Lambda (Node.js 22) │────▶│  Secrets     │
              │  one fn, N schedules │     │  Manager     │
              │  • Read tokenId      │◀────│  (per-token) │
              │  • Get that token    │     └──────────────┘
              │  • POST /v1/msg      │     ┌──────────────┐
              │  • Log result        │────▶│  CloudWatch  │
              └──────────┬────────────┘     │  Logs        │
                         │                  └──────────────┘
                         │ on failure (tokenId + error)
                         ▼
              ┌──────────────┐     ┌──────────────┐
              │  SNS Topic   │────▶│  Email       │
              └──────┬───────┘     └──────────────┘
                     ▲
              ┌──────────────┐
              │  CloudWatch  │  ← backstop on Errors/Throttles
              │  Alarm       │
              └──────────────┘
```

---

## 🔧 Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SECRET_NAME_PREFIX` | `claude-webasto/prod/token` | Secrets Manager name prefix; per-token secret is `<prefix>/<tokenId>` |
| `ALERT_TOPIC_ARN` | (set by serverless to the SNS topic) | Where per-token failure details are published |
| `WARMUP_MESSAGE` | greeting + "say Warmed up!" | Message sent to API |
| `MODEL` | `claude-haiku-4-5-20251001` | Cheapest model for warmup |
| `MAX_TOKENS` | `64` | Minimal response tokens |
| `AWS_REGION` | `eu-north-1` | Deployment region |

**Adding a token:** `./scripts/setup-secrets.sh <id>` → add a `schedule` block in `serverless.yml` with `input: { tokenId: <id> }` → `./scripts/deploy.sh`.

Edit schedules in `serverless.yml` → redeploy. Rotate a token via `./scripts/setup-secrets.sh <id>` (no redeploy needed).

See [CLAUDE.md](CLAUDE.md) for full technical details.

---

## 💰 Cost

| Service | Free Tier | This Project |
|---------|-----------|-------------|
| Lambda | 1M requests/month | 30/month (1/day) |
| Secrets Manager | $0.40/secret/month | 1 secret per token |
| EventBridge | Free | 1 schedule per token |
| CloudWatch | 5 GB logs | ~1 MB/month |
| SNS | 1,000 emails/month | ~0 (failures only) |

**Estimated monthly cost: FREE** (Secrets Manager is ~$0.40/month after free tier)

---

## 📁 Project Structure

```
├── src/
│   ├── config.ts            # Load config from environment
│   ├── secretName.ts        # Resolve per-token secret name
│   ├── tokenStore.ts        # Per-token cache (Map) + Secrets Manager retrieval
│   ├── alerter.ts           # SNS failure alert publisher
│   └── warmup.ts            # Handler that wires dependencies together
├── scripts/
│   ├── deploy.sh            # Build + deploy pipeline
│   ├── remove.sh            # Teardown + optional secret deletion
│   └── setup-secrets.sh     # Store OAuth token in Secrets Manager
├── serverless.yml           # IaC: Lambda + EventBridge + SNS + CloudWatch
├── package.json             # Dev deps only (TypeScript, types)
├── tsconfig.json            # ES2022, Node16, strict
├── .env.example             # Config template
├── CLAUDE.md                # Developer/AI reference
└── README.md                # This file
```

---

## 🆘 Troubleshooting

**Warmup not working?**
1. Check logs: `npx serverless logs -f warmup`
2. Manual trigger: `npx serverless invoke -f warmup --data '{"tokenId":"alice"}'`
3. Verify secret: `aws secretsmanager get-secret-value --secret-id claude-webasto/prod/token/alice --region eu-north-1`

**Token expired?**
Run `claude setup-token` to regenerate, then `./scripts/setup-secrets.sh <id>`. No redeploy needed.

**Wrong time?**
Edit the relevant `schedule` block's `cron(...)` in `serverless.yml` (one per token). During summer DST (UTC+3), a `cron(0 6 * * ? *)` schedule fires at 9 AM Kyiv instead of 8 AM.

**Remove everything?**
```bash
./scripts/remove.sh
```

See [CLAUDE.md](CLAUDE.md) for more troubleshooting details.

---

## 📖 Documentation

| Resource | Description |
|----------|-------------|
| [CLAUDE.md](CLAUDE.md) | Technical reference — architecture, config, code style, implementation details |

---

## 🙏 Credits

Inspired by [tappress/claude-code-warmup](https://github.com/tappress/claude-code-warmup) (Vercel-based). Reimplemented on AWS with Serverless Framework.
