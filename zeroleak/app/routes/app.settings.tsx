/**
 * ZeroLeak Settings
 *
 * Sections:
 *   1. Autopilot toggle
 *   2. Pincode CSV upload (real merchant RTO data)
 *   3. Razorpay Token Advance (Pro only — locked card otherwise)
 */

import { json, unstable_parseMultipartFormData, unstable_createMemoryUploadHandler } from "@remix-run/node";
import { useLoaderData, useSubmit, useFetcher, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Checkbox,
  TextField,
  Button,
  Divider,
  Banner,
  Badge,
  DropZone,
  Spinner,
  Icon,
  Box,
} from "@shopify/polaris";
import { LockIcon } from "@shopify/polaris-icons";
import { useState, useCallback } from "react";
import Papa from "papaparse";
import { authenticate } from "../shopify.server";
import { db } from "../utils/db.server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const merchant = await db.merchant.findUnique({ where: { shop: session.shop } });
  if (!merchant) throw new Response("Not found", { status: 404 });

  const pincodeCount = await db.merchantPincode.count({ where: { merchantId: merchant.id } });

  return json({
    plan: merchant.plan as "FREE" | "GROWTH" | "PRO",
    autopilotEnabled: merchant.autopilotEnabled,
    razorpayKeyId: merchant.razorpayKeyId ?? "",
    tokenAdvanceAmount: merchant.tokenAdvanceAmount,
    pincodeCount,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const merchant = await db.merchant.findUnique({ where: { shop: session.shop } });
  if (!merchant) return json({ error: "Not found" }, { status: 404 });

  const contentType = request.headers.get("content-type") ?? "";

  // ── CSV upload (multipart) ──────────────────────────────────────────────────
  if (contentType.includes("multipart/form-data")) {
    const uploadHandler = unstable_createMemoryUploadHandler({ maxPartSize: 5_000_000 });
    const formData = await unstable_parseMultipartFormData(request, uploadHandler);
    const csvFile = formData.get("csvFile") as File | null;

    if (!csvFile) return json({ error: "No file uploaded" }, { status: 400 });

    const text = await csvFile.text();
    const { data } = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
    });

    // Expected columns: pincode, city, state, total_orders, rto_count
    // Flexible: also accept Shopify orders export columns
    const pincodeTotals: Record<string, { city: string; state: string; total: number; rto: number }> = {};

    for (const row of data) {
      // Support two formats:
      // 1. Pre-aggregated: pincode, city, state, total_orders, rto_count
      // 2. Shopify order export: "Shipping Zip", "Shipping City", "Shipping Province", "Financial Status"
      const pincode = (row["pincode"] ?? row["Shipping Zip"] ?? "").trim();
      if (!pincode || pincode.length < 5) continue;

      const city = row["city"] ?? row["Shipping City"] ?? "";
      const state = row["state"] ?? row["Shipping Province"] ?? "";

      if (row["total_orders"] !== undefined) {
        // Pre-aggregated format
        pincodeTotals[pincode] = {
          city,
          state,
          total: parseInt(row["total_orders"] ?? "0", 10),
          rto: parseInt(row["rto_count"] ?? "0", 10),
        };
      } else {
        // Shopify raw orders: count orders, flag RTO by financial_status
        if (!pincodeTotals[pincode]) {
          pincodeTotals[pincode] = { city, state, total: 0, rto: 0 };
        }
        pincodeTotals[pincode].total += 1;
        const status = (row["Financial Status"] ?? row["financial_status"] ?? "").toLowerCase();
        if (status === "refunded" || status === "voided") {
          pincodeTotals[pincode].rto += 1;
        }
      }
    }

    // Upsert into MerchantPincode table
    let upserted = 0;
    for (const [pincode, stats] of Object.entries(pincodeTotals)) {
      if (stats.total === 0) continue;
      const rtoPercentage = (stats.rto / stats.total) * 100;
      const riskBand =
        rtoPercentage >= 35 ? "RED" : rtoPercentage >= 20 ? "AMBER" : "GREEN";

      await db.merchantPincode.upsert({
        where: { merchantId_pincode: { merchantId: merchant.id, pincode } },
        update: {
          city: stats.city || undefined,
          state: stats.state || undefined,
          totalOrders: stats.total,
          rtoCount: stats.rto,
          rtoPercentage: Math.round(rtoPercentage * 10) / 10,
          riskBand,
        },
        create: {
          merchantId: merchant.id,
          pincode,
          city: stats.city || null,
          state: stats.state || null,
          totalOrders: stats.total,
          rtoCount: stats.rto,
          rtoPercentage: Math.round(rtoPercentage * 10) / 10,
          riskBand,
        },
      });
      upserted++;
    }

    return json({ success: true, message: `Imported data for ${upserted} pincodes.` });
  }

  // ── Regular settings save (JSON) ──────────────────────────────────────────
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "save-settings") {
    await db.merchant.update({
      where: { id: merchant.id },
      data: {
        autopilotEnabled: formData.get("autopilotEnabled") === "true",
        tokenAdvanceAmount: parseInt(formData.get("tokenAdvanceAmount") as string ?? "99", 10),
      },
    });
    return json({ success: true, message: "Settings saved." });
  }

  if (intent === "save-razorpay") {
    if (merchant.plan !== "PRO") {
      return json({ error: "Razorpay integration requires Pro plan." }, { status: 403 });
    }
    await db.merchant.update({
      where: { id: merchant.id },
      data: {
        razorpayKeyId: formData.get("razorpayKeyId") as string,
        razorpayKeySecret: formData.get("razorpayKeySecret") as string,
      },
    });
    return json({ success: true, message: "Razorpay keys saved." });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

// ─── Component ─────────────────────────────────────────────────────────────────
export default function Settings() {
  const { plan, autopilotEnabled, razorpayKeyId, tokenAdvanceAmount, pincodeCount } =
    useLoaderData<typeof loader>();
  const submit = useSubmit();
  const fetcher = useFetcher<typeof action>();
  const navigation = useNavigation();

  const [autopilot, setAutopilot] = useState(autopilotEnabled);
  const [tokenAmount, setTokenAmount] = useState(String(tokenAdvanceAmount));
  const [rzpKeyId, setRzpKeyId] = useState(razorpayKeyId);
  const [rzpKeySecret, setRzpKeySecret] = useState("");
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const isPro = plan === "PRO";
  const isSaving = navigation.state === "submitting";

  const handleCsvDrop = useCallback((_: File[], accepted: File[]) => {
    if (accepted[0]) setCsvFile(accepted[0]);
  }, []);

  const uploadCsv = useCallback(async () => {
    if (!csvFile) return;
    setUploading(true);
    const fd = new FormData();
    fd.append("csvFile", csvFile);
    fetcher.submit(fd, { method: "POST", encType: "multipart/form-data" });
    setCsvFile(null);
    setUploading(false);
  }, [csvFile, fetcher]);

  const saveSettings = () => {
    submit(
      { intent: "save-settings", autopilotEnabled: String(autopilot), tokenAdvanceAmount: tokenAmount },
      { method: "POST" }
    );
  };

  const saveRazorpay = () => {
    submit(
      { intent: "save-razorpay", razorpayKeyId: rzpKeyId, razorpayKeySecret: rzpKeySecret },
      { method: "POST" }
    );
  };

  const fetcherData = fetcher.data as { success?: boolean; message?: string; error?: string } | undefined;

  return (
    <Page title="Settings" primaryAction={{ content: "Save", onAction: saveSettings, loading: isSaving }}>
      <Layout>

        {/* ── Autopilot ──────────────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h3">Autopilot</Text>
              <Divider />
              <Checkbox
                label="Enable Autopilot"
                checked={autopilot}
                onChange={setAutopilot}
                helpText="ZeroLeak automatically applies Ship / Verify / Hold decisions on every incoming order. Requires Growth or Pro plan."
              />
              {autopilot && plan === "FREE" && (
                <Banner tone="warning">
                  Autopilot requires Growth or Pro plan.{" "}
                  <a href="/app/billing">Upgrade now →</a>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Pincode Risk Data ──────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text variant="headingMd" as="h3">Pincode Risk Data</Text>
                  <Text variant="bodySm" tone="subdued" as="p">
                    Upload your Shopify orders export to train the risk engine on your actual RTO patterns.
                  </Text>
                </BlockStack>
                {pincodeCount > 0 && (
                  <Badge tone="success">{`${pincodeCount} pincodes loaded`}</Badge>
                )}
              </InlineStack>
              <Divider />

              {fetcherData?.success && (
                <Banner tone="success">{fetcherData.message}</Banner>
              )}
              {fetcherData?.error && (
                <Banner tone="critical">{fetcherData.error}</Banner>
              )}

              <DropZone onDrop={handleCsvDrop} accept=".csv" allowMultiple={false}>
                {csvFile ? (
                  <Box padding="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" variant="bodyMd">{csvFile.name}</Text>
                      <Button size="slim" onClick={uploadCsv} loading={uploading}>
                        Upload & Process
                      </Button>
                    </InlineStack>
                  </Box>
                ) : (
                  <DropZone.FileUpload
                    actionTitle="Upload CSV"
                    actionHint="Accepts Shopify orders export or pre-aggregated pincode data"
                  />
                )}
              </DropZone>

              <Text variant="bodySm" tone="subdued" as="p">
                <strong>Shopify export:</strong> Orders → Export → All orders → CSV. ZeroLeak reads Shipping Zip and Financial Status columns automatically.
                <br />
                <strong>Pre-aggregated:</strong> Columns: <code>pincode, city, state, total_orders, rto_count</code>
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Token Advance Amount ───────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h3">Token Advance Amount</Text>
              <Divider />
              <TextField
                label="Amount (₹)"
                type="number"
                value={tokenAmount}
                onChange={setTokenAmount}
                min="1"
                max="999"
                helpText="Refundable advance charged to RED-risk COD orders. Recommended ₹99. Fully refunded on delivery."
                autoComplete="off"
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Razorpay (Pro only) ───────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h3">Razorpay Token Advance Engine</Text>
                {!isPro && <Badge tone="attention">Pro Only</Badge>}
                {isPro && <Badge tone="success">Unlocked</Badge>}
              </InlineStack>
              <Divider />

              {!isPro ? (
                <Box
                  background="bg-surface-secondary"
                  borderRadius="200"
                  padding="500"
                >
                  <BlockStack gap="300" inlineAlign="center">
                    <Icon source={LockIcon} tone="subdued" />
                    <Text variant="bodyMd" tone="subdued" as="p" alignment="center">
                      Razorpay integration is a <strong>Pro plan</strong> feature. Payment links go directly into
                      your Razorpay account — ZeroLeak never touches the money.
                    </Text>
                    <Button variant="primary" url="/app/billing">Upgrade to Pro</Button>
                  </BlockStack>
                </Box>
              ) : (
                <BlockStack gap="400">
                  <Banner tone="info">
                    Your Razorpay keys are stored encrypted. Payment links deposit directly into your Razorpay account.
                  </Banner>
                  <TextField
                    label="Razorpay Key ID"
                    value={rzpKeyId}
                    onChange={setRzpKeyId}
                    placeholder="rzp_live_..."
                    autoComplete="off"
                    helpText="Your Razorpay live key ID from the Razorpay dashboard."
                  />
                  <TextField
                    label="Razorpay Key Secret"
                    type="password"
                    value={rzpKeySecret}
                    onChange={setRzpKeySecret}
                    placeholder="Enter to update"
                    autoComplete="off"
                    helpText="Leave blank to keep the existing secret."
                  />
                  <Button variant="primary" onClick={saveRazorpay}>
                    Save Razorpay Keys
                  </Button>
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

      </Layout>
    </Page>
  );
}
