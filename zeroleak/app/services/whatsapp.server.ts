/**
 * ZeroLeak WhatsApp Service — Meta Cloud API
 *
 * Uses the official Meta Graph API v18.0 via native fetch.
 * No Twilio dependency. Per-merchant phone ID + token with env fallback.
 *
 * Template: cod_verification_v1
 *   - Quick reply button 1: "Confirm Order"
 *   - Quick reply button 2: "Cancel Order"
 */

import { db } from "../utils/db.server";

const META_GRAPH_VERSION = "v18.0";

interface MetaConfig {
  phoneId: string;
  accessToken: string;
}

// ─── Resolve per-merchant Meta config (falls back to env) ─────────────────────
async function getMetaConfig(merchantId: string): Promise<MetaConfig> {
  const merchant = await db.merchant.findUnique({
    where: { id: merchantId },
    select: { metaPhoneId: true, metaAccessToken: true },
  });

  const phoneId = merchant?.metaPhoneId ?? process.env.META_PHONE_ID;
  const accessToken = merchant?.metaAccessToken ?? process.env.META_ACCESS_TOKEN;

  if (!phoneId || !accessToken) {
    throw new Error(`Meta credentials not configured for merchant ${merchantId}`);
  }

  return { phoneId, accessToken };
}

// ─── Send COD verification template ──────────────────────────────────────────
export async function sendVerificationMessage({
  orderId,
  merchantId,
  phone,
  orderNumber,
  totalPrice,
  merchantName,
}: {
  orderId: string;
  merchantId: string;
  phone: string;
  orderNumber: string;
  totalPrice: string;
  merchantName: string;
}): Promise<{ waMessageId: string; verificationId: string }> {
  const { phoneId, accessToken } = await getMetaConfig(merchantId);
  const to = normalisePhone(phone);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: "cod_verification_v1",
      language: { code: "en" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: merchantName },
            { type: "text", text: orderNumber },
            { type: "text", text: `₹${totalPrice}` },
          ],
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "0",
          parameters: [{ type: "payload", payload: `CONFIRM_${orderId}` }],
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "1",
          parameters: [{ type: "payload", payload: `CANCEL_${orderId}` }],
        },
      ],
    },
  };

  const res = await callMetaAPI(phoneId, accessToken, payload);
  const waMessageId = res.messages?.[0]?.id ?? "";

  const verification = await db.verification.create({
    data: {
      orderId,
      merchantId,
      type: "WHATSAPP",
      channel: "WHATSAPP",
      phone,
      waMessageId,
      status: "SENT",
      sentAt: new Date(),
      expiresAt,
      attempts: 1,
    },
  });

  return { waMessageId, verificationId: verification.id };
}

// ─── Send token advance message with Razorpay payment link ───────────────────
export async function sendTokenAdvanceMessage({
  orderId,
  merchantId,
  phone,
  orderNumber,
  totalPrice,
  paymentLink,
  tokenAmount,
  merchantName,
}: {
  orderId: string;
  merchantId: string;
  phone: string;
  orderNumber: string;
  totalPrice: string;
  paymentLink: string;
  tokenAmount: number;
  merchantName: string;
}): Promise<void> {
  const { phoneId, accessToken } = await getMetaConfig(merchantId);
  const to = normalisePhone(phone);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  // Fallback to text message if template not available for token advance
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: {
      preview_url: false,
      body:
        `Hi! Your order ${orderNumber} (₹${totalPrice}) from *${merchantName}* requires a ₹${tokenAmount} refundable token to confirm delivery.\n\n` +
        `Pay here: ${paymentLink}\n\n` +
        `This token is fully refunded on successful delivery.`,
    },
  };

  const res = await callMetaAPI(phoneId, accessToken, payload);
  const waMessageId = res.messages?.[0]?.id ?? "";

  await db.verification.create({
    data: {
      orderId,
      merchantId,
      type: "TOKEN_ADVANCE",
      channel: "WHATSAPP",
      phone,
      waMessageId,
      paymentLink,
      status: "SENT",
      sentAt: new Date(),
      expiresAt,
      attempts: 1,
    },
  });
}

// ─── Handle incoming webhook reply from Meta ──────────────────────────────────
export async function handleMetaWebhookReply(
  entry: MetaWebhookEntry
): Promise<void> {
  const changes = entry.changes ?? [];

  for (const change of changes) {
    const messages = change.value?.messages ?? [];
    for (const msg of messages) {
      if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
        await processButtonReply(msg);
      }
    }
  }
}

async function processButtonReply(msg: MetaMessage): Promise<void> {
  const payload = msg.interactive?.button_reply?.payload ?? "";
  const from = msg.from;

  if (payload.startsWith("CONFIRM_")) {
    const orderId = payload.replace("CONFIRM_", "");
    await resolveVerification(orderId, from, "CONFIRMED");
  } else if (payload.startsWith("CANCEL_")) {
    const orderId = payload.replace("CANCEL_", "");
    await resolveVerification(orderId, from, "REJECTED");
  }
}

async function resolveVerification(
  orderId: string,
  phone: string,
  status: "CONFIRMED" | "REJECTED"
): Promise<void> {
  await db.verification.updateMany({
    where: { orderId, status: "SENT" },
    data: { status, respondedAt: new Date() },
  });

  await db.order.update({
    where: { id: orderId },
    data: {
      status: status === "CONFIRMED" ? "PROCESSED" : "CANCELLED",
      decision: status === "CONFIRMED" ? "SHIP" : "HOLD",
    },
  });
}

// ─── Expire stale verifications ───────────────────────────────────────────────
export async function expireStaleVerifications(): Promise<number> {
  const result = await db.verification.updateMany({
    where: { status: "SENT", expiresAt: { lt: new Date() } },
    data: { status: "EXPIRED" },
  });
  return result.count;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────
async function callMetaAPI(
  phoneId: string,
  accessToken: string,
  payload: object
): Promise<{ messages?: { id: string }[] }> {
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneId}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta API ${res.status}: ${err}`);
  }

  return res.json() as Promise<{ messages?: { id: string }[] }>;
}

function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) return digits;
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface MetaWebhookEntry {
  changes?: {
    value?: {
      messages?: MetaMessage[];
    };
  }[];
}

interface MetaMessage {
  from: string;
  type: string;
  interactive?: {
    type: string;
    button_reply?: { payload: string; title: string };
  };
}
