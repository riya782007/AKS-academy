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
import { PLANS, type PlanKey } from "../utils/billing-plans";

export { PLANS, type PlanKey };

// ─── Initiate plan upgrade (returns Shopify billing confirmation URL) ──────────
export async function requestPlanUpgrade(
  args: ActionFunctionArgs,
  plan: PlanKey
): Promise<string> {
  const { billing, session } = await authenticate.admin(args.request);
  const config = PLANS[plan];

  if (!config.shopifyPlanName) throw new Error("Cannot upgrade to Free via billing API");
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await (billing as any).request({
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
