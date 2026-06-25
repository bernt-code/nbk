import { createHmac } from "crypto";

// /api/test-kopp?t=<token>&nr=NOR+111&ar=1980
// Simulerer full Legendekopp-bestilling: Shopify-ordre + Gelato-ordre.
// Kun for admin-testing — fjern eller sperre etter verifisering.
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

  const nr = url.searchParams.get("nr") || "NOR 111";
  const ar = url.searchParams.get("ar") || "1980";

  // Bygg artwork-URL (samme logikk som i vipps-webhook.mjs)
  const artworkToken = createHmac("sha256", adminSecret).update(`${nr}:${ar}`).digest("hex").slice(0, 16);
  const siteUrl = process.env.SITE_URL || "https://nbk.no";
  const artworkUrl = `${siteUrl}/api/kopp-print?nr=${encodeURIComponent(nr)}&ar=${encodeURIComponent(ar)}&t=${artworkToken}&fmt=png`;

  const results = { nr, ar, artworkUrl, shopify: null, gelato: null };

  // ── Shopify ──
  const shop  = process.env.SHOPIFY_STORE_DOMAIN;
  const token_shopify = process.env.SHOPIFY_ADMIN_TOKEN;
  const LEGENDEKOPP_VARIANT_ID = 51936344375582;

  if (shop && token_shopify) {
    try {
      const payload = {
        order: {
          line_items: [{
            variant_id: LEGENDEKOPP_VARIANT_ID,
            quantity: 1,
            fulfillment_service: "manual",
            properties: [
              { name: "Seilnummer", value: nr },
              { name: "Årstall",    value: ar },
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
        status: res.status,
        orderId:   data?.order?.id   || null,
        orderName: data?.order?.name || null,
        error:     data?.errors      || null,
      };
    } catch (err) {
      results.shopify = { error: err.message };
    }
  } else {
    results.shopify = { skipped: "SHOPIFY_STORE_DOMAIN eller SHOPIFY_ADMIN_TOKEN mangler" };
  }

  // ── Gelato ──
  const gelatoKey = process.env.GELATO_API_KEY;
  const productUid = process.env.GELATO_PRODUCT_UID || "mug_product_msz_15-oz_mmat_ceramic-white_col_white";

  if (gelatoKey) {
    try {
      const ref = `test-kopp-${Date.now()}`;
      const gelatoPayload = {
        orderReferenceId: ref,
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
      results.gelato = { status: res.status, orderId: data?.id, orderStatus: data?.status, error: data?.message || null, ref };
    } catch (err) {
      results.gelato = { error: err.message };
    }
  } else {
    results.gelato = { skipped: "GELATO_API_KEY mangler" };
  }

  return Response.json(results, { status: 200 });
};

export const config = { path: "/api/test-kopp" };
