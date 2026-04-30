/**
 * ZeroLeak Rules — Module 5: Natural Language Rule Parser + Rule Management
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
  ResourceList,
  ResourceItem,
  TextField,
  Button,
  Banner,
  Divider,
  Spinner,
  ButtonGroup,
  EmptyState,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import { db } from "../utils/db.server";
import { parseNaturalLanguageRule, RULE_TEMPLATES } from "../services/rule-parser.server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const merchant = await db.merchant.findUnique({ where: { shop: session.shop } });
  if (!merchant) throw new Response("Not found", { status: 404 });

  const rules = await db.rule.findMany({
    where: { merchantId: merchant.id },
    orderBy: [{ isActive: "desc" }, { priority: "desc" }],
  });

  return json({
    rules: rules.map((r) => ({
      id: r.id,
      name: r.name,
      naturalText: r.naturalText,
      type: r.type,
      isActive: r.isActive,
      priority: r.priority,
      appliedCount: r.appliedCount,
      action: r.action as { decision: string; tokenAmount?: number; reason: string },
      conditions: r.conditions,
    })),
    templates: RULE_TEMPLATES,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const merchant = await db.merchant.findUnique({ where: { shop: session.shop } });
  if (!merchant) return json({ error: "Merchant not found" }, { status: 404 });

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "parse-rule") {
    const input = formData.get("nlInput") as string;
    if (!input?.trim()) return json({ error: "Please enter a rule" }, { status: 400 });

    try {
      const { rule, ruleId } = await parseNaturalLanguageRule(input.trim(), merchant.id);
      return json({ success: true, rule, ruleId });
    } catch (err) {
      return json({ error: (err as Error).message }, { status: 422 });
    }
  }

  if (intent === "add-template") {
    const templateIndex = parseInt(formData.get("templateIndex") as string, 10);
    const template = RULE_TEMPLATES[templateIndex];
    if (!template) return json({ error: "Invalid template" }, { status: 400 });

    await db.rule.create({
      data: {
        merchantId: merchant.id,
        name: template.name,
        type: "MANUAL",
        priority: 50,
        isActive: true,
        conditions: template.conditions,
        action: template.action,
      },
    });
    return json({ success: true });
  }

  if (intent === "toggle-rule") {
    const ruleId = formData.get("ruleId") as string;
    const rule = await db.rule.findFirst({ where: { id: ruleId, merchantId: merchant.id } });
    if (!rule) return json({ error: "Rule not found" }, { status: 404 });
    await db.rule.update({ where: { id: ruleId }, data: { isActive: !rule.isActive } });
    return json({ success: true });
  }

  if (intent === "delete-rule") {
    const ruleId = formData.get("ruleId") as string;
    await db.rule.deleteMany({ where: { id: ruleId, merchantId: merchant.id } });
    return json({ success: true });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

export default function Rules() {
  const { rules, templates } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const [nlInput, setNlInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [parseResult, setParseResult] = useState<string | null>(null);

  const handleParseRule = useCallback(() => {
    if (!nlInput.trim()) return;
    setLoading(true);
    setParseResult(null);
    submit({ intent: "parse-rule", nlInput }, { method: "POST" });
    setLoading(false);
    setNlInput("");
  }, [nlInput, submit]);

  return (
    <Page
      title="Rules"
      subtitle="Merchant rules override risk engine defaults. Higher priority rules fire first."
      primaryAction={{
        content: "Add Rule",
        onAction: () => document.getElementById("nl-input")?.focus(),
      }}
    >
      <Layout>
        {/* ─── NL Rule Parser ──────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h3">
                Natural Language Rule Parser
              </Text>
              <Text variant="bodySm" tone="subdued" as="p">
                Describe your rule in plain English (or Hinglish). ZeroLeak converts it to an executable rule.
              </Text>
              <Divider />
              <TextField
                id="nl-input"
                label="Rule description"
                value={nlInput}
                onChange={setNlInput}
                placeholder='e.g. "Require ₹49 token advance for all COD orders above ₹2000 in risky zones"'
                autoComplete="off"
                helpText='Use keywords: "COD", "risky zones", "token advance", "verify", "hold", "ship", pincode, state, ₹amount'
                connectedRight={
                  <Button
                    variant="primary"
                    onClick={handleParseRule}
                    disabled={!nlInput.trim() || loading}
                    loading={loading}
                  >
                    {loading ? "Parsing..." : "Parse Rule"}
                  </Button>
                }
              />
              <InlineStack gap="200" wrap>
                {[
                  "Verify all COD orders above ₹1500",
                  "Block orders from Bihar and Jharkhand",
                  "Auto-ship prepaid orders under ₹500",
                  "Require ₹49 token advance in red zones",
                ].map((example) => (
                  <Button
                    key={example}
                    size="slim"
                    onClick={() => setNlInput(example)}
                  >
                    {example}
                  </Button>
                ))}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ─── Rule Templates ───────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h3">Quick Templates</Text>
              <Text variant="bodySm" tone="subdued" as="p">
                One-click rules for common scenarios.
              </Text>
              <Divider />
              <BlockStack gap="300">
                {templates.map((template, index) => (
                  <InlineStack key={template.name} align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                      <Text variant="bodyMd" fontWeight="semibold" as="p">{template.name}</Text>
                      <Text variant="bodySm" tone="subdued" as="p">{template.description}</Text>
                    </BlockStack>
                    <Button
                      size="slim"
                      onClick={() =>
                        submit(
                          { intent: "add-template", templateIndex: String(index) },
                          { method: "POST" }
                        )
                      }
                    >
                      Add
                    </Button>
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ─── Active Rules ─────────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text variant="headingMd" as="h3">Active Rules ({rules.length})</Text>
              </InlineStack>
              <Divider />
              {rules.length === 0 ? (
                <EmptyState
                  heading="No rules configured"
                  image=""
                  action={{
                    content: "Add your first rule",
                    onAction: () => document.getElementById("nl-input")?.focus(),
                  }}
                >
                  <Text as="p">Rules override the risk engine. Add rules to customise decisions for your store.</Text>
                </EmptyState>
              ) : (
                <ResourceList
                  resourceName={{ singular: "rule", plural: "rules" }}
                  items={rules}
                  renderItem={(rule) => (
                    <ResourceItem id={rule.id} onClick={() => {}}>
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center">
                            <Text variant="bodyMd" fontWeight="semibold" as="span">
                              {rule.name}
                            </Text>
                            <Badge tone={rule.isActive ? "success" : "attention"}>
                              {rule.isActive ? "Active" : "Paused"}
                            </Badge>
                            <Badge>{rule.type}</Badge>
                            {rule.action.decision && (
                              <Badge
                                tone={
                                  rule.action.decision === "SHIP"
                                    ? "success"
                                    : rule.action.decision === "VERIFY"
                                    ? "warning"
                                    : "critical"
                                }
                              >
                                → {rule.action.decision}
                              </Badge>
                            )}
                          </InlineStack>
                          {rule.naturalText && (
                            <Text variant="bodySm" tone="subdued" as="p">
                              "{rule.naturalText}"
                            </Text>
                          )}
                          <Text variant="bodySm" tone="subdued" as="p">
                            Applied {rule.appliedCount} times · Priority {rule.priority}
                          </Text>
                        </BlockStack>
                        <ButtonGroup>
                          <Button
                            size="slim"
                            onClick={() =>
                              submit(
                                { intent: "toggle-rule", ruleId: rule.id },
                                { method: "POST" }
                              )
                            }
                          >
                            {rule.isActive ? "Pause" : "Enable"}
                          </Button>
                          <Button
                            size="slim"
                            tone="critical"
                            onClick={() =>
                              submit(
                                { intent: "delete-rule", ruleId: rule.id },
                                { method: "POST" }
                              )
                            }
                          >
                            Delete
                          </Button>
                        </ButtonGroup>
                      </InlineStack>
                    </ResourceItem>
                  )}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
