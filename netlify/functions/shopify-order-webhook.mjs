// /api/shopify/webhook — Shopify `orders/create`-webhook.
//
// BAKGRUNN (2026-09-11): «Opt ut av støtte» på /legendekoppen sender kunden rett
// til Shopify-kassen. Ordre #1011 (3.9.2026) gikk den veien og ble auto-fulfilt av
// Gelato-appen med produktets STANDARD-artwork — ikke kjøperens seilnummer/årstall.
// Notatet var riktig, men ingen kode hos oss lagde trykkfila.
//
// FIKS: Opt-ut-kassen bruker nå en EGEN Shopify-variant («NBK Legendekoppen –
// personalisert med ditt seilnummer», manuell fulfillment, ikke Gelato-synket).
// Gelato-appen ser den aldri. Denne webhooken plukker opp ordren, leser
// Seilnummer/Årstall ut av notatet og sender den personaliserte trykkfila til
// Gelato via nøyaktig samme submitGelatoOrder() som Vipps-flyten bruker.
//
// Sikkerhet: X-Shopify-Hmac-Sha256 verifiseres mot SHOPIFY_API_SECRET (webhooken
// er registrert av vår egen app via setup-shopify-webhook.mjs, så det er appens
// client secret som signerer). Uten gyldig signatur → 401.
//
// Idempotent: Shopify sender webhooks på nytt ved timeout. Vi lagrer ordre-bloben
// under nøkkel `shopify-<orderId>` og hopper over hvis Gelato-ordre allerede finnes.
import { createHmac, timingSafeEqual } from "crypto";
import { getStore } from "@netlify/blobs";
import { buildArtworkUrl, getShopifyAccessToken, submitGelatoOrder } from "./vipps-webhook.mjs";

// Varianter som skal personaliseres av OSS (manuell fulfillment, ikke Gelato-app).
// 59932864971038 = «NBK Legendekoppen – personalisert med ditt seilnummer» (opprettet 11.9.2026)
// Den gamle Gelato-synkede varianten (51936344375582) skal IKKE stå her: der
// auto-fulfiller Gelato-appen selv, og vi ville gitt kunden to kopper.
export const PERSONALISERT_VARIANT_IDS = new Set([59932864971038]);

function field(note, label) {
  const m = (note || "").match(new RegExp(label + ":\\s*([^|]+)"));
  return m ? m[1].trim() : "";
}

function verifyShopifyHmac(rawBody, headerValue) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret || !headerValue) return false;
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(headerValue);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Merk ordren fulfilled + tag'et, slik Vipps-flyten gjør ved opprettelse.
// (Fulfillment-recordet er en intern markør — reell forsendelse bekreftes kun via
// Gelato-status / sporing, jf. reconcile-legendekopp.)
async function tagAndFulfill(shop, token, orderId, existingTags, extraNote) {
  const base = `https://${shop}/admin/api/2024-10`;
  const headers = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
  try {
    const tags = new Set(String(existingTags || "").split(",").map(t => t.trim()).filter(Boolean));
    ["legendekopp", "opt-ut", "gelato-direct"].forEach(t => tags.add(t));
    await fetch(`${base}/orders/${orderId}.json`, {
      method: "PUT", headers,
      body: JSON.stringify({ order: { id: orderId, tags: [...tags].join(", "), note_attributes: extraNote } }),
    });
  } catch (err) {
    console.error("shopify-order-webhook: tagging feilet:", err);
  }
  try {
    const fo = await fetch(`${base}/orders/${orderId}/fulfillment_orders.json`, { headers }).then(r => r.json());
    const open = (fo.fulfillment_orders || []).filter(f => f.status === "open" || f.status === "in_progress");
    if (open.length) {
      await fetch(`${base}/fulfillments.json`, {
        method: "POST", headers,
        body: JSON.stringify({
          fulfillment: {
            notify_customer: false,
            line_items_by_fulfillment_order: open.map(f => ({ fulfillment_order_id: f.id })),
          },
        }),
      });
    }
  } catch (err) {
    console.error("shopify-order-webhook: fulfillment-markering feilet:", err);
  }
}

