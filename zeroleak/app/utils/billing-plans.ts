export const PLANS = {
  FREE: {
    name: "Free",
    shopifyPlanName: "" as string,
    price: 0,
    currency: "USD",
    trialDays: 0,
    verificationLimit: 50,
    features: [
      "50 verifications / month",
      "Risk scoring dashboard",
      "Manual Ship / Hold swipe",
    ],
    unlocks: {
      autopilot: false,
      aiRules: false,
      razorpay: false,
    },
  },
  GROWTH: {
    name: "Growth",
    shopifyPlanName: "ZeroLeak Growth",
    price: 9.99,
    currency: "USD",
    trialDays: 0,
    verificationLimit: 300,
    features: [
      "300 verifications / month",
      "WhatsApp auto-verification",
      "Basic Autopilot (Hold / Ship)",
      "Risk engine dashboard",
    ],
    unlocks: {
      autopilot: true,
      aiRules: false,
      razorpay: false,
    },
  },
  PRO: {
    name: "Pro",
    shopifyPlanName: "ZeroLeak Pro",
    price: 19.99,
    currency: "USD",
    trialDays: 7,
    verificationLimit: 1000,
    features: [
      "1,000 verifications / month",
      "Everything in Growth",
      "Advanced AI Rules (NL parser)",
      "Razorpay Token Advance Engine",
      "Priority support",
    ],
    unlocks: {
      autopilot: true,
      aiRules: true,
      razorpay: true,
    },
  },
} as const;

export type PlanKey = keyof typeof PLANS;
