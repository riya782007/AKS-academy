/**
 * ZeroLeak Natural Language Rule Parser — Gemini 1.5 Flash
 *
 * Parses NL → structured rule object. AI translates intent only;
 * execution is always deterministic.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { db } from "../utils/db.server";
import type { Decision } from "@prisma/client";

function getModel() {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    generationConfig: { maxOutputTokens: 512, temperature: 0.1 },
  });
}

// ─── Schemas ──────────────────────────────────────────────────────────────────
const RuleConditionsSchema = z.object({
  riskBand: z.enum(["GREEN", "AMBER", "RED"]).optional(),
  minRiskScore: z.number().min(0).max(100).optional(),
  maxRiskScore: z.number().min(0).max(100).optional(),
  paymentMethod: z.enum(["COD", "PREPAID", "UPI", "CARD"]).optional(),
  pincodes: z.array(z.string()).optional(),
  states: z.array(z.string()).optional(),
  minAOV: z.number().positive().optional(),
  maxAOV: z.number().positive().optional(),
});

const RuleActionSchema = z.object({
  decision: z.enum(["SHIP", "VERIFY", "HOLD"]),
  tokenAmount: z.number().positive().optional(),
  reason: z.string(),
});

const ParsedRuleSchema = z.object({
  name: z.string(),
  conditions: RuleConditionsSchema,
  action: RuleActionSchema,
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
});

export type ParsedRule = z.infer<typeof ParsedRuleSchema>;

// ─── Parser ───────────────────────────────────────────────────────────────────
export async function parseNaturalLanguageRule(
  input: string,
  merchantId: string
): Promise<{ rule: ParsedRule; ruleId: string }> {
  const prompt = `You are a rule parser for ZeroLeak, an Indian e-commerce fraud prevention app.
Convert the merchant's natural language rule into structured JSON.

Risk bands: GREEN (0-40, low risk), AMBER (41-70, medium), RED (71-100, high risk).
Decisions: SHIP (auto-approve), VERIFY (send WhatsApp confirmation), HOLD (block + optional token advance).
Payment methods: COD, PREPAID, UPI, CARD.

Indian context:
- "risky zones" = RED riskBand
- "token advance" = HOLD with tokenAmount
- "COD orders" = paymentMethod: "COD"
- "high value" = minAOV: 2000

Return ONLY valid JSON (no markdown, no extra text):
{
  "name": "short rule name",
  "conditions": {
    "riskBand"?: "GREEN"|"AMBER"|"RED",
    "minRiskScore"?: number,
    "maxRiskScore"?: number,
    "paymentMethod"?: "COD"|"PREPAID"|"UPI"|"CARD",
    "pincodes"?: string[],
    "states"?: string[],
    "minAOV"?: number,
    "maxAOV"?: number
  },
  "action": {
    "decision": "SHIP"|"VERIFY"|"HOLD",
    "tokenAmount"?: number,
    "reason": "human-readable reason"
  },
  "confidence": 0.0-1.0,
  "explanation": "what this rule does"
}

Merchant rule: "${input}"`;

  const model = getModel();
  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  let parsed: unknown;
  try {
    const jsonText = text.replace(/```(?:json)?/g, "").trim();
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`Gemini returned invalid JSON: ${text.slice(0, 200)}`);
  }

  const validated = ParsedRuleSchema.parse(parsed);

  if (validated.confidence < 0.5) {
    throw new Error(
      `Rule confidence too low (${validated.confidence}). Please be more specific: "${input}"`
    );
  }

  const rule = await db.rule.create({
    data: {
      merchantId,
      name: validated.name,
      naturalText: input,
      type: "NL_PARSED",
      priority: 60,
      isActive: true,
      conditions: validated.conditions,
      action: validated.action,
    },
  });

  return { rule: validated, ruleId: rule.id };
}

// ─── Built-in rule templates (no AI needed) ───────────────────────────────────
export const RULE_TEMPLATES = [
  {
    name: "Block serial RTOs",
    description: "Hold orders from customers with 3+ prior RTOs",
    conditions: { minRiskScore: 85 },
    action: { decision: "HOLD" as Decision, reason: "Serial RTO customer" },
  },
  {
    name: "Verify all high-value COD",
    description: "Verify COD orders above ₹2000",
    conditions: { paymentMethod: "COD", minAOV: 2000 },
    action: { decision: "VERIFY" as Decision, reason: "High-value COD order" },
  },
  {
    name: "Token advance for red zones",
    description: "Require ₹49 token advance in high-risk pincodes",
    conditions: { riskBand: "RED" },
    action: { decision: "HOLD" as Decision, tokenAmount: 49, reason: "High-risk delivery zone — token advance required" },
  },
  {
    name: "Auto-ship trusted customers",
    description: "Auto-approve prepaid orders from customers with 5+ clean orders",
    conditions: { paymentMethod: "PREPAID", maxRiskScore: 20 },
    action: { decision: "SHIP" as Decision, reason: "Trusted prepaid customer" },
  },
];
