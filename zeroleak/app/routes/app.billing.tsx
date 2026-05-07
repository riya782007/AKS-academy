/**
 * ZeroLeak Billing — Shopify Billing API (USD)
 *
 * Free ($0)    : 50 verifications/month. Manual only.
 * Growth ($9.99): 300/month. Autopilot.
 * Pro ($19.99)  : 1,000/month. AI Rules + Razorpay. 7-day trial.
 */

import { json, redirect } from "@remix-run/node";
import { useLoaderData, useSubmit } from "@remix-run/react";
import {
  Page, Layout, Card, Text, BlockStack, InlineStack,
  Badge, Button, List, Divider, Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../utils/db.server";
import { requestPlanUpgrade } from "../services/billing.server";
import { PLANS, type PlanKey } from "../utils/billing-plans";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const merchant = await db.merchant.findUnique({
    where: { shop: session.shop },
    select: { plan: true, verificationsUsed: true },
  });

  return json({
    currentPlan: (merchant?.plan ?? "FREE") as PlanKey,
    verificationsUsed: merchant?.verificationsUsed ?? 0,
    plans: Object.entries(PLANS).map(([key, p]) => ({
      key: key as PlanKey,
      name: p.name,
      price: p.price,
      trialDays: p.trialDays,
      verificationLimit: p.verificationLimit,
      features: p.features,
    })),
  });
};

export const action = async (args: ActionFunctionArgs) => {
  const formData = await args.request.formData();
  const plan = formData.get("plan") as PlanKey;

  if (plan === "FREE") {
    const { session } = await authenticate.admin(args.request);
    await db.merchant.update({
      where: { shop: session.shop },
      data: { plan: "FREE", planActivatedAt: null },
    });
    return json({ success: true });
  }

  const confirmationUrl = await requestPlanUpgrade(args, plan);
  return redirect(confirmationUrl);
};

export default function Billing() {
  const { currentPlan, verificationsUsed, plans } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const currentConfig = PLANS[currentPlan];

  return (
    <Page title="Plans & Billing" subtitle="All prices in USD. Cancel anytime.">
      <Layout>
        {/* Usage summary */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h3">This Month's Usage</Text>
                <Badge tone={currentPlan === "FREE" ? "attention" : "success"}>
                  {currentPlan}
                </Badge>
              </InlineStack>
              <Text as="p" variant="bodyMd">
                <strong>{verificationsUsed}</strong> / {currentConfig.verificationLimit} verifications used
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Plan cards */}
        {plans.map((plan) => {
          const isCurrent = currentPlan === plan.key;
          const isDowngrade =
            (currentPlan === "PRO" && plan.key !== "PRO") ||
            (currentPlan === "GROWTH" && plan.key === "FREE");

          return (
            <Layout.Section variant="oneThird" key={plan.key}>
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text variant="headingMd" as="h3">{plan.name}</Text>
                    {isCurrent && <Badge tone="success">Current</Badge>}
                    {plan.key === "PRO" && !isCurrent && (
                      <Badge tone="attention">Most Popular</Badge>
                    )}
                  </InlineStack>

                  <BlockStack gap="100">
                    <Text variant="heading2xl" as="p" fontWeight="bold">
                      {plan.price === 0 ? "Free" : `$${plan.price}`}
                    </Text>
                    {plan.price > 0 && (
                      <Text variant="bodySm" tone="subdued" as="p">per month</Text>
                    )}
                    {plan.trialDays > 0 && (
                      <Text variant="bodySm" tone="success" as="p">
                        {plan.trialDays}-day free trial
                      </Text>
                    )}
                  </BlockStack>

                  <Divider />

                  <List>
                    {plan.features.map((f) => (
                      <List.Item key={f}>{f}</List.Item>
                    ))}
                  </List>

                  <Button
                    variant={isCurrent ? "secondary" : "primary"}
                    disabled={isCurrent}
                    tone={isDowngrade ? "critical" : undefined}
                    onClick={() => submit({ plan: plan.key }, { method: "POST" })}
                    fullWidth
                  >
                    {isCurrent
                      ? "Current Plan"
                      : isDowngrade
                      ? "Downgrade"
                      : plan.trialDays > 0
                      ? `Start ${plan.trialDays}-Day Trial`
                      : "Upgrade"}
                  </Button>
                </BlockStack>
              </Card>
            </Layout.Section>
          );
        })}
      </Layout>
    </Page>
  );
}
