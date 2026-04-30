/**
 * POST /api/risk-score
 * External API endpoint for risk scoring (for integrations).
 * Authenticated by Shopify session or API key header.
 */

import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { scoreOrder } from "../services/risk-engine.server";
import { db } from "../utils/db.server";
import type { ActionFunctionArgs } from "@remix-run/node";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const merchant = await db.merchant.findUnique({ where: { shop: session.shop } });
  if (!merchant) return json({ error: "Merchant not found" }, { status: 404 });

  const body = await request.json();
  const { shopifyOrderId, customerPhone, customerId, shippingPincode, totalPrice, paymentMethod } = body;

  if (!shopifyOrderId || !totalPrice) {
    return json({ error: "shopifyOrderId and totalPrice are required" }, { status: 400 });
  }

  const result = await scoreOrder({
    merchantId: merchant.id,
    shopifyOrderId: String(shopifyOrderId),
    customerPhone,
    customerId,
    shippingPincode,
    totalPrice: Number(totalPrice),
    paymentMethod: paymentMethod ?? "COD",
  });

  return json({
    score: result.score,
    band: result.band,
    decision: result.decision,
    reason: result.reason,
    factors: result.factors,
  });
};
