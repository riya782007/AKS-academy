/**
 * Seed script — minimal global setup.
 * Pincode data now comes from merchant CSV uploads (MerchantPincode table).
 * This seed only ensures the DB is in a clean initial state.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  console.log("Seed complete — no global data to seed.");
  console.log("Merchants upload their own pincode CSV data via Settings.");
}

main().catch(console.error).finally(() => db.$disconnect());
