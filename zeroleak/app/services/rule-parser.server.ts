/**
 * ZeroLeak Natural Language Rule Parser
 *
 * Architecture principle: Parse NL → structured rule object using Anthropic API.
 * EXECUTION is always deterministic — the AI only translates intent, never runs the rule.
 *
 * Example input:  "Require ₹49 token advance in risky zones"
 * Example output: { type: "TOKEN_ADVANCE", conditions: { riskBand: "RED" }, action: { tokenAmount: 49 } }
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { db } from "../utils/db.server";
import type { Decision } from "@prisma/client";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Schema for parsed rules ──────────────────────────────────────────────────
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
  const systemPrompt = `You are a rule parser for ZeroLeak, an Indian e-commerce fraud prevention app.
Convert merchant natural language rules into structured JSON rules.

Risk bands: GREEN (score 0-40, low risk), AMBER (41-70, medium), RED (71-100, high risk).
Decisions: SHIP (auto-approve), VERIFY (send WhatsApp confirmation), HOLD (block + optional token advance).
Payment methods: COD, PREPAID, UPI, CARD.

Indian context:
- "risky zones" = RED riskBand
- "token advance" = HOLD decision with tokenAmount
- "₹49" = tokenAmount: 49
- "COD orders" = paymentMethod: "COD"
- "high value" = typically minAOV: 2000

Always output valid JSON matching the schema. Set confidence 0-1 based on how clear the instruction is.`;

  const userPrompt = `Parse this merchant rule into structured JSON:
"${input}"

Return ONLY valid JSON with this structure:
{
  "name": "short rule name",
  "conditions": {
    // include only relevant fields
    "riskBand"?: "GREEN" | "AMBER" | "RED",
    "minRiskScore"?: number,
    "maxRiskScore"?: number,
    "paymentMethod"?: "COD" | "PREPAID" | "UPI" | "CARD",
    "pincodes"?: string[],
    "states"?: string[],
    "minAOV"?: number,
    "maxAOV"?: number
  },
  "action": {
    "decision": "SHIP" | "VERIFY" | "HOLD",
    "tokenAmount"?: number,
    "reason": "human-readable reason"
  },
  "confidence": 0.0-1.0,
  "explanation": "what this rule does"
}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    messages: [{ role: "user", content: userPrompt }],
    system: systemPrompt,
  });

  const content = response.content[0];
  if (content.type !== "text") throw new Error("Unexpected response type from AI");

  let parsed: unknown;
  try {
    // Strip markdown code fences if present
    const jsonText = content.text.replace(/```(?:json)?/g, "").trim();
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`AI returned invalid JSON: ${content.text.slice(0, 200)}`);
  }

  const validated = ParsedRuleSchema.parse(parsed);

  if (validated.confidence < 0.5) {
    throw new Error(
      `Rule confidence too low (${validated.confidence}). Please be more specific: "${input}"`
    );
  }

  // Persist to DB
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
