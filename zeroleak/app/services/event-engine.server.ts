/**
 * ZeroLeak Event Engine — Upstash QStash
 *
 * Replaces BullMQ/Redis with QStash for Vercel serverless compatibility.
 *
 * Flow:
 *   Shopify webhook → /webhooks (responds <5s) → QStash.publishJSON()
 *   QStash → POST /api/worker (up to 300s, 3 retries, exponential backoff)
 */

import { Client as QStashClient } from "@upstash/qstash";

function getQStashClient(): QStashClient {
  if (!process.env.QSTASH_TOKEN) {
    throw new Error("QSTASH_TOKEN is not set");
  }
  return new QStashClient({ token: process.env.QSTASH_TOKEN });
}

export type WorkerJobType =
  | "orders/create"
  | "orders/updated"
  | "orders/cancelled"
  | "orders/fulfilled"
  | "app/uninstalled";

export interface WorkerJob {
  type: WorkerJobType;
  shop: string;
  payload: unknown;
}

// ─── Enqueue to QStash ────────────────────────────────────────────────────────
async function enqueue(job: WorkerJob): Promise<void> {
  const client = getQStashClient();
  const workerUrl = `${process.env.SHOPIFY_APP_URL}/api/worker`;

  await client.publishJSON({
    url: workerUrl,
    body: job,
    retries: 3,
    delay: 0,
  });
}

// ─── Public event dispatchers (called from /webhooks route) ───────────────────
export const onOrderCreated = (payload: unknown, shop: string) =>
  enqueue({ type: "orders/create", shop, payload });

export const onOrderUpdated = (payload: unknown, shop: string) =>
  enqueue({ type: "orders/updated", shop, payload });

export const onOrderCancelled = (payload: unknown, shop: string) =>
  enqueue({ type: "orders/cancelled", shop, payload });

export const onOrderFulfilled = (payload: unknown, shop: string) =>
  enqueue({ type: "orders/fulfilled", shop, payload });

export const onAppUninstalled = (shop: string) =>
  enqueue({ type: "app/uninstalled", shop, payload: {} });
