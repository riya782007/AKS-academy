/**
 * ZeroLeak Shield Home — Module 1
 *
 * Protected Today dashboard, Profit Ledger, Autopilot Status.
 * Polaris UI. All data server-loaded, no client-side fetching.
 */

import { json } from "@remix-run/node";
import { useLoaderData, useSubmit } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  DataTable,
  Banner,
  Button,
  Divider,
  ProgressBar,
  Tooltip,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../utils/db.server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const merchant = await db.merchant.findUnique({ where: { shop } });
  if (!merchant) throw new Response("Merchant not found", { status: 404 });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [todayLedger, weekLedger, recentOrders, pendingVerifications] =
    await Promise.all([
      db.profitLedgerEntry.findUnique({
        where: { merchantId_date: { merchantId: merchant.id, date: today } },
      }),
      db.profitLedgerEntry.findMany({
        where: {
          merchantId: merchant.id,
          date: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
        orderBy: { date: "desc" },
      }),
      db.order.findMany({
        where: { merchantId: merchant.id },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          orderNumber: true,
          totalPrice: true,
          riskBand: true,
          decision: true,
          status: true,
          shippingPincode: true,
          createdAt: true,
        },
      }),
      db.verification.count({
        where: { merchantId: merchant.id, status: "SENT" },
      }),
    ]);

  const weekStats = weekLedger.reduce(
    (acc, day) => ({
      ordersTotal: acc.ordersTotal + day.ordersTotal,
      rtoPrevented: acc.rtoPrevented + day.rtoPrevented,
      profitSaved: acc.profitSaved + Number(day.profitSaved),
    }),
    { ordersTotal: 0, rtoPrevented: 0, profitSaved: 0 }
  );

  return json({
    merchant: {
      shop: merchant.shop,
      plan: merchant.plan,
      autopilotEnabled: merchant.autopilotEnabled,
      whatsappEnabled: merchant.whatsappEnabled,
    },
    today: {
      ordersTotal: todayLedger?.ordersTotal ?? 0,
      shippedCount: todayLedger?.shippedCount ?? 0,
      verifiedCount: todayLedger?.verifiedCount ?? 0,
      heldCount: todayLedger?.heldCount ?? 0,
      rtoPrevented: todayLedger?.rtoPrevented ?? 0,
      profitSaved: Number(todayLedger?.profitSaved ?? 0),
    },
    week: weekStats,
    recentOrders: recentOrders.map((o) => ({
      ...o,
      totalPrice: Number(o.totalPrice),
      createdAt: o.createdAt.toISOString(),
    })),
    pendingVerifications,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "toggle-autopilot") {
    const merchant = await db.merchant.findUnique({ where: { shop: session.shop } });
    if (merchant) {
      await db.merchant.update({
        where: { id: merchant.id },
        data: { autopilotEnabled: !merchant.autopilotEnabled },
      });
    }
  }

  return json({ ok: true });
};

