/**
 * ZeroLeak Decision Engine
 *
 * Translates a risk score into an actionable order decision.
 * Applies merchant rules ON TOP of base risk scoring.
 * Rule priority: Custom Rules > Risk Score defaults.
 */

import { db } from "../utils/db.server";
import { scoreOrder, type RiskOutput } from "./risk-engine.server";
import type { Decision } from "@prisma/client";

interface DecisionContext {
  merchantId: string;
  shopifyOrderId: string;
  shopifyOrderGid: string;
  orderNumber: string;
  customerId?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  shippingPincode?: string | null;
  shippingCity?: string | null;
  shippingState?: string | null;
  totalPrice: number;
  paymentMethod: string;
  currency?: string;
}

interface DecisionResult {
  decision: Decision;
  riskScore: number;
  riskBand: "GREEN" | "AMBER" | "RED";
  reason: string;
  riskOutput: RiskOutput;
  appliedRuleId?: string;
}

export async function processOrder(ctx: DecisionContext): Promise<DecisionResult> {
  // 1. Score the order
  const riskOutput = await scoreOrder({
    merchantId: ctx.merchantId,
    shopifyOrderId: ctx.shopifyOrderId,
    customerPhone: ctx.customerPhone,
    customerId: ctx.customerId,
    shippingPincode: ctx.shippingPincode,
    totalPrice: ctx.totalPrice,
    paymentMethod: ctx.paymentMethod,
  });

  // 2. Evaluate merchant rules (override engine score if rule fires)
  const ruleOverride = await evaluateRules(ctx, riskOutput);

  const finalDecision = ruleOverride?.decision ?? riskOutput.decision;
  const reason = ruleOverride
    ? `Rule override: ${ruleOverride.reason}`
    : riskOutput.reason;

  // 3. Persist order + risk factors to DB
  const order = await upsertOrder(ctx, riskOutput, finalDecision, reason);

  // 4. Persist individual risk factor breakdown
  await db.riskFactor.createMany({
    data: riskOutput.factors.map((f) => ({
      orderId: order.id,
      factor: f.factor,
      score: f.score,
      detail: f.detail,
    })),
    skipDuplicates: true,
  });

  return {
    decision: finalDecision,
    riskScore: riskOutput.score,
    riskBand: riskOutput.band,
    reason,
    riskOutput,
    appliedRuleId: ruleOverride?.ruleId,
  };
}

// ─── Rule Evaluator ───────────────────────────────────────────────────────────
async function evaluateRules(
  ctx: DecisionContext,
  risk: RiskOutput
): Promise<{ decision: Decision; reason: string; ruleId: string } | null> {
  const rules = await db.rule.findMany({
    where: { merchantId: ctx.merchantId, isActive: true },
    orderBy: { priority: "desc" },
  });

  for (const rule of rules) {
    const conditions = rule.conditions as Record<string, unknown>;
    const action = rule.action as { decision: Decision; reason: string };

    if (matchesConditions(conditions, ctx, risk)) {
      // Increment applied count
      await db.rule.update({
        where: { id: rule.id },
        data: { appliedCount: { increment: 1 }, lastAppliedAt: new Date() },
      });

      return {
        decision: action.decision,
        reason: action.reason ?? rule.name,
        ruleId: rule.id,
      };
    }
  }

  return null;
}

function matchesConditions(
  conditions: Record<string, unknown>,
  ctx: DecisionContext,
  risk: RiskOutput
): boolean {
  for (const [key, value] of Object.entries(conditions)) {
    switch (key) {
      case "minRiskScore":
        if (risk.score < (value as number)) return false;
        break;
      case "maxRiskScore":
        if (risk.score > (value as number)) return false;
        break;
      case "pincodes":
        if (!ctx.shippingPincode) return false;
        if (!(value as string[]).includes(ctx.shippingPincode)) return false;
        break;
      case "states":
        if (!ctx.shippingState) return false;
        if (!(value as string[]).includes(ctx.shippingState)) return false;
        break;
      case "minAOV":
        if (ctx.totalPrice < (value as number)) return false;
        break;
      case "maxAOV":
        if (ctx.totalPrice > (value as number)) return false;
        break;
      case "paymentMethod":
        if (ctx.paymentMethod !== value) return false;
        break;
      case "riskBand":
        if (risk.band !== value) return false;
        break;
    }
  }
  return true;
}

// ─── DB Helpers ───────────────────────────────────────────────────────────────
async function upsertOrder(
  ctx: DecisionContext,
  risk: RiskOutput,
  decision: Decision,
  reason: string
) {
  return db.order.upsert({
    where: {
      merchantId_shopifyOrderId: {
        merchantId: ctx.merchantId,
        shopifyOrderId: ctx.shopifyOrderId,
      },
    },
    update: {
      riskScore: risk.score,
      riskBand: risk.band,
      decision,
      decisionReason: reason,
      decisionAt: new Date(),
      status: decision === "SHIP" ? "PROCESSED" : "PENDING",
    },
    create: {
      merchantId: ctx.merchantId,
      shopifyOrderId: ctx.shopifyOrderId,
      shopifyOrderGid: ctx.shopifyOrderGid,
      orderNumber: ctx.orderNumber,
      totalPrice: ctx.totalPrice,
      currency: ctx.currency ?? "INR",
      customerPhone: ctx.customerPhone,
      customerEmail: ctx.customerEmail,
      customerId: ctx.customerId,
      shippingPincode: ctx.shippingPincode,
      shippingCity: ctx.shippingCity,
      shippingState: ctx.shippingState,
      paymentMethod: ctx.paymentMethod,
      riskScore: risk.score,
      riskBand: risk.band,
      decision,
      decisionReason: reason,
      decisionAt: new Date(),
      status: decision === "SHIP" ? "PROCESSED" : "PENDING",
    },
  });
}
