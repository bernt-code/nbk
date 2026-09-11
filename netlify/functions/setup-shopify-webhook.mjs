// Engangs-admin-funksjon: registrer Shopify `orders/create`-webhook mot
// /api/shopify/webhook (shopify-order-webhook.mjs). Idempotent — lister først,
// oppretter bare hvis adressen mangler.
//
// Kjøres via:
//   curl -H "Authorization: Bearer $ADMIN_TOKEN" "https://nbk.no/api/setup-shopify-webhook"
// Legg til ?delete=<webhookId> for å fjerne en gammel/feil registrering.
//
// Webhooken registreres av VÅR app (client_credentials), så Shopify signerer
// leveransene med SHOPIFY_API_SECRET — det er den shopify-order-webhook.mjs sjekker.
import { getShopifyAccessToken } from "./vipps-webhook.mjs";

const WEBHOOK_PATH = "/api/shopify/webhook";

function isAuthorized(req) {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

export default async (req) => {
  if (!isAuthorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  if (!shop) return Response.json({ error: "SHOPIFY_STORE_DOMAIN mangler" }, { status: 500 });
  const token = await getShopifyAccessToken(shop);
  if (!token) return Response.json({ error: "Kunne ikke hente Shopify-token" }, { status: 500 });

  const base = `https://${shop}/admin/api/2024-10`;
  const headers = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
  const siteUrl = process.env.SITE_URL || "https://nbk.no";
  const address = `${siteUrl}${WEBHOOK_PATH}`;
  const url = new URL(req.url);
  const out = { address, deleted: null, created: null, existing: [] };

  const del = url.searchParams.get("delete");
  if (del) {
    const r = await fetch(`${base}/webhooks/${del}.json`, { method: "DELETE", headers });
    out.deleted = { id: del, status: r.status };
  }

  const list = await fetch(`${base}/webhooks.json?limit=250`, { headers }).then(r => r.json());
  out.existing = (list.webhooks || []).map(w => ({ id: w.id, topic: w.topic, address: w.address, format: w.format }));

  const already = out.existing.find(w => w.topic === "orders/create" && w.address === address);
  if (already) {
    out.created = { skipped: "finnes allerede", id: already.id };
  } else {
    const r = await fetch(`${base}/webhooks.json`, {
      method: "POST", headers,
      body: JSON.stringify({ webhook: { topic: "orders/create", address, format: "json" } }),
    });
    const data = await r.json();
    out.created = data.webhook ? { id: data.webhook.id, topic: data.webhook.topic, address: data.webhook.address } : { error: data, status: r.status };
  }

  return Response.json(out);
};
