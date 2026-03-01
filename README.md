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

- ✅ **Scheduled warmup** — EventBridge cron fires daily at 8 AM Kyiv (6 AM UTC)
- ✅ **Secure token storage** — OAuth token in AWS Secrets Manager (not env vars)
- ✅ **Failure alerts** — SNS notifications on Lambda errors or throttles
- ✅ **Zero runtime dependencies** — native `fetch` + bundled AWS SDK v3
- ✅ **Token caching** — Secrets Manager called once, cached across warm invocations
- ✅ **Auto-refresh on auth failure** — 401/403 invalidates cache, next invocation retries
- ✅ **Minimal footprint** — 128 MB Lambda, ~1s execution, single source file
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
./scripts/setup-secrets.sh
```
This prompts for your token and stores it in AWS Secrets Manager.

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
npx serverless invoke -f warmup    # Manual trigger
npx serverless logs -f warmup      # Check logs
```

---

## 🏗️ Architecture

```
┌──────────────────┐
│  EventBridge     │
│  cron(0 6 * * ?) │  ← 8 AM Kyiv daily
└──────┬───────────┘
       │
       ▼
┌──────────────────┐     ┌──────────────┐
│  Lambda          │────▶│  Secrets     │
│  (Node.js 22)    │     │  Manager     │
│                  │◀────│  (OAuth tok) │
│  • Get token     │     └──────────────┘
│  • POST /v1/msg  │
│  • Log result    │     ┌──────────────┐
└──────┬───────────┘     │  CloudWatch  │
       │                 │  Logs        │
       │ on failure      └──────────────┘
       ▼
┌──────────────────┐     ┌──────────────┐
│  CloudWatch      │────▶│  SNS Topic   │
│  Alarm           │     │  → Email     │
└──────────────────┘     └──────────────┘
```

---

## 🔧 Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AWS_SECRET_NAME` | `claude-webasto/prod/token` | Secrets Manager secret name |
| `WARMUP_MESSAGE` | greeting + "say Warmed up!" | Message sent to API |
| `MODEL` | `claude-haiku-4-5-20251001` | Cheapest model for warmup |
| `MAX_TOKENS` | `64` | Minimal response tokens |
| `AWS_REGION` | `eu-north-1` | Deployment region |

Edit schedule in `serverless.yml` → redeploy. Rotate token via `./scripts/setup-secrets.sh` (no redeploy needed).

See [CLAUDE.md](CLAUDE.md) for full technical details.

---

## 💰 Cost

| Service | Free Tier | This Project |
|---------|-----------|-------------|
| Lambda | 1M requests/month | 30/month (1/day) |
| Secrets Manager | $0.40/secret/month | 1 secret |
| EventBridge | Free | 1 rule |
| CloudWatch | 5 GB logs | ~1 MB/month |
| SNS | 1,000 emails/month | ~0 (failures only) |

**Estimated monthly cost: FREE** (Secrets Manager is ~$0.40/month after free tier)

---

## 📁 Project Structure

```
├── src/
│   └── warmup.ts            # Lambda handler (single file, ~95 lines)
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
2. Manual trigger: `npx serverless invoke -f warmup`
3. Verify secret: `aws secretsmanager get-secret-value --secret-id claude-webasto/prod/token --region eu-north-1`

**Token expired?**
Run `claude setup-token` to regenerate, then `./scripts/setup-secrets.sh`. No redeploy needed.

**Wrong time?**
Edit `cron(0 6 * * ? *)` in `serverless.yml`. During summer DST (UTC+3), it fires at 9 AM Kyiv instead of 8 AM.

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
