/**
 * ZeroLeak Risk Engine v2
 *
 * Pincode risk sourced from real merchant CSV uploads (MerchantPincode table).
 * No mock/static pincode data. Falls back to neutral score if no data exists.
 *
 * Weights (total 100):
 *   Pincode Risk     25 pts  — from merchant's own RTO data
 *   Prior RTO        30 pts  — customer's history with this merchant
 *   AOV Risk         15 pts  — high COD value
 *   Phone Heuristics 20 pts  — format/pattern signals
 *   Customer History 10 pts  — cancellations, account age
 *   COD Uplift       +10%   — applied after sum for all COD orders
 */

import { db } from "../utils/db.server";
import type { RiskBand, Decision } from "@prisma/client";

export interface RiskInput {
  merchantId: string;
  shopifyOrderId: string;
  customerPhone?: string | null;
  customerId?: string | null;
  shippingPincode?: string | null;
  totalPrice: number;
  paymentMethod: string;
}

export interface RiskOutput {
  score: number;
  band: RiskBand;
  decision: Decision;
  factors: RiskFactor[];
  reason: string;
}

interface RiskFactor {
  factor: string;
  score: number;
  detail: string;
}

const VOIP_PREFIXES = ["7000", "7001", "9000", "9001"];
const INVALID_REPEAT = /^(.)\1{8,}$/;
const LANDLINE = /^0\d{9,11}$/;

export async function scoreOrder(input: RiskInput): Promise<RiskOutput> {
  const [pincodeF, priorRtoF, aovF, phoneF, historyF] = await Promise.all([
    scorePincode(input.merchantId, input.shippingPincode),
    scorePriorRTO(input.merchantId, input.customerId, input.customerPhone),
    scoreAOV(input.totalPrice, input.paymentMethod),
    Promise.resolve(scorePhone(input.customerPhone)),
    scoreCustomerHistory(input.merchantId, input.customerId),
  ]);

  const factors: RiskFactor[] = [pincodeF, priorRtoF, aovF, phoneF, historyF];
  let total = factors.reduce((s, f) => s + f.score, 0);

  if (input.paymentMethod === "COD") {
    const uplift = Math.round(total * 0.1);
    total = Math.min(100, total + uplift);
    factors.push({ factor: "COD_UPLIFT", score: uplift, detail: "COD order 10% uplift" });
  }

  const score = Math.min(100, Math.max(0, total));
  const band = getBand(score);
  const decision = getDecision(band);

  return {
    score,
    band,
    decision,
    factors,
    reason: buildReason(factors, band),
  };
}

// ─── Pincode — real merchant data only ────────────────────────────────────────
async function scorePincode(
  merchantId: string,
  pincode?: string | null
): Promise<RiskFactor> {
  if (!pincode) {
    return { factor: "PINCODE", score: 10, detail: "No pincode — neutral default" };
  }

  const row = await db.merchantPincode.findUnique({
    where: { merchantId_pincode: { merchantId, pincode } },
    select: { rtoPercentage: true, totalOrders: true },
  });

  if (!row || row.totalOrders < 5) {
    // Not enough data — conservative neutral score
    return { factor: "PINCODE", score: 8, detail: `${pincode} — insufficient data (<5 orders)` };
  }

  const score = Math.round((row.rtoPercentage / 100) * 25);
  return {
    factor: "PINCODE",
    score,
    detail: `${pincode} — ${row.rtoPercentage.toFixed(1)}% RTO (${row.totalOrders} orders)`,
  };
}

