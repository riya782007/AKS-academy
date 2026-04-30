/**
 * ZeroLeak Billing — Shopify Billing API (USD)
 *
 * Free   : 50 verifications/month. Manual swipe UI only.
 * Growth : $9.99/mo — 300 verifications. Basic Autopilot (Hold/Ship).
 * Pro    : $19.99/mo — 1,000 verifications. AI Rules + Razorpay. 7-day trial.
 */

import { authenticate } from "../shopify.server";
import { db } from "../utils/db.server";
import type { ActionFunctionArgs } from "@remix-run/node";

export const PLANS = {
  FREE: {
    name: "Free",
    shopifyPlanName: null,
    price: 0,
    currency: "USD",
    trialDays: 0,
    verificationLimit: 50,
    features: [
      "50 verifications / month",
      "Risk scoring dashboard",
      "Manual Ship / Hold swipe",
    ],
    unlocks: {
      autopilot: false,
      aiRules: false,
      razorpay: false,
    },
  },
  GROWTH: {
    name: "Growth",
    shopifyPlanName: "ZeroLeak Growth",
    price: 9.99,
    currency: "USD",
    trialDays: 0,
    verificationLimit: 300,
    features: [
      "300 verifications / month",
      "WhatsApp auto-verification",
      "Basic Autopilot (Hold / Ship)",
      "Risk engine dashboard",
    ],
    unlocks: {
      autopilot: true,
      aiRules: false,
      razorpay: false,
    },
  },
  PRO: {
    name: "Pro",
    shopifyPlanName: "ZeroLeak Pro",
    price: 19.99,
    currency: "USD",
    trialDays: 7,
    verificationLimit: 1000,
    features: [
      "1,000 verifications / month",
      "Everything in Growth",
      "Advanced AI Rules (NL parser)",
      "Razorpay Token Advance Engine",
      "Priority support",
    ],
    unlocks: {
      autopilot: true,
      aiRules: true,
      razorpay: true,
    },
  },
} as const;

export type PlanKey = keyof typeof PLANS;

// ─── Initiate plan upgrade (returns Shopify billing confirmation URL) ──────────
export async function requestPlanUpgrade(
  args: ActionFunctionArgs,
  plan: PlanKey
): Promise<string> {
  const { billing, session } = await authenticate.admin(args.request);
  const config = PLANS[plan];

  if (!config.shopifyPlanName) throw new Error("Cannot upgrade to Free via billing API");

  const response = await billing.request({
    plan: config.shopifyPlanName,
    isTest: process.env.NODE_ENV !== "production",
    trialDays: config.trialDays,
  });

  return (response as { confirmationUrl: string }).confirmationUrl;
}

// ─── Confirm active subscription after redirect ────────────────────────────────
export async function confirmPlanActivation(
  args: ActionFunctionArgs,
  plan: PlanKey
): Promise<void> {
  const { session } = await authenticate.admin(args.request);

  await db.merchant.update({
    where: { shop: session.shop },
    data: {
      plan,
      planActivatedAt: new Date(),
      billingCycleStart: new Date(),
      verificationsUsed: 0,
    },
  });
}

// ─── Check if merchant can perform a verification ────────────────────────────
export async function canVerify(merchantId: string): Promise<{
  allowed: boolean;
  plan: PlanKey;
  used: number;
  limit: number;
}> {
  const merchant = await db.merchant.findUnique({
    where: { id: merchantId },
    select: { plan: true, verificationsUsed: true, billingCycleStart: true },
  });

  const plan = (merchant?.plan ?? "FREE") as PlanKey;
  const limit = PLANS[plan].verificationLimit;
  const used = merchant?.verificationsUsed ?? 0;

  return { allowed: used < limit, plan, used, limit };
}

// ─── Increment verification usage counter ─────────────────────────────────────
export async function incrementVerificationCount(merchantId: string): Promise<void> {
  await db.merchant.update({
    where: { id: merchantId },
    data: { verificationsUsed: { increment: 1 } },
  });
}

// ─── Reset usage on billing cycle renewal (called from worker) ────────────────
export async function resetMonthlyCycle(merchantId: string): Promise<void> {
  await db.merchant.update({
    where: { id: merchantId },
    data: { verificationsUsed: 0, billingCycleStart: new Date() },
  });
}
