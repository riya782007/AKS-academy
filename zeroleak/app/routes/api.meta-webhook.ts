/**
 * GET  /api/meta-webhook — Meta webhook verification (challenge)
 * POST /api/meta-webhook — Incoming WhatsApp messages, queued via QStash
 *
 * Messages are enqueued immediately and processed async by /api/worker
 * so high-volume ad campaigns never drop a message.
 */

import { json } from "@remix-run/node";
import { onMetaWebhook } from "../services/event-engine.server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";

// Meta GET verification challenge
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return json({ error: "Verification failed" }, { status: 403 });
};

// Meta POST — enqueue each entry to QStash for async processing
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

  const body = await request.json() as { entry?: unknown[] };

  // Enqueue all entries concurrently — respond to Meta within 200ms
  await Promise.all((body.entry ?? []).map((entry) => onMetaWebhook(entry)));

  return json({ ok: true });
};
