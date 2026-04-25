/**
 * Seed global pincode risk data
 * Real data should come from logistics partners (Delhivery, Shiprocket, DTDC)
 * This is illustrative — replace with actual RTO rate data
 */

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const HIGH_RTO_PINCODES = [
  // Bihar
  { pincode: "800001", city: "Patna", state: "Bihar", rtoRate: 0.42 },
  { pincode: "842001", city: "Muzaffarpur", state: "Bihar", rtoRate: 0.45 },
  // Jharkhand
  { pincode: "834001", city: "Ranchi", state: "Jharkhand", rtoRate: 0.38 },
  // UP
  { pincode: "226001", city: "Lucknow", state: "Uttar Pradesh", rtoRate: 0.31 },
  { pincode: "208001", city: "Kanpur", state: "Uttar Pradesh", rtoRate: 0.35 },
  // West Bengal (rural)
  { pincode: "712101", city: "Hooghly", state: "West Bengal", rtoRate: 0.29 },
];

const LOW_RTO_PINCODES = [
  // Mumbai
  { pincode: "400001", city: "Fort", state: "Maharashtra", rtoRate: 0.08 },
  { pincode: "400051", city: "Bandra", state: "Maharashtra", rtoRate: 0.07 },
  // Delhi NCR
  { pincode: "110001", city: "Connaught Place", state: "Delhi", rtoRate: 0.09 },
  { pincode: "122001", city: "Gurgaon", state: "Haryana", rtoRate: 0.06 },
  // Bangalore
  { pincode: "560001", city: "MG Road", state: "Karnataka", rtoRate: 0.07 },
  { pincode: "560071", city: "Whitefield", state: "Karnataka", rtoRate: 0.05 },
];

function getRiskBand(rtoRate: number): "GREEN" | "AMBER" | "RED" {
  if (rtoRate < 0.15) return "GREEN";
  if (rtoRate < 0.30) return "AMBER";
  return "RED";
}

async function main() {
  const allPincodes = [...HIGH_RTO_PINCODES, ...LOW_RTO_PINCODES];

  for (const p of allPincodes) {
    await db.pincodeRisk.upsert({
      where: { merchantId_pincode: { merchantId: null as never, pincode: p.pincode } },
      update: { rtoRate: p.rtoRate, riskLevel: getRiskBand(p.rtoRate) },
      create: {
        pincode: p.pincode,
        city: p.city,
        state: p.state,
        rtoRate: p.rtoRate,
        riskLevel: getRiskBand(p.rtoRate),
        sampleSize: 500,
      },
    });
  }

  console.log(`Seeded ${allPincodes.length} pincode risk records.`);
}

main()
  .catch(console.error)
  .finally(() => db.$disconnect());
