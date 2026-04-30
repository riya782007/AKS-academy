/**
 * POST /api/verify
 * Manually trigger WhatsApp verification for an order.
 */

import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { sendVerificationMessage } from "../services/whatsapp.server";
import { db } from "../utils/db.server";
import type { ActionFunctionArgs } from "@remix-run/node";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const merchant = await db.merchant.findUnique({ where: { shop: session.shop } });
  if (!merchant) return json({ error: "Merchant not found" }, { status: 404 });

  if (merchant.plan === "FREE") {
    return json({ error: "WhatsApp verification requires Growth or Pro plan." }, { status: 403 });
  }

  const body = await request.json();
  const { orderId, phone, orderNumber, totalPrice } = body;

  if (!orderId || !phone || !orderNumber || !totalPrice) {
    return json({ error: "orderId, phone, orderNumber, totalPrice are required" }, { status: 400 });
  }

  const order = await db.order.findFirst({ where: { id: orderId, merchantId: merchant.id } });
  if (!order) return json({ error: "Order not found" }, { status: 404 });

  const result = await sendVerificationMessage({
    orderId,
    merchantId: merchant.id,
    phone,
    orderNumber,
    totalPrice: String(totalPrice),
    merchantName: merchant.name ?? merchant.shop,
  });

  return json({ success: true, verificationId: result.verificationId });
};
