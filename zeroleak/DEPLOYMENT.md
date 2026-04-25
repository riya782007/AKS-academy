# ZeroLeak Deployment Guide

## Prerequisites
- Node.js 18.20+
- PostgreSQL 15+
- Redis 7+
- Shopify Partner account + app created
- Twilio account with WhatsApp Business sender
- Domain with HTTPS (required by Shopify)

---

## 1. Local Development

```bash
# Clone and install
cd zeroleak
npm install

# Copy environment
cp .env.example .env
# Fill in SHOPIFY_API_KEY, SHOPIFY_API_SECRET, DATABASE_URL, REDIS_URL

# Setup database
npx prisma migrate dev --name init
npx prisma db seed  # seeds global pincode risk data

# Start development (tunnels via Shopify CLI)
npm run dev
```

The Shopify CLI will create a tunnel and register webhooks automatically.

---

## 2. Production Deployment (Fly.io — recommended)

### Why Fly.io:
- Mumbai region (low latency for India)
- Native Postgres + Redis addons
- Zero-downtime deploys
- Secrets management

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Authenticate
fly auth login

# Create app
fly launch --name zeroleak-prod --region bom  # Mumbai

# Create Postgres
fly postgres create --name zeroleak-db --region bom

# Create Redis
fly redis create --name zeroleak-redis --region bom

# Set secrets
fly secrets set \
  SHOPIFY_API_KEY=your_key \
  SHOPIFY_API_SECRET=your_secret \
  SHOPIFY_APP_URL=https://zeroleak-prod.fly.dev \
  TWILIO_ACCOUNT_SID=your_sid \
  TWILIO_AUTH_TOKEN=your_token \
  ANTHROPIC_API_KEY=your_key \
  SESSION_SECRET=$(openssl rand -hex 32)

# Deploy
fly deploy

# Run migrations
fly ssh console -C "cd /app && npx prisma migrate deploy"
```

### fly.toml (create this file):
```toml
app = "zeroleak-prod"
primary_region = "bom"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "3000"
  NODE_ENV = "production"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1

[[vm]]
  memory = "1gb"
  cpu_kind = "shared"
  cpus = 1
```

### Dockerfile:
```dockerfile
FROM node:18-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production=false

FROM node:18-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:18-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
EXPOSE 3000
CMD ["npm", "run", "docker-start"]
```

---

## 3. Worker Processes

Workers must run as separate processes (not part of the Remix server):

```bash
# Start order processor worker
npm run worker:order

# Start verification queue worker
npm run worker:verify
```

On Fly.io, add to fly.toml:
```toml
[[processes]]
  name = "web"
  entrypoint = ["npm", "run", "start"]

[[processes]]
  name = "order-worker"
  entrypoint = ["npm", "run", "worker:order"]

[[processes]]
  name = "verify-worker"
  entrypoint = ["npm", "run", "worker:verify"]
```

---

## 4. Shopify App Store Launch Requirements

### Technical requirements:
- [ ] HTTPS only (enforced by Fly.io)
- [ ] OAuth 2.0 install flow (`/auth` routes)
- [ ] Webhook HMAC verification (done by `authenticate.webhook()`)
- [ ] Session token authentication for embedded app
- [ ] Billing API integration with trial period
- [ ] App must handle `app/uninstalled` webhook

### App listing requirements:
- [ ] App name: "ZeroLeak — Profit Protection"
- [ ] Category: Orders, Fulfillment
- [ ] Screenshots (5 required): Dashboard, Orders, Rules, Analytics, Settings
- [ ] Demo video (60s recommended)
- [ ] Privacy policy URL
- [ ] Support email

### Shopify review checklist:
- [ ] No access to data beyond declared scopes
- [ ] GDPR webhooks: `customers/data_request`, `customers/redact`, `shop/redact`
- [ ] App must work on mobile (Polaris is responsive)
- [ ] No fake reviews or misleading claims

### GDPR webhook handlers (add to webhooks.tsx):
```tsx
case "CUSTOMERS_DATA_REQUEST":
  // Export customer data
  break;
case "CUSTOMERS_REDACT":
  // Delete customer data
  await db.order.deleteMany({ where: { customerId: String(payload.customer?.id) } });
  break;
case "SHOP_REDACT":
  // Delete all merchant data (called 48h after uninstall)
  await db.merchant.delete({ where: { shop } });
  break;
```

---

## 5. Environment Variables Reference

| Variable                 | Required | Description                              |
|--------------------------|----------|------------------------------------------|
| `SHOPIFY_API_KEY`        | Yes      | Shopify Partner Dashboard → App API key  |
| `SHOPIFY_API_SECRET`     | Yes      | Shopify app secret                       |
| `SHOPIFY_APP_URL`        | Yes      | Public HTTPS URL of your app             |
| `DATABASE_URL`           | Yes      | PostgreSQL connection string             |
| `REDIS_URL`              | Yes      | Redis connection string                  |
| `TWILIO_ACCOUNT_SID`     | WA only  | Twilio account SID                       |
| `TWILIO_AUTH_TOKEN`      | WA only  | Twilio auth token                        |
| `TWILIO_WHATSAPP_FROM`   | WA only  | WhatsApp sender (e.g. `whatsapp:+14155…`)|
| `GOOGLE_MAPS_API_KEY`    | Optional | Address geocoding                        |
| `META_CAPI_ACCESS_TOKEN` | Optional | Meta Conversion API                      |
| `ANTHROPIC_API_KEY`      | NL rules | Anthropic API for rule parsing           |
| `SESSION_SECRET`         | Yes      | Random 32-byte hex string                |

---

## 6. Monitoring

### Health check endpoint (add to routes):
```
GET /health → { status: "ok", version: "1.0.0", db: "ok", redis: "ok" }
```

### Key metrics to monitor:
- Order processing latency (target < 2s end-to-end)
- Queue depth: `zeroleak:orders` (alert if > 1000)
- WhatsApp delivery rate (Twilio dashboard)
- Risk engine cache hit rate (Redis)
- Error rate per merchant

### Recommended: Sentry for error tracking
```bash
npm install @sentry/remix
```
