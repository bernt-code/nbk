import { createHmac } from "crypto";

// /api/test-kopp?t=<token>&nr=NOR+111&ar=1980[&skip_gelato=1]
// Simulerer full Legendekopp-bestilling: Shopify-ordre + Gelato-ordre.
// skip_gelato=1: hopp over Gelato (nyttig for å teste kun Shopify-flyten uten ekte trykk-ordre)
// Kun for admin-testing — fjern eller sperre etter verifisering.

async function getShopifyAccessToken(shop) {
  // Samme logikk som vipps-webhook.mjs: SHOPIFY_ADMIN_TOKEN → client_credentials-fallback
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  const client_id     = process.env.SHOPIFY_API_KEY;
  const client_secret = process.env.SHOPIFY_API_SECRET;
  if (!client_id || !client_secret) return null;
  try {
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id, client_secret, grant_type: "client_credentials" }),
    });
    const data = await res.json();
    return data.access_token || null;
  } catch {
    return null;
  }
}

export default async (req) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const url = new URL(req.url);
  const t   = url.searchParams.get("t") || "";
  const adminSecret = process.env.ADMIN_TOKEN;
  if (!adminSecret) return Response.json({ error: "ADMIN_TOKEN not set" }, { status: 500 });

  // Auth: HMAC("test-kopp")
  const expected = createHmac("sha256", adminSecret).update("test-kopp").digest("hex").slice(0, 16);
  if (t !== expected) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const nr         = url.searchParams.get("nr") || "NOR 111";
  const ar         = url.searchParams.get("ar") || "1980";
  const skipGelato = url.searchParams.get("skip_gelato") === "1";

  // Bygg artwork-URL (samme logikk som i vipps-webhook.mjs)
  const artworkToken = createHmac("sha256", adminSecret).update(`${nr}:${ar}`).digest("hex").slice(0, 16);
  const siteUrl = process.env.SITE_URL || "https://nbk.no";
  const artworkUrl = `${siteUrl}/api/kopp-print?nr=${encodeURIComponent(nr)}&ar=${encodeURIComponent(ar)}&t=${artworkToken}&fmt=png`;

  const results = { nr, ar, artworkUrl, shopify: null, gelato: null };

  // ── Shopify ──
  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const LEGENDEKOPP_VARIANT_ID = 51936344375582;

  if (!shop) {
    results.shopify = { skipped: "SHOPIFY_STORE_DOMAIN mangler" };
  } else {
    const token_shopify = await getShopifyAccessToken(shop);
    if (!token_shopify) {
      results.shopify = { skipped: "Ingen Shopify-token (sett SHOPIFY_ADMIN_TOKEN eller SHOPIFY_API_KEY+SHOPIFY_API_SECRET)" };
    } else {
      try {
        const payload = {
          order: {
            line_items: [{
              variant_id: LEGENDEKOPP_VARIANT_ID,
              quantity: 1,
              fulfillment_service: "manual",
              properties: [
                { name: "Seilnummer",     value: nr },
                { name: "Årstall",        value: ar },
                { name: "_gelato_direct", value: "true" },
                { name: "_TEST_ORDER",    value: "true" },
              ],
            }],
            email: "berntblankholm@gmail.com",
            financial_status: "paid",
            fulfillment_status: "fulfilled",
            note: `TEST-ORDRE | Navn: Test Testesen | Seilnummer: ${nr} | Årstall: ${ar}`,
            tags: "legendekopp,test,gelato-direct",
            shipping_address: {
              first_name: "Test", last_name: "Testesen",
              address1: "Testgata 1", zip: "0123", city: "Oslo", country: "Norway",
            },
          },
        };
        const res = await fetch(`https://${shop}/admin/api/2024-10/orders.json`, {
          method: "POST",
          headers: { "X-Shopify-Access-Token": token_shopify, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        results.shopify = {
          status:    res.status,
          orderId:   data?.order?.id   || null,
          orderName: data?.order?.name || null,
          error:     data?.errors      || null,
        };
      } catch (err) {
        results.shopify = { error: err.message };
      }
    }
  }

  // ── Gelato ──
  if (skipGelato) {
    results.gelato = { skipped: "skip_gelato=1 — ingen ekte Gelato-ordre opprettet" };
  } else {
    const gelatoKey  = process.env.GELATO_API_KEY;
    const productUid = process.env.GELATO_PRODUCT_UID || "mug_product_msz_15-oz_mmat_ceramic-white_col_white";

    if (!gelatoKey) {
      results.gelato = { skipped: "GELATO_API_KEY mangler" };
    } else {
      try {
        const ref = `test-kopp-${Date.now()}`;
        const gelatoPayload = {
          orderReferenceId:    ref,
          customerReferenceId: "berntblankholm@gmail.com",
          currency: "NOK",
          items: [{
            itemReferenceId: `mug-${ref}`,
            productUid,
            quantity: 1,
            fileUrl: artworkUrl,
          }],
          shippingAddress: {
            firstName: "Test", lastName: "Testesen",
            addressLine1: "Testgata 1", postCode: "0123", city: "Oslo",
            country: "NO", email: "berntblankholm@gmail.com",
          },
        };
        const res = await fetch("https://order.gelatoapis.com/v4/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-KEY": gelatoKey },
          body: JSON.stringify(gelatoPayload),
        });
        const data = await res.json();
        results.gelato = {
          status:      res.status,
          orderId:     data?.id,
          orderStatus: data?.status,
          error:       data?.message || null,
          ref,
        };
      } catch (err) {
        results.gelato = { error: err.message };
      }
    }
  }

  return Response.json(results, { status: 200 });
};

export const config = { path: "/api/test-kopp" };
