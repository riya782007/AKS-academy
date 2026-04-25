# ZeroLeak — System Architecture

## Product Vision
India's Profit Protection OS for Shopify merchants.
Invisible sophistication: the merchant sees simplicity; the system handles complexity.

---

## Core Design Principles

1. **Deterministic first** — Risk scoring is rules-based. AI is ONLY used to parse merchant NL instructions into rules. It never scores an order.
2. **Async everything** — Webhooks enqueue jobs (<5s response). Workers process asynchronously.
3. **Merchant data isolation** — All queries are scoped to `merchantId`. No cross-merchant data exposure.
4. **Graceful degradation** — Redis down → process synchronously. DB down → log + retry via queue.

---

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                     Shopify Storefront                       │
│                   (Order placed by customer)                  │
└────────────────────────┬────────────────────────────────────┘
                         │  Webhook: orders/create
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   Shopify Remix App                          │
│   /webhooks → authenticate.webhook() → enqueue to BullMQ    │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Event Engine                              │
│              BullMQ Queue: zeroleak:orders                   │
│        (Redis-backed, 3 retries, exponential backoff)        │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   Order Processor Worker                     │
│  1. Check plan limits                                        │
│  2. Run Risk Engine → score (0-100)                          │
│  3. Run Decision Engine → SHIP / VERIFY / HOLD               │
│  4. Apply merchant rules (override if match)                 │
│  5. Persist order + risk factors to Postgres                 │
│  6. Trigger downstream action (WA verify / token advance)   │
│  7. Update daily profit ledger                               │
└──────────────┬──────────────────────────┬───────────────────┘
               │                          │
    ┌──────────▼──────────┐    ┌─────────▼────────────┐
    │   WhatsApp Service   │    │   Shopify Admin API   │
    │   (Twilio WA API)    │    │   (tag order, note)   │
    └─────────────────────┘    └──────────────────────┘
```

---

## Risk Engine: Scoring Factors

| Factor           | Max Points | Signal                                      |
|------------------|-----------|----------------------------------------------|
| Pincode Risk     | 25        | Historical RTO rate for delivery pincode     |
| Prior RTO        | 30        | Customer's personal RTO history              |
| AOV Risk         | 15        | High COD value (>₹2000 = high risk)          |
| Phone Heuristics | 20        | VoIP, landline, repeated digits, invalid     |
| Customer History | 10        | Cancellations, account age, order count      |
| **COD Uplift**   | +10%      | All COD orders get 10% score uplift          |

**Score → Band → Decision:**
```
0–40   → GREEN → SHIP    (auto-approve, fulfill normally)
41–70  → AMBER → VERIFY  (WhatsApp confirmation required)
71–100 → RED   → HOLD    (token advance required OR cancel)
```

---

## Decision Engine: Rule Priority

```
Merchant Custom Rules (priority 1–100, desc)
    ↓ (if no match)
Risk Score defaults (GREEN→SHIP, AMBER→VERIFY, RED→HOLD)
```

Rules are evaluated in priority order. First match wins.

---

## Natural Language Rule Parser

```
Merchant input: "Require ₹49 token advance in risky zones"
         ↓
   Anthropic claude-sonnet-4-6
         ↓
Structured Rule Object:
{
  conditions: { riskBand: "RED" },
  action: { decision: "HOLD", tokenAmount: 49 }
}
         ↓
  Stored in DB (rules table)
         ↓
  Evaluated deterministically by Decision Engine
```

The AI TRANSLATES intent. It never EXECUTES decisions.

---

## WhatsApp Verification Flow (Module 4)

```
AMBER order detected
      ↓
sendVerificationMessage() via Twilio WA
      ↓
Customer receives: "Confirm order #1234? Reply YES/NO"
      ↓
Customer replies YES/NO
      ↓
Twilio webhook → /webhooks?source=twilio
      ↓
handleIncomingReply()
      ↓
YES → order.status = PROCESSED → fulfill
NO  → order.status = CANCELLED
```

---

## Database Schema (key tables)

```sql
merchants       -- one per Shopify shop, plan + settings
orders          -- every order processed, with risk score + decision
risk_factors    -- per-factor breakdown for each order
verifications   -- WhatsApp/token verification records
rules           -- merchant rules (NL-parsed + manual)
pincode_risk    -- pincode-level RTO rates (global seed + merchant-trained)
profit_ledger   -- daily aggregates: orders, RTOs prevented, profit saved
```

---

## Queue Architecture

| Queue                  | Purpose                          | Concurrency |
|------------------------|----------------------------------|-------------|
| `zeroleak:orders`      | Process new/updated orders       | 10          |
| `zeroleak:verifications` | Expire stale WA verifications  | 5           |

Both use BullMQ backed by Redis. Jobs survive Redis restarts (Bull persistence).

---

## Billing (Shopify Billing API)

| Plan       | Price    | Order Limit | Features                        |
|------------|----------|-------------|----------------------------------|
| FREE       | ₹0       | 50/mo       | Risk scoring, basic dashboard    |
| GROWTH     | ₹999/mo  | 500/mo      | WhatsApp verify, basic rules     |
| PRO        | ₹2499/mo | Unlimited   | Autopilot, NL rules, analytics   |
| ENTERPRISE | ₹9999/mo | Unlimited   | Custom, SLA, dedicated support   |

All paid plans use Shopify's recurring billing with 14-day trial.

---

## API Integrations

| Service      | Used For                              | Env Var                  |
|-------------|----------------------------------------|--------------------------|
| Shopify      | Orders, webhooks, billing, auth        | SHOPIFY_API_KEY/SECRET   |
| Twilio       | WhatsApp Business messaging            | TWILIO_*                 |
| Google Maps  | Address geocoding, pincode validation  | GOOGLE_MAPS_API_KEY      |
| Meta CAPI    | Conversion event tracking              | META_CAPI_ACCESS_TOKEN   |
| Anthropic    | NL rule parsing (policy translation)   | ANTHROPIC_API_KEY        |

---

## Architectural Critique & Improvements

### What's strong:
- Deterministic risk engine — no LLM drift in scoring
- Event-driven architecture — scales horizontally
- Per-factor score breakdown — full explainability
- Idempotent job IDs — safe to retry

### Known weaknesses + improvements:

1. **Pincode data** — Static seed is weak. Replace with real DTDC/Delhivery/Shiprocket RTO data via their APIs.

2. **Phone carrier lookup** — Currently heuristic. Integrate Truecaller Business API or Numverify for carrier + spam signals.

3. **ML pipeline** — After 10k+ orders, train a per-merchant logistic regression on actual RTO outcomes. Replace static weights with learned weights. Prisma's `rtoRate` on PincodeRisk is designed for this.

4. **Address intelligence** — Google Maps geocoding to validate address accuracy. Delivery to a known commercial/warehouse address is higher risk.

5. **Rule conflict resolution** — Current: first-match-wins by priority. Consider: all matching rules aggregate (score += rule_delta).

6. **Webhook idempotency** — BullMQ jobIds ensure this for order processing, but the DB upsert is the true guard.

7. **Multi-currency** — Schema supports `currency` field, but scoring assumes INR. For non-INR AOV, convert before scoring.

8. **Shopify Flow integration** — Long-term: expose ZeroLeak risk scores as Shopify Flow triggers so merchants can build custom automations.

9. **Fraud consortium** — Eventually: anonymously pool RTO signals across ZeroLeak merchants by phone/email hash to build a pan-India fraud network.
