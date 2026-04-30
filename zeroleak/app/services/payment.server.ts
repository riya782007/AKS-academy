/**
 * ZeroLeak Payment Service — Razorpay Token Advance Engine (Pro only)
 *
 * CRITICAL DESIGN: No global Razorpay instance.
 * Each call looks up the specific merchant's keys from the DB,
 * initialises a scoped Razorpay instance, creates the link,
 * and the money lands directly in that merchant's Razorpay account.
 */

import Razorpay from "razorpay";
import { db } from "../utils/db.server";

interface TokenAdvanceResult {
  paymentLink: string;
  razorpayLinkId: string;
}

export async function createTokenAdvanceLink(
  merchantId: string,
  orderId: string,
  amountRupees: number,
  phone: string,
  orderNumber: string
): Promise<TokenAdvanceResult> {
  // 1. Look up this merchant's Razorpay credentials from DB
  const merchant = await db.merchant.findUnique({
    where: { id: merchantId },
    select: {
      razorpayKeyId: true,
      razorpayKeySecret: true,
      name: true,
      plan: true,
    },
  });

  if (merchant?.plan !== "PRO") {
    throw new Error("Token advance engine is a Pro plan feature");
  }

  if (!merchant.razorpayKeyId || !merchant.razorpayKeySecret) {
    throw new Error(
      `Razorpay keys not configured for merchant ${merchantId}. Add them in Settings → Integrations.`
    );
  }

  // 2. Initialise a scoped Razorpay instance using ONLY this merchant's keys
  const rzp = new Razorpay({
    key_id: merchant.razorpayKeyId,
    key_secret: merchant.razorpayKeySecret,
  });

  // 3. Create payment link (amount in paise)
  const amountPaise = amountRupees * 100;

  const link = await rzp.paymentLink.create({
    amount: amountPaise,
    currency: "INR",
    accept_partial: false,
    description: `Refundable advance for order ${orderNumber}`,
    customer: {
      contact: normalisePhone(phone),
    },
    notify: {
      sms: true,
      email: false,
    },
    reminder_enable: true,
    notes: {
      orderId,
      orderNumber,
      merchantId,
      type: "token_advance",
    },
    callback_url: `${process.env.SHOPIFY_APP_URL}/api/payment-callback?orderId=${orderId}`,
    callback_method: "get",
  });

  return {
    paymentLink: link.short_url as string,
    razorpayLinkId: link.id as string,
  };
}

// ─── Handle Razorpay payment webhook (token paid) ────────────────────────────
export async function handlePaymentWebhook(
  orderId: string,
  status: "paid" | "cancelled" | "expired"
): Promise<void> {
  if (status === "paid") {
    await db.order.update({
      where: { id: orderId },
      data: { status: "PROCESSED", decision: "SHIP" },
    });
    await db.verification.updateMany({
      where: { orderId, type: "TOKEN_ADVANCE" },
      data: { status: "CONFIRMED", respondedAt: new Date() },
    });
  } else {
    await db.verification.updateMany({
      where: { orderId, type: "TOKEN_ADVANCE", status: "SENT" },
      data: { status: status === "expired" ? "EXPIRED" : "REJECTED" },
    });
  }
}

function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}
