/**
 * ZeroLeak Orders — Module 2: Ship / Verify / Hold Decision Engine UI
 */

import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, Form } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  IndexTable,
  useIndexResourceState,
  Filters,
  Button,
  Select,
  Tooltip,
  Modal,
  TextContainer,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import { db } from "../utils/db.server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const filterDecision = url.searchParams.get("decision") ?? "";
  const filterBand = url.searchParams.get("band") ?? "";
  const page = parseInt(url.searchParams.get("page") ?? "1", 10);
  const PER_PAGE = 25;

  const merchant = await db.merchant.findUnique({ where: { shop: session.shop } });
  if (!merchant) throw new Response("Not found", { status: 404 });

  const where = {
    merchantId: merchant.id,
    ...(filterDecision ? { decision: filterDecision as never } : {}),
    ...(filterBand ? { riskBand: filterBand as never } : {}),
  };

  const [orders, total] = await Promise.all([
    db.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PER_PAGE,
      take: PER_PAGE,
      include: { verifications: { orderBy: { createdAt: "desc" }, take: 1 } },
    }),
    db.order.count({ where }),
  ]);

  return json({
    orders: orders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      totalPrice: Number(o.totalPrice),
      riskScore: o.riskScore,
      riskBand: o.riskBand,
      decision: o.decision,
      decisionReason: o.decisionReason,
      status: o.status,
      shippingPincode: o.shippingPincode,
      paymentMethod: o.paymentMethod,
      createdAt: o.createdAt.toISOString(),
      latestVerification: o.verifications[0]?.status ?? null,
    })),
    total,
    page,
    perPage: PER_PAGE,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const orderIds = JSON.parse(formData.get("orderIds") as string ?? "[]") as string[];

  if (intent === "override-ship") {
    await db.order.updateMany({
      where: { id: { in: orderIds } },
      data: { decision: "SHIP", status: "PROCESSED" },
    });
  }

  if (intent === "override-hold") {
    await db.order.updateMany({
      where: { id: { in: orderIds } },
      data: { decision: "HOLD", status: "PENDING" },
    });
  }

  return json({ ok: true });
};

export default function Orders() {
  const { orders, total, page, perPage } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const [activeDecisionFilter, setActiveDecisionFilter] = useState("");
  const [activeBandFilter, setActiveBandFilter] = useState("");

  const resourceName = { singular: "order", plural: "orders" };
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(orders);

  const bulkActions = [
    {
      content: "Override → Ship",
      onAction: () => {
        submit(
          { intent: "override-ship", orderIds: JSON.stringify(selectedResources) },
          { method: "POST" }
        );
      },
    },
    {
      content: "Override → Hold",
      onAction: () => {
        submit(
          { intent: "override-hold", orderIds: JSON.stringify(selectedResources) },
          { method: "POST" }
        );
      },
    },
  ];

  const rowMarkup = orders.map((order, index) => (
    <IndexTable.Row
      id={order.id}
      key={order.id}
      selected={selectedResources.includes(order.id)}
      position={index}
    >
      <IndexTable.Cell>
        <Text variant="bodyMd" fontWeight="bold" as="span">
          {order.orderNumber}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>₹{order.totalPrice.toLocaleString("en-IN")}</IndexTable.Cell>
      <IndexTable.Cell>{order.shippingPincode ?? "—"}</IndexTable.Cell>
      <IndexTable.Cell>{order.paymentMethod}</IndexTable.Cell>
      <IndexTable.Cell>
        <RiskScoreCell score={order.riskScore} band={order.riskBand} />
      </IndexTable.Cell>
      <IndexTable.Cell>
        <DecisionCell decision={order.decision} reason={order.decisionReason} />
      </IndexTable.Cell>
      <IndexTable.Cell>
        <StatusCell status={order.status} verification={order.latestVerification} />
      </IndexTable.Cell>
      <IndexTable.Cell>
        {new Date(order.createdAt).toLocaleDateString("en-IN")}
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      title="Orders"
      subtitle={`${total.toLocaleString("en-IN")} total orders`}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <IndexTable
              resourceName={resourceName}
              itemCount={orders.length}
              selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
              onSelectionChange={handleSelectionChange}
              bulkActions={bulkActions}
              headings={[
                { title: "Order" },
                { title: "Amount" },
                { title: "Pincode" },
                { title: "Payment" },
                { title: "Risk Score" },
                { title: "Decision" },
                { title: "Status" },
                { title: "Date" },
              ]}
            >
              {rowMarkup}
            </IndexTable>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function RiskScoreCell({ score, band }: { score: number | null; band: string | null }) {
  if (score === null) return <Text as="span">—</Text>;
  const tone = band === "GREEN" ? "success" : band === "AMBER" ? "caution" : "critical";
  return (
    <InlineStack gap="200" blockAlign="center">
      <Text as="span" tone={tone} fontWeight="bold">{score}</Text>
      <Badge tone={band === "GREEN" ? "success" : band === "AMBER" ? "warning" : "critical"}>
        {band ?? ""}
      </Badge>
    </InlineStack>
  );
}

function DecisionCell({ decision, reason }: { decision: string | null; reason: string | null }) {
  if (!decision) return <Text as="span">—</Text>;
  return (
    <Tooltip content={reason ?? ""}>
      <Badge
        tone={decision === "SHIP" ? "success" : decision === "VERIFY" ? "warning" : "critical"}
      >
        {decision}
      </Badge>
    </Tooltip>
  );
}

function StatusCell({ status, verification }: { status: string; verification: string | null }) {
  const toneMap: Record<string, "success" | "warning" | "critical" | "attention" | "info"> = {
    PROCESSED: "success",
    SHIPPED: "success",
    PENDING: "attention",
    CANCELLED: "critical",
    RTO: "critical",
    VERIFIED: "info",
  };
  return (
    <InlineStack gap="200">
      <Badge tone={toneMap[status] ?? "attention"}>{status}</Badge>
      {verification === "SENT" && <Badge tone="info">Awaiting WA</Badge>}
      {verification === "CONFIRMED" && <Badge tone="success">WA Confirmed</Badge>}
      {verification === "REJECTED" && <Badge tone="critical">WA Rejected</Badge>}
    </InlineStack>
  );
}
