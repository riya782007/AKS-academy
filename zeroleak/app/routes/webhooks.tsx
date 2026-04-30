import { authenticate } from "../shopify.server";
import {
  onOrderCreated,
  onOrderUpdated,
  onOrderCancelled,
  onOrderFulfilled,
  onAppUninstalled,
} from "../services/event-engine.server";
import { handleIncomingReply } from "../services/whatsapp.server";
import type { ActionFunctionArgs } from "@remix-run/node";

export const action = async ({ request }: ActionFunctionArgs) => {
  // WhatsApp reply from Twilio (different auth mechanism)
  const url = new URL(request.url);
  if (url.searchParams.get("source") === "twilio") {
    return handleTwilioWebhook(request);
  }

  // Shopify webhooks
  const { topic, shop, session, payload, admin } =
    await authenticate.webhook(request);

  console.log(`[Webhook] ${topic} from ${shop}`);

  switch (topic) {
    case "ORDERS_CREATE":
      await onOrderCreated(payload as never, shop);
      break;
    case "ORDERS_UPDATED":
      await onOrderUpdated(payload as never, shop);
      break;
    case "ORDERS_CANCELLED":
      await onOrderCancelled(payload as never, shop);
      break;
    case "ORDERS_FULFILLED":
      await onOrderFulfilled(payload as never, shop);
      break;
    case "APP_UNINSTALLED":
      if (session) {
        await onAppUninstalled(shop);
      }
      break;
    default:
      console.warn(`[Webhook] Unhandled topic: ${topic}`);
  }

  return new Response("OK", { status: 200 });
};

async function handleTwilioWebhook(request: Request): Promise<Response> {
  const formData = await request.formData();
  const from = formData.get("From") as string;
  const body = formData.get("Body") as string;
  const messageSid = formData.get("MessageSid") as string;

  if (!from || !body) {
    return new Response("Bad Request", { status: 400 });
  }

  await handleIncomingReply({ from, body, messageSid });

  // Twilio expects TwiML response
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