// ─── Component ─────────────────────────────────────────────────────────────────
export default function ShieldHome() {
  const { merchant, today, week, recentOrders, pendingVerifications } =
    useLoaderData<typeof loader>();
  const submit = useSubmit();

  const toggleAutopilot = () => {
    submit({ intent: "toggle-autopilot" }, { method: "POST" });
  };

  const orderRows = recentOrders.map((o) => [
    o.orderNumber,
    `₹${o.totalPrice.toLocaleString("en-IN")}`,
    o.shippingPincode ?? "—",
    riskBadge(o.riskBand),
    decisionBadge(o.decision),
    statusBadge(o.status),
    new Date(o.createdAt).toLocaleDateString("en-IN"),
  ]);

  return (
    <Page
      title="ZeroLeak Shield"
      subtitle="India's Profit Protection OS"
      primaryAction={
        <Button
          variant={merchant.autopilotEnabled ? "primary" : "secondary"}
          onClick={toggleAutopilot}
          tone={merchant.autopilotEnabled ? "success" : undefined}
        >
          {merchant.autopilotEnabled ? "Autopilot ON" : "Autopilot OFF"}
        </Button>
      }
    >
      <Layout>
        {pendingVerifications > 0 && (
          <Layout.Section>
            <Banner
              title={`${pendingVerifications} order${pendingVerifications > 1 ? "s" : ""} awaiting WhatsApp verification`}
              tone="warning"
              action={{ content: "View Orders", url: "/app/orders" }}
            />
          </Layout.Section>
        )}

        {/* ─── Today's Stats ─────────────────────────────────────────────── */}
        <Layout.Section>
          <Text variant="headingMd" as="h2">Protected Today</Text>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <StatCard
            title="Orders Scanned"
            value={String(today.ordersTotal)}
            detail="today"
          />
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <StatCard
            title="RTOs Prevented"
            value={String(today.rtoPrevented)}
            detail="orders held"
            highlight
          />
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <StatCard
            title="Profit Saved"
            value={`₹${today.profitSaved.toLocaleString("en-IN")}`}
            detail="estimated today"
            highlight
          />
        </Layout.Section>

        {/* ─── Decision Breakdown ────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h3">Today's Decision Breakdown</Text>
              <Divider />
              <InlineStack gap="800" align="space-between">
                <DecisionStat
                  label="Shipped"
                  count={today.shippedCount}
                  total={today.ordersTotal}
                  color="success"
                />
                <DecisionStat
                  label="Verify"
                  count={today.verifiedCount}
                  total={today.ordersTotal}
                  color="warning"
                />
                <DecisionStat
                  label="Held"
                  count={today.heldCount}
                  total={today.ordersTotal}
                  color="critical"
                />
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ─── 7-Day Profit Ledger ───────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h3">7-Day Profit Ledger</Text>
              <Divider />
              <InlineStack gap="600">
                <BlockStack>
                  <Text variant="bodyLg" fontWeight="bold" as="p">
                    {week.ordersTotal.toLocaleString("en-IN")}
                  </Text>
                  <Text variant="bodySm" tone="subdued" as="p">Orders this week</Text>
                </BlockStack>
                <BlockStack>
                  <Text variant="bodyLg" fontWeight="bold" as="p" tone="success">
                    {week.rtoPrevented.toLocaleString("en-IN")}
                  </Text>
                  <Text variant="bodySm" tone="subdued" as="p">RTOs prevented</Text>
                </BlockStack>
                <BlockStack>
                  <Text variant="bodyLg" fontWeight="bold" as="p" tone="success">
                    ₹{week.profitSaved.toLocaleString("en-IN")}
                  </Text>
                  <Text variant="bodySm" tone="subdued" as="p">Profit protected</Text>
                </BlockStack>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ─── Recent Orders ─────────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text variant="headingMd" as="h3">Recent Orders</Text>
                <Button variant="plain" url="/app/orders">View all</Button>
              </InlineStack>
              <DataTable
                columnContentTypes={["text", "numeric", "text", "text", "text", "text", "text"]}
                headings={["Order", "Amount", "Pincode", "Risk", "Decision", "Status", "Date"]}
                rows={orderRows}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ─── Autopilot Status ──────────────────────────────────────────── */}
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h3">Autopilot</Text>
              <Divider />
              <Badge tone={merchant.autopilotEnabled ? "success" : "critical"}>
                {merchant.autopilotEnabled ? "Active" : "Paused"}
              </Badge>
              <Text variant="bodySm" tone="subdued" as="p">
                {merchant.autopilotEnabled
                  ? "Risk engine is automatically processing all incoming orders."
                  : "Enable Autopilot to auto-process orders with the risk engine."}
              </Text>
              <Button onClick={toggleAutopilot} size="slim">
                {merchant.autopilotEnabled ? "Pause Autopilot" : "Enable Autopilot"}
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h3">WhatsApp Verify</Text>
              <Divider />
              <Badge tone={merchant.whatsappEnabled ? "success" : "attention"}>
                {merchant.whatsappEnabled ? "Connected" : "Not configured"}
              </Badge>
              <Text variant="bodySm" tone="subdued" as="p">
                Auto-verify AMBER risk orders via WhatsApp before shipping.
              </Text>
              <Button variant="plain" url="/app/settings">Configure</Button>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h3">Plan</Text>
              <Divider />
              <Badge>{merchant.plan}</Badge>
              <Text variant="bodySm" tone="subdued" as="p">
                Upgrade to unlock unlimited orders and advanced features.
              </Text>
              <Button variant="plain" url="/app/billing">Upgrade</Button>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function StatCard({ title, value, detail, highlight }: {
  title: string; value: string; detail: string; highlight?: boolean;
}) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text variant="bodySm" tone="subdued" as="p">{title}</Text>
        <Text
          variant="heading2xl"
          as="p"
          tone={highlight ? "success" : undefined}
          fontWeight="bold"
        >
          {value}
        </Text>
        <Text variant="bodySm" tone="subdued" as="p">{detail}</Text>
      </BlockStack>
    </Card>
  );
}

function DecisionStat({ label, count, total, color }: {
  label: string; count: number; total: number;
  color: "success" | "warning" | "critical";
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <BlockStack gap="200" inlineAlign="center">
      <Text variant="headingLg" as="p" tone={color === "critical" ? "critical" : color === "warning" ? "caution" : "success"}>
        {count}
      </Text>
      <Text variant="bodySm" as="p">{label}</Text>
      <Text variant="bodySm" tone="subdued" as="p">{pct}%</Text>
    </BlockStack>
  );
}

function riskBadge(band: string | null) {
  if (band === "GREEN") return <Badge tone="success">Green</Badge>;
  if (band === "AMBER") return <Badge tone="warning">Amber</Badge>;
  if (band === "RED") return <Badge tone="critical">Red</Badge>;
  return <Badge>—</Badge>;
}

function decisionBadge(decision: string | null) {
  if (decision === "SHIP") return <Badge tone="success">Ship</Badge>;
  if (decision === "VERIFY") return <Badge tone="warning">Verify</Badge>;
  if (decision === "HOLD") return <Badge tone="critical">Hold</Badge>;
  return <Badge>—</Badge>;
}

function statusBadge(status: string) {
  const toneMap: Record<string, "success" | "warning" | "critical" | "info" | "attention"> = {
    PROCESSED: "success",
    SHIPPED: "success",
    PENDING: "attention",
    CANCELLED: "critical",
    RTO: "critical",
    VERIFIED: "info",
  };
  return <Badge tone={toneMap[status] ?? "attention"}>{status}</Badge>;
}
