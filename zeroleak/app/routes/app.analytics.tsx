/**
 * ZeroLeak Analytics — Profit trends, risk distribution, RTO history
 */

import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  DataTable,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../utils/db.server";
import type { LoaderFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const merchant = await db.merchant.findUnique({ where: { shop: session.shop } });
  if (!merchant) throw new Response("Not found", { status: 404 });

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [ledger, riskDistribution, topRtoPincodes, rtoRate] = await Promise.all([
    db.profitLedgerEntry.findMany({
      where: { merchantId: merchant.id, date: { gte: thirtyDaysAgo } },
      orderBy: { date: "desc" },
      take: 30,
    }),
    db.order.groupBy({
      by: ["riskBand"],
      where: { merchantId: merchant.id, createdAt: { gte: thirtyDaysAgo } },
      _count: { riskBand: true },
    }),
    db.order.groupBy({
      by: ["shippingPincode"],
      where: { merchantId: merchant.id, isRTO: true },
      _count: { shippingPincode: true },
      orderBy: { _count: { shippingPincode: "desc" } },
      take: 10,
    }),
    db.order.aggregate({
      where: { merchantId: merchant.id, createdAt: { gte: thirtyDaysAgo } },
      _count: { id: true },
    }),
  ]);

  const rtoCount = await db.order.count({
    where: { merchantId: merchant.id, isRTO: true, createdAt: { gte: thirtyDaysAgo } },
  });

  const totalSaved = ledger.reduce((sum, d) => sum + Number(d.profitSaved), 0);
  const totalPrevented = ledger.reduce((sum, d) => sum + d.rtoPrevented, 0);

  return json({
    ledger: ledger.map((d) => ({
      date: d.date.toISOString().split("T")[0],
      ordersTotal: d.ordersTotal,
      rtoPrevented: d.rtoPrevented,
      profitSaved: Number(d.profitSaved),
    })),
    riskDistribution: riskDistribution.map((r) => ({
      band: r.riskBand ?? "UNKNOWN",
      count: r._count.riskBand,
    })),
    topRtoPincodes: topRtoPincodes.map((r) => ({
      pincode: r.shippingPincode ?? "Unknown",
      count: r._count.shippingPincode,
    })),
    summary: {
      totalOrders: rtoRate._count.id,
      rtoCount,
      rtoRate: rtoRate._count.id > 0 ? ((rtoCount / rtoRate._count.id) * 100).toFixed(1) : "0",
      totalSaved,
      totalPrevented,
    },
  });
};

export default function Analytics() {
  const { ledger, riskDistribution, topRtoPincodes, summary } =
    useLoaderData<typeof loader>();

  const ledgerRows = ledger.slice(0, 14).map((d) => [
    d.date,
    String(d.ordersTotal),
    String(d.rtoPrevented),
    `₹${d.profitSaved.toLocaleString("en-IN")}`,
  ]);

  const pincodeRows = topRtoPincodes.map((p) => [p.pincode, String(p.count)]);

  const riskRows = riskDistribution.map((r) => [
    r.band,
    String(r.count),
    summary.totalOrders > 0
      ? `${((r.count / summary.totalOrders) * 100).toFixed(1)}%`
      : "0%",
  ]);

  return (
    <Page title="Analytics" subtitle="30-day performance overview">
      <Layout>
        {/* Summary KPIs */}
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="200">
              <Text variant="bodySm" tone="subdued" as="p">Total Orders (30d)</Text>
              <Text variant="heading2xl" as="p">{summary.totalOrders.toLocaleString("en-IN")}</Text>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="200">
              <Text variant="bodySm" tone="subdued" as="p">RTOs Prevented</Text>
              <Text variant="heading2xl" as="p" tone="success">
                {summary.totalPrevented.toLocaleString("en-IN")}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="200">
              <Text variant="bodySm" tone="subdued" as="p">Profit Protected (30d)</Text>
              <Text variant="heading2xl" as="p" tone="success">
                ₹{summary.totalSaved.toLocaleString("en-IN")}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Risk Distribution */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h3">Risk Distribution (30d)</Text>
              <Divider />
              <DataTable
                columnContentTypes={["text", "numeric", "numeric"]}
                headings={["Risk Band", "Orders", "Share"]}
                rows={riskRows}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Daily Ledger */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h3">Daily Profit Ledger (14d)</Text>
              <Divider />
              <DataTable
                columnContentTypes={["text", "numeric", "numeric", "numeric"]}
                headings={["Date", "Orders", "RTOs Prevented", "Profit Saved"]}
                rows={ledgerRows}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Top RTO Pincodes */}
        {topRtoPincodes.length > 0 && (
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h3">Top RTO Pincodes</Text>
                <Divider />
                <DataTable
                  columnContentTypes={["text", "numeric"]}
                  headings={["Pincode", "RTO Count"]}
                  rows={pincodeRows}
                />
              </BlockStack>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
