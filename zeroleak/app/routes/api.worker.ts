/**
 * ZeroLeak QStash Worker — POST /api/worker
 *
 * QStash calls this endpoint (with signature verification) to process
 * Shopify order events asynchronously. Vercel max duration: 300s.
 *
 * Replaces BullMQ order-processor.server.ts entirely.
 */

import { json } from "@remix-run/node";
import { Receiver } from "@upstash/qstash";
import { db } from "../utils/db.server";
import { processOrder } from "../services/decision-engine.server";
import { sendVerificationMessage, sendTokenAdvanceMessage } from "../services/whatsapp.server";
import { createTokenAdvanceLink } from "../services/payment.server";
import { canVerify, incrementVerificationCount } from "../services/billing.server";
import type { ActionFunctionArgs } from "@remix-run/node";
import type { WorkerJob } from "../services/event-engine.server";

// COD gateway detection — case-insensitive
const COD_GATEWAYS = new Set([
  "cash on delivery",
  "cod",
  "cash on delivery (cod)",
  "pay on delivery",
  "manual",
]);

function isCOD(gatewayNames: string[]): boolean {
  return gatewayNames.some((g) => COD_GATEWAYS.has(g.toLowerCase().trim()));
}

// ─── QStash signature verifier ────────────────────────────────────────────────
function getReceiver(): Receiver {
  return new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY!,
  });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  // Verify QStash signature
  const body = await request.text();
  const signature = request.headers.get("upstash-signature") ?? "";

  try {
    const receiver = getReceiver();
    await receiver.verify({ signature, body });
  } catch {
    return json({ error: "Invalid QStash signature" }, { status: 401 });
  }

  const job: WorkerJob = JSON.parse(body);

  try {
    await handleJob(job);
    return json({ ok: true });
  } catch (err) {
    console.error(`[Worker] Job failed: ${job.type}`, err);
    // Return 500 so QStash retries
    return json({ error: (err as Error).message }, { status: 500 });
  }
};

// ─── Job router ───────────────────────────────────────────────────────────────
async function handleJob(job: WorkerJob): Promise<void> {
  switch (job.type) {
    case "orders/create":
      await handleOrderCreate(job.payload as ShopifyOrder, job.shop);
      break;
    case "orders/updated":
      await handleOrderUpdate(job.payload as ShopifyOrder);
      break;
    case "orders/cancelled":
      await handleOrderCancel(job.payload as ShopifyOrder);
      break;
    case "orders/fulfilled":
      await handleOrderFulfil(job.payload as ShopifyOrder);
      break;
    case "app/uninstalled":
      await handleUninstall(job.shop);
      break;
  }
}