// ─── Prior RTO ────────────────────────────────────────────────────────────────
async function scorePriorRTO(
  merchantId: string,
  customerId?: string | null,
  phone?: string | null
): Promise<RiskFactor> {
  if (!customerId && !phone) {
    return { factor: "PRIOR_RTO", score: 5, detail: "No customer identifier" };
  }

  const where = customerId
    ? { merchantId, customerId }
    : { merchantId, customerPhone: phone! };

  const [rtoCount, orderCount] = await Promise.all([
    db.order.count({ where: { ...where, isRTO: true } }),
    db.order.count({ where }),
  ]);

  if (orderCount === 0) return { factor: "PRIOR_RTO", score: 8, detail: "New customer" };

  const rate = rtoCount / orderCount;
  if (rtoCount >= 3) return { factor: "PRIOR_RTO", score: 30, detail: `${rtoCount} RTOs — serial returner` };
  if (rate >= 0.5) return { factor: "PRIOR_RTO", score: 24, detail: `${(rate * 100).toFixed(0)}% RTO rate` };
  if (rate >= 0.25) return { factor: "PRIOR_RTO", score: 15, detail: `${(rate * 100).toFixed(0)}% RTO rate` };
  if (rtoCount >= 1) return { factor: "PRIOR_RTO", score: 10, detail: `${rtoCount} prior RTO` };

  return { factor: "PRIOR_RTO", score: 0, detail: `Clean — ${orderCount} orders, 0 RTOs` };
}

// ─── AOV (COD only) ───────────────────────────────────────────────────────────
function scoreAOV(totalPrice: number, paymentMethod: string): RiskFactor {
  if (paymentMethod !== "COD") {
    return { factor: "AOV", score: 0, detail: "Prepaid — AOV N/A" };
  }
  if (totalPrice >= 5000) return { factor: "AOV", score: 15, detail: `₹${totalPrice} COD — very high` };
  if (totalPrice >= 2000) return { factor: "AOV", score: 10, detail: `₹${totalPrice} COD — high` };
  if (totalPrice >= 1000) return { factor: "AOV", score: 5, detail: `₹${totalPrice} COD — medium` };
  return { factor: "AOV", score: 2, detail: `₹${totalPrice} COD — low` };
}

// ─── Phone heuristics ─────────────────────────────────────────────────────────
function scorePhone(phone?: string | null): RiskFactor {
  if (!phone) return { factor: "PHONE", score: 15, detail: "No phone" };
  const cleaned = phone.replace(/\D/g, "").replace(/^91/, "");
  if (INVALID_REPEAT.test(cleaned)) return { factor: "PHONE", score: 20, detail: "Repeated digits" };
  if (LANDLINE.test(phone)) return { factor: "PHONE", score: 18, detail: "Landline detected" };
  if (VOIP_PREFIXES.some((p) => cleaned.startsWith(p))) return { factor: "PHONE", score: 14, detail: "VoIP prefix" };
  if (cleaned.length !== 10) return { factor: "PHONE", score: 12, detail: `Invalid length (${cleaned.length})` };
  return { factor: "PHONE", score: 0, detail: "Valid Indian mobile" };
}

// ─── Customer history ─────────────────────────────────────────────────────────
async function scoreCustomerHistory(
  merchantId: string,
  customerId?: string | null
): Promise<RiskFactor> {
  if (!customerId) return { factor: "HISTORY", score: 5, detail: "Guest checkout" };

  const orders = await db.order.findMany({
    where: { merchantId, customerId },
    select: { status: true },
    take: 50,
  });

  if (orders.length === 0) return { factor: "HISTORY", score: 4, detail: "No prior orders" };
  const cancels = orders.filter((o) => o.status === "CANCELLED").length;
  if (cancels >= 3) return { factor: "HISTORY", score: 10, detail: `${cancels} cancellations` };
  if (orders.length >= 5) return { factor: "HISTORY", score: 0, detail: `Loyal — ${orders.length} orders` };
  return { factor: "HISTORY", score: 2, detail: `${orders.length} prior orders` };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getBand(score: number): RiskBand {
  if (score <= 40) return "GREEN";
  if (score <= 70) return "AMBER";
  return "RED";
}

function getDecision(band: RiskBand): Decision {
  if (band === "GREEN") return "SHIP";
  if (band === "AMBER") return "VERIFY";
  return "HOLD";
}

function buildReason(factors: RiskFactor[], band: RiskBand): string {
  const top = [...factors].sort((a, b) => b.score - a.score).slice(0, 2);
  const labels: Record<RiskBand, string> = {
    GREEN: "Low risk — auto-ship",
    AMBER: "Medium risk — verify",
    RED: "High risk — hold",
  };
  return `${labels[band]}. ${top.map((f) => f.detail).join("; ")}`;
}