export default async (req) => {
  if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });

  const raw = await req.text();
  if (!verifyShopifyHmac(raw, req.headers.get("x-shopify-hmac-sha256"))) {
    console.warn("shopify-order-webhook: ugyldig HMAC");
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let o;
  try { o = JSON.parse(raw); } catch { return Response.json({ error: "Bad JSON" }, { status: 400 }); }

  const topic = req.headers.get("x-shopify-topic") || "";
  if (topic && topic !== "orders/create") return Response.json({ received: true, ignored: topic });

  // Kun ordrer med den personaliserte varianten. Alt annet (caps, Gelato-varianten,
  // våre egne Vipps-opprettede ordrer med tag gelato-direct) ignoreres.
  const tags = String(o.tags || "");
  if (/\bgelato-direct\b/.test(tags)) return Response.json({ received: true, ignored: "gelato-direct" });
  const mugItems = (o.line_items || []).filter(li => PERSONALISERT_VARIANT_IDS.has(Number(li.variant_id)));
  if (!mugItems.length) return Response.json({ received: true, ignored: "no personalised mug" });
  if (o.cancelled_at) return Response.json({ received: true, ignored: "cancelled" });
  if (o.financial_status && !["paid", "partially_refunded"].includes(o.financial_status)) {
    console.warn(`shopify-order-webhook: ${o.name} financial_status=${o.financial_status} — venter`);
    return Response.json({ received: true, ignored: `financial_status=${o.financial_status}` });
  }

  const reference = `shopify-${o.id}`;
  const orders = getStore("orders");
  const existing = await orders.get(reference, { type: "json" });
  if (existing?.gelatoOrderId) {
    return Response.json({ received: true, ignored: "already sent to Gelato", gelatoOrderId: existing.gelatoOrderId });
  }

  const note = o.note || "";
  const seilnummer = field(note, "Seilnummer");
  const arstall = field(note, "Årstall");
  const sa = o.shipping_address || o.billing_address || {};
  const navn = field(note, "Navn") || `${sa.first_name || ""} ${sa.last_name || ""}`.trim();
  const adresse = field(note, "Leveringsadresse") || `${sa.address1 || ""}, ${sa.zip || ""} ${sa.city || ""}`.trim();
  const email = (o.email || o.contact_email || "").toLowerCase();

  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const token = shop ? await getShopifyAccessToken(shop) : null;

  // Uten seilnummer kan vi ikke trykke. Tag ordren så den er synlig i admin, og stopp.
  // (Skjer hvis noen kjøper direkte i butikken utenom /legendekoppen.)
  if (!seilnummer || !/^\s*[A-Za-z-]+\s*\d+/.test(seilnummer)) {
    console.error(`shopify-order-webhook: ${o.name} mangler seilnummer i notatet — IKKE sendt til Gelato`);
    await orders.set(reference, JSON.stringify({
      type: "legendekopp", source: "shopify-optut", status: "mangler-seilnummer",
      shopifyOrderId: o.id, shopifyOrderName: o.name, navn, email, adresse, note,
      createdAt: new Date().toISOString(),
    }));
    if (shop && token) {
      try {
        const t = new Set(tags.split(",").map(x => x.trim()).filter(Boolean));
        t.add("legendekopp"); t.add("mangler-seilnummer");
        await fetch(`https://${shop}/admin/api/2024-10/orders/${o.id}.json`, {
          method: "PUT",
          headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
          body: JSON.stringify({ order: { id: o.id, tags: [...t].join(", ") } }),
        });
      } catch (err) { console.error("tag mangler-seilnummer feilet:", err); }
    }
    return Response.json({ received: true, error: "mangler seilnummer" });
  }

  const order = {
    type: "legendekopp",
    source: "shopify-optut",
    navn, email,
    seilnummer: seilnummer.replace(/\s+/g, " ").trim().toUpperCase(),
    arstall: arstall || null,
    adresse,
    visningsnavn: field(note, "Legendevegg") || null,
    isGift: /Gave fra:/.test(note),
    shopifyOrderId: o.id,
    shopifyOrderName: o.name,
    fulfillment: "shopify-order-created",
    status: "active",
    createdAt: o.created_at || new Date().toISOString(),
  };
  await orders.set(reference, JSON.stringify(order));

  const artworkUrl = buildArtworkUrl(order.seilnummer, order.arstall);
  const result = await submitGelatoOrder(order, reference, artworkUrl);
  const ok = !!(result && result.id);
  console.log(`shopify-order-webhook: ${o.name} → Gelato ${ok ? result.id : "FEILET"} (${order.seilnummer} / ${order.arstall})`);

  if (shop && token) {
    await tagAndFulfill(shop, token, o.id, tags, [
      { name: "Gelato-ordre", value: ok ? result.id : "FEILET — se Netlify-logg" },
      { name: "Trykk", value: `${order.seilnummer} / ${order.arstall || ""}` },
    ]);
  }

  return Response.json({ received: true, reference, gelatoOrderId: ok ? result.id : null });
};