async function handleOrderCreate(order: ShopifyOrder, shop: string): Promise<void> {
  const merchant = await db.merchant.findUnique({ where: { shop } });
  if (!merchant) return;

  // Detect payment method from gateway names array
  const gatewayNames: string[] = order.payment_gateway_names ?? [order.payment_gateway ?? ""];
  const paymentMethod = isCOD(gatewayNames) ? "COD" : "PREPAID";

  const phone =
    order.customer?.phone ??
    order.shipping_address?.phone ??
    order.billing_address?.phone;
  const pincode = order.shipping_address?.zip ?? order.billing_address?.zip;

  // Run risk + decision engine
  const result = await processOrder({
    merchantId: merchant.id,
    shopifyOrderId: String(order.id),
    shopifyOrderGid: order.admin_graphql_api_id,
    orderNumber: order.name,
    customerId: order.customer?.id ? String(order.customer.id) : undefined,
    customerPhone: phone,
    customerEmail: order.customer?.email,
    shippingPincode: pincode,
    shippingCity: order.shipping_address?.city,
    shippingState: order.shipping_address?.province,
    totalPrice: parseFloat(order.total_price),
    paymentMethod,
    currency: order.currency,
  });

  console.log(`[Worker] ${order.name} → ${result.decision} (score ${result.riskScore})`);

  // ── VERIFY: send WhatsApp verification ────────────────────────────────────
  if (result.decision === "VERIFY" && phone) {
    const { allowed } = await canVerify(merchant.id);
    if (allowed) {
      const dbOrder = await db.order.findFirst({
        where: { shopifyOrderId: String(order.id), merchantId: merchant.id },
      });
      if (dbOrder) {
        await sendVerificationMessage({
          orderId: dbOrder.id,
          merchantId: merchant.id,
          phone,
          orderNumber: order.name,
          totalPrice: order.total_price,
          merchantName: merchant.name ?? shop,
        });
        await incrementVerificationCount(merchant.id);
      }
    }
  }

  // ── HOLD: Pro → token advance link; others → plain WA hold message ────────
  if (result.decision === "HOLD" && phone) {
    const dbOrder = await db.order.findFirst({
      where: { shopifyOrderId: String(order.id), merchantId: merchant.id },
    });
    if (dbOrder) {
      if (merchant.plan === "PRO" && merchant.razorpayKeyId) {
        try {
          const { paymentLink } = await createTokenAdvanceLink(
            merchant.id,
            dbOrder.id,
            merchant.tokenAdvanceAmount,
            phone,
            order.name
          );
          await sendTokenAdvanceMessage({
            orderId: dbOrder.id,
            merchantId: merchant.id,
            phone,
            orderNumber: order.name,
            totalPrice: order.total_price,
            paymentLink,
            tokenAmount: merchant.tokenAdvanceAmount,
            merchantName: merchant.name ?? shop,
          });
          await incrementVerificationCount(merchant.id);
        } catch (err) {
          console.error(`[Worker] Token advance failed for ${order.name}:`, err);
        }
      }
    }
  }

  // Update daily profit ledger
  await updateLedger(merchant.id, result.decision);
}

async function handleOrderUpdate(order: ShopifyOrder): Promise<void> {
  if (order.fulfillment_status === "fulfilled") {
    await db.order.updateMany({
      where: { shopifyOrderId: String(order.id) },
      data: { status: "SHIPPED" },
    });
  }
}

async function handleOrderCancel(order: ShopifyOrder): Promise<void> {
  await db.order.updateMany({
    where: { shopifyOrderId: String(order.id) },
    data: { status: "CANCELLED" },
  });
}

async function handleOrderFulfil(order: ShopifyOrder): Promise<void> {
  await db.order.updateMany({
    where: { shopifyOrderId: String(order.id) },
    data: { status: "SHIPPED" },
  });
}

async function handleUninstall(shop: string): Promise<void> {
  await db.merchant.update({
    where: { shop },
    data: { plan: "FREE" },
  });
}

async function updateLedger(merchantId: string, decision: string): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const inc = (field: string) => ({ [field]: { increment: 1 } });

  await db.profitLedgerEntry.upsert({
    where: { merchantId_date: { merchantId, date: today } },
    update: {
      ordersTotal: { increment: 1 },
      ...(decision === "SHIP" ? inc("shippedCount") : {}),
      ...(decision === "VERIFY" ? inc("verifiedCount") : {}),
      ...(decision === "HOLD"
        ? { heldCount: { increment: 1 }, rtoPrevented: { increment: 1 }, profitSaved: { increment: 150 } }
        : {}),
    },
    create: {
      merchantId,
      date: today,
      ordersTotal: 1,
      shippedCount: decision === "SHIP" ? 1 : 0,
      verifiedCount: decision === "VERIFY" ? 1 : 0,
      heldCount: decision === "HOLD" ? 1 : 0,
      rtoPrevented: decision === "HOLD" ? 1 : 0,
      profitSaved: decision === "HOLD" ? 150 : 0,
    },
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface ShopifyOrder {
  id: number;
  admin_graphql_api_id: string;
  name: string;
  total_price: string;
  currency: string;
  payment_gateway: string;
  payment_gateway_names?: string[];
  fulfillment_status: string | null;
  customer?: { id: number; email?: string; phone?: string };
  billing_address?: { phone?: string; zip?: string; city?: string; province?: string };
  shipping_address?: { phone?: string; zip?: string; city?: string; province?: string };
}
