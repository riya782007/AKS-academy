/**
 * POST /webhooks — Shopify webhook receiver
 * GET  /webhooks — (unused, but required for Shopify validation)
 *
 * Enqueues jobs to QStash immediately (<5s). All processing happens in /api/worker.
 * Twilio WA replies now handled by /api/meta-webhook.
 */

import { authenticate } from "../shopify.server";
import {
  onOrderCreated,
  onOrderUpdated,
  onOrderCancelled,
  onOrderFulfilled,
  onAppUninstalled,
} from "../services/event-engine.server";
import type { ActionFunctionArgs } from "@remix-run/node";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, payload } = await authenticate.webhook(request);

  console.log(`[Webhook] ${topic} from ${shop}`);

  switch (topic) {
    case "ORDERS_CREATE":
      await onOrderCreated(payload, shop);
      break;
    case "ORDERS_UPDATED":
      await onOrderUpdated(payload, shop);
      break;
    case "ORDERS_CANCELLED":
      await onOrderCancelled(payload, shop);
      break;
    case "ORDERS_FULFILLED":
      await onOrderFulfilled(payload, shop);
      break;
    case "APP_UNINSTALLED":
      if (session) await onAppUninstalled(shop);
      break;
    default:
      console.warn(`[Webhook] Unhandled topic: ${topic}`);
  }

  return new Response("OK", { status: 200 });
};
