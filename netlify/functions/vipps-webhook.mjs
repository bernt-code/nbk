import { getStore } from "@netlify/blobs";
import { createHmac } from "crypto";

// SECURITY 2026-06-16: Webhook signaturverifisering.
// Vi støtter to mekanismer:
//   1. Shared secret som query-param ?secret=<VIPPS_WEBHOOK_SECRET>
//      — enkel og pragmatisk, krever bare at Vipps Webhooks-konfigurasjon
//      bruker URL'en med secret-paramet
//   2. (Fremtidig) HMAC-signatur fra Vipps via Authorization header
//      — krever at webhook registreres via Vipps Webhooks API
function verifyWebhookAuth(req) {
  const expected = process.env.VIPPS_WEBHOOK_SECRET;
  if (!expected) {
    // Backward-compat: hvis ikke konfigurert ennå, logg advarsel og slipp gjennom
    // (vi vil aktivere strikt validering når Bernt har satt env-variabelen)
    console.warn("VIPPS_WEBHOOK_SECRET ikke satt — webhook godtar alle requests");
    return true;
  }
  const url = new URL(req.url);
  const provided = url.searchParams.get("secret") || "";
  if (provided.length !== expected.length) return false;
  // Konstant-tids sammenligning
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  // EMERGENCY HOTFIX 2026-06-16: Log-only-mode for webhook secret-sjekk.
  // VIPPS_WEBHOOK_SECRET er satt i env, men vi vet ikke om Vipps sender
  // den i URL-en hos webhook-konfigurasjonen deres. Inntil verifisert,
  // logger vi auth-status men avviser ikke (for å ikke brekke aktive
  // medlemskaps-flyter).
  // TODO: når vi har verifisert at Vipps sender ?secret=... korrekt,
  // bytt console.warn tilbake til `return new Response("Forbidden", { status: 403 })`.
  if (!verifyWebhookAuth(req)) {
    console.warn("Webhook auth WOULD have failed — currently in log-only mode. Verify Vipps webhook config sends ?secret=...");
  }

  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const event = await req.json();
    // Logg kun nøkkelfelt, ikke fullt payload (kan inneholde sensitiv brukerdata)
  console.log("Vipps webhook received:", event.name, event.reference || event.agreementId || event.chargeId || "");

    // Vipps sender forskjellige event-typer.
    // ePayment: { reference, name: "epayments.payment.*" }
    // Recurring agreement: { agreementId, name: "recurring.agreement-activated.v1", ... }
    // Recurring charge: { agreementId, chargeId, name: "recurring.charge-captured.v1", ... }

    const eventName = event?.name || "UNKNOWN";

    // ── Recurring agreement-events (medlemskap) ──
    if (eventName.startsWith("recurring.agreement")) {
      return await handleAgreementEvent(event);
    }

    // ── Recurring charge-events (årlig fornyelse) ──
    if (eventName.startsWith("recurring.charge")) {
      return await handleChargeEvent(event);
    }

    // ── ePayment-events (seilnummer + shop) ──
    const reference = event?.reference;
    if (!reference) {
      return Response.json({ error: "Missing reference" }, { status: 400 });
    }

    const orders = getStore("orders");
    const orderData = await orders.get(reference, { type: "json" });
    if (!orderData) {
      console.error(`Order not found for reference: ${reference}`);
      return Response.json({ error: "Order not found" }, { status: 404 });
    }

    const paymentStatus = event?.pspReference ? "AUTHORIZED" : eventName;

    if (paymentStatus === "AUTHORIZED" || paymentStatus === "epayments.payment.captured.v1") {
      if (orderData.type === "sail-number") await handleSailNumberPayment(reference, orderData);
      else if (orderData.type === "shop-order") await handleShopOrderPayment(reference, orderData);
      orderData.status = "paid";
      orderData.paidAt = new Date().toISOString();
      await orders.set(reference, JSON.stringify(orderData));
    } else if (paymentStatus === "CANCELLED" || paymentStatus === "epayments.payment.cancelled.v1") {
      if (orderData.type === "sail-number") await releaseSailNumber(orderData.number);
      orderData.status = "cancelled";
      orderData.cancelledAt = new Date().toISOString();
      await orders.set(reference, JSON.stringify(orderData));
    }

    return Response.json({ received: true });
  } catch (err) {
    console.error("Vipps webhook error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
};

// ─────────────────────────────────────────────
// Membership / Recurring handlers
// ─────────────────────────────────────────────
async function handleAgreementEvent(event) {
  const eventName = event.name;
  const agreementId = event.agreementId;
  console.log(`Recurring agreement event: ${eventName} for ${agreementId}`);

  // Finn membership-order basert på agreementId
  const orders = getStore("orders");
  // Vi må iterere — orders har reference som nøkkel, vi lagret agreementId i innholdet
  // Bedre løsning: sett opp en agreements-blob som mapper agreementId → reference
  const agreements = getStore("agreements");
  let reference = await agreements.get(agreementId);

  if (!reference) {
    // Første gang vi ser denne agreementId — finn via order-payload
    const list = await orders.list();
    for (const item of (list.blobs || [])) {
      const data = await orders.get(item.key, { type: "json" });
      if (data?.agreementId === agreementId) {
        reference = item.key;
        await agreements.set(agreementId, reference);
        break;
      }
    }
  }

  if (!reference) {
    // FALLBACK 2026-05-31: matching via agreementId scan kan feile pga.
    // race condition (webhook kommer før order.agreementId lagres) eller
    // hvis order ble opprettet uten endelig agreementId. Søk i registry
    // etter pending-membership reservasjon som ikke har blitt fullført.
    console.warn(`No order via agreementId scan — trying registry fallback for ${agreementId}`);
    const sailStoreFallback = getStore("sail-numbers");
    const registryFallback = await sailStoreFallback.get("registry", { type: "json" });
    if (registryFallback) {
      const pending = registryFallback.numbers.filter(n =>
        n.status === "reserved" &&
        n.reservedReason === "pending-membership" &&
        n.pendingMembershipReference
      );
      console.log(`Pending-membership candidates: ${pending.length}`);
      // Hvis nøyaktig én pending finnes, anta at det er denne
      if (pending.length === 1) {
        const candidateRef = pending[0].pendingMembershipReference;
        const candidateOrder = await orders.get(candidateRef, { type: "json" });
        if (candidateOrder) {
          candidateOrder.agreementId = agreementId;
          await orders.set(candidateRef, JSON.stringify(candidateOrder));
          await agreements.set(agreementId, candidateRef);
          reference = candidateRef;
          console.log(`Fallback match: ${reference} (single pending reservation)`);
        }
      } else if (pending.length > 1) {
        // Flere pending — log alle, men ikke gjett
        console.error(`Multiple pending-membership reservations (${pending.length}) — cannot disambiguate. Numbers: ${pending.map(p => p.number).join(", ")}`);
      }
    }
  }

  if (!reference) {
    console.error(`No membership order found for agreementId: ${agreementId} (registry fallback also failed)`);
    return Response.json({ received: true, note: "agreement not matched" });
  }

  const order = await orders.get(reference, { type: "json" });
  if (!order) return Response.json({ received: true });

  if (eventName === "recurring.agreement-activated.v1") {
    // Legendekopp-avtale: lag Shopify-ordre slik at Gelato-appen trykker koppen,
    // og marker som aktiv. Ingen medlems-/nummerlogikk for denne typen.
    if (order.type === "legendekopp") {
      await createShopifyMugOrder(order, reference);
      order.status = "active";
      order.activatedAt = new Date().toISOString();
      await orders.set(reference, JSON.stringify(order));
      console.log(`Legendekopp-avtale aktivert: ${order.navn} (${reference})`);
      return Response.json({ received: true });
    }

    // Avtale aktivert — lagre som aktivt medlem
    const members = getStore("members");
    const memberData = {
      email: order.email,
      name: order.name,
      phone: order.phone,
      tier: order.tier,
      agreementId,
      activatedAt: new Date().toISOString(),
      reference,
      numberReserved: null,
    };

    // Hvis det var pending nummer-valg(er), fullfør reservasjonen(e)
    // Aktiv: ett nummer i order.reserveNumber
    // Familie: flere numre i order.members[{number,name}]
    const sailStore = getStore("sail-numbers");
    const registry = await sailStore.get("registry", { type: "json" });
    if (registry) {
      // Bygg liste av numre vi forventer å fullføre
      let expected = [];
      if (order.reserveNumber) {
        expected = [{ number: Number(order.reserveNumber), name: order.name }];
      } else if (Array.isArray(order.members)) {
        expected = order.members.map(m => ({ number: Number(m.number), name: m.name }));
      }

      const completed = [];
      for (const target of expected) {
        const entry = registry.numbers.find(n => n.number === target.number);
        if (entry && entry.pendingMembershipReference === reference) {
          entry.status = "taken";
          entry.owner = target.name; // person-navnet for hvert nummer
          entry.memberEmail = order.email;
          entry.purchasedAt = new Date().toISOString();
          entry.purchaseReference = reference;
          delete entry.reservedBy;
          delete entry.reservedEmail;
          delete entry.reservedPhone;
          delete entry.reservedAt;
          delete entry.reservedReason;
          delete entry.pendingMembershipReference;
          completed.push(target.number);
        }
      }

      if (completed.length > 0) {
        registry.lastUpdated = new Date().toISOString();
        await sailStore.set("registry", JSON.stringify(registry));
        memberData.numbersReserved = completed;
        memberData.numbersReservedAt = new Date().toISOString();
        // Backward-compat for aktiv tier
        if (completed.length === 1) memberData.numberReserved = completed[0];
        console.log(`Tildelt ${completed.length} nummer (${completed.join(", ")}) via membership-flyt (${order.tier})`);
      }
    }

    await members.set(order.email.toLowerCase(), JSON.stringify(memberData));
    order.status = "active";
    order.activatedAt = new Date().toISOString();
    await orders.set(reference, JSON.stringify(order));
    console.log(`Membership activated: ${order.name} (${order.tier})`);
  } else if (eventName === "recurring.agreement-rejected.v1" ||
             eventName === "recurring.agreement-stopped.v1") {
    // Avtale avvist/stoppet — frigi pending nummer hvis det finnes (ett eller flere)
    const expectedNums = [];
    if (order.reserveNumber) expectedNums.push(Number(order.reserveNumber));
    if (Array.isArray(order.members)) expectedNums.push(...order.members.map(m => Number(m.number)));
    if (expectedNums.length > 0) {
      const sailStore = getStore("sail-numbers");
      const registry = await sailStore.get("registry", { type: "json" });
      if (registry) {
        for (const num of expectedNums) {
          const entry = registry.numbers.find(n => n.number === num);
          if (entry && entry.pendingMembershipReference === reference) {
            entry.status = "available";
            delete entry.reservedBy;
            delete entry.reservedEmail;
            delete entry.reservedPhone;
            delete entry.reservedAt;
            delete entry.reservedReason;
            delete entry.pendingMembershipReference;
          }
        }
        registry.lastUpdated = new Date().toISOString();
        await sailStore.set("registry", JSON.stringify(registry));
        console.log(`${expectedNums.length} nummer frigitt (${expectedNums.join(", ")}) — avtale ${eventName}`);
      }
    }
  }

  return Response.json({ received: true });
}

async function handleChargeEvent(event) {
  const eventName = event.name;
  const agreementId = event.agreementId;
  const chargeId = event.chargeId;
  console.log(`Recurring charge event: ${eventName} for agreement ${agreementId}`);

  const members = getStore("members");
  // Vi vet ikke email direkte fra event, må slå opp via agreements-blob
  const agreements = getStore("agreements");
  const reference = await agreements.get(agreementId);
  const orders = getStore("orders");
  const order = reference ? await orders.get(reference, { type: "json" }) : null;

  if (order?.email) {
    const member = await members.get(order.email.toLowerCase(), { type: "json" });
    if (member) {
      member.lastChargeAt = new Date().toISOString();
      member.lastChargeId = chargeId;
      member.lastChargeStatus = eventName;
      await members.set(order.email.toLowerCase(), JSON.stringify(member));
    }
  }

  return Response.json({ received: true });
}

// ─────────────────────────────────────────────
// Sail-number + shop handlers (uendret)
// ─────────────────────────────────────────────
async function handleSailNumberPayment(reference, order) {
  const store = getStore("sail-numbers");
  let registry;
  try { registry = await store.get("registry", { type: "json" }); } catch { return; }
  if (!registry) return;

  const entry = registry.numbers.find((n) => n.number === order.number);
  if (entry) {
    entry.status = "taken";
    entry.owner = order.buyerName;
    entry.reservedBy = undefined;
    entry.reservedEmail = undefined;
    entry.reservedPhone = undefined;
    entry.reservedAt = undefined;
    entry.purchasedAt = new Date().toISOString();
    entry.purchaseReference = reference;
    registry.lastUpdated = new Date().toISOString();
    await store.set("registry", JSON.stringify(registry));
    console.log(`Sail number NOR ${order.number} assigned to ${order.buyerName}`);
  }
}

async function releaseSailNumber(number) {
  const store = getStore("sail-numbers");
  let registry;
  try { registry = await store.get("registry", { type: "json" }); } catch { return; }
  if (!registry) return;

  const entry = registry.numbers.find((n) => n.number === number);
  if (entry && entry.status === "reserved") {
    entry.status = "available";
    entry.owner = null;
    entry.reservedBy = undefined;
    entry.reservedEmail = undefined;
    entry.reservedPhone = undefined;
    entry.reservedAt = undefined;
    registry.lastUpdated = new Date().toISOString();
    await store.set("registry", JSON.stringify(registry));
    console.log(`Sail number NOR ${number} released back to available`);
  }
}

async function handleShopOrderPayment(reference, order) {
  if (!process.env.GELATO_API_KEY) return;
  try {
    const gelatoOrder = await fetch("https://order.gelatoapis.com/v4/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": process.env.GELATO_API_KEY },
      body: JSON.stringify({
        orderReferenceId: reference,
        customerReferenceId: order.buyerEmail,
        currency: "NOK",
        items: [{ itemReferenceId: `mug-${reference}`, productUid: order.productUid, quantity: 1, fileUrl: order.designUrl }],
        shippingAddress: order.shippingAddress,
      }),
    });
    const result = await gelatoOrder.json();
    const orders = getStore("orders");
    order.gelatoOrderId = result.id;
    order.gelatoStatus = "submitted";
    await orders.set(reference, JSON.stringify(order));
  } catch (err) {
    console.error("Failed to create Gelato order:", err);
  }
}


// ─────────────────────────────────────────────
// Legendekopp-fulfillment: opprett en betalt Shopify-ordre via Admin API.
// Gelato-appen som er koblet til butikken plukker opp ordren og trykker koppen.
// Personaliseringen (nummer + årstall) legges i ordre-notatet, akkurat som ved
// et vanlig kasse-kjøp via cart-permalink.
// ─────────────────────────────────────────────
const LEGENDEKOPP_VARIANT_ID = 51936344375582;

export async function getShopifyAccessToken(shop) {
  // Dev Dashboard-apper gir ikke et statisk Admin API-token. Vi henter et ferskt
  // token via client_credentials-grant (client_id + client_secret). Faller tilbake
  // til statisk SHOPIFY_ADMIN_TOKEN hvis satt (bakoverkompatibelt).
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  const client_id = process.env.SHOPIFY_API_KEY;
  const client_secret = process.env.SHOPIFY_API_SECRET;
  if (!client_id || !client_secret) {
    console.error("SHOPIFY_API_KEY/SHOPIFY_API_SECRET mangler — kan ikke hente Shopify-token");
    return null;
  }
  try {
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id, client_secret, grant_type: "client_credentials" }),
    });
    const data = await res.json();
    if (!data.access_token) {
      console.error("Shopify client_credentials feilet:", JSON.stringify(data));
      return null;
    }
    return data.access_token;
  } catch (err) {
    console.error("getShopifyAccessToken error:", err);
    return null;
  }
}

export async function createShopifyMugOrder(order, reference) {
  const shop = process.env.SHOPIFY_STORE_DOMAIN; // f.eks. ruju69-80.myshopify.com
  if (!shop) {
    console.error("SHOPIFY_STORE_DOMAIN mangler — kan ikke lage kopp-ordre");
    return;
  }
  const token = await getShopifyAccessToken(shop);
  if (!token) {
    console.error("Kunne ikke skaffe Shopify Admin-token — kan ikke lage kopp-ordre");
    return;
  }

  const note = [
    `Navn: ${order.mottakerNavn || order.navn}`,
    `Seilnummer: ${order.seilnummer}`,
    `Årstall: ${order.arstall || ""}`,
    `Leveringsadresse: ${order.adresse}`,
    `Legendevegg: ${order.visningsnavn || ""}`,
    order.isGift ? `Gave fra: ${order.giverNavn || order.navn}` : "",
  ].filter(Boolean).join(" | ");

  // adresse "Gateveien 1, 0123 Oslo" → gate / postnr / by
  const parts = (order.adresse || "").split(",");
  const street = (parts[0] || "").trim();
  const zipCity = (parts[1] || "").trim().split(/\s+/);
  const zip = zipCity[0] || "";
  const city = zipCity.slice(1).join(" ");
  const nameParts = (order.navn || "").trim().split(/\s+/);
  const lastName = nameParts.length > 1 ? nameParts.pop() : "";
  const firstName = nameParts.join(" ");

  // ── Bygg artwork-URL for personalisert Gelato-trykk ──
  const siteUrl = process.env.SITE_URL || "https://nbk.no";
  const nrParam = encodeURIComponent(order.seilnummer || "NOR 0");
  const arParam = encodeURIComponent(String(order.arstall || new Date().getFullYear()));
  const adminSecret = process.env.ADMIN_TOKEN;
  const artworkToken = adminSecret
    ? createHmac("sha256", adminSecret)
        .update(`${order.seilnummer || "NOR 0"}:${String(order.arstall || new Date().getFullYear())}`)
        .digest("hex").slice(0, 16)
    : "";
  const artworkUrl = `${siteUrl}/api/kopp-print?nr=${nrParam}&ar=${arParam}&t=${artworkToken}&fmt=png`;

  // ── Shopify-ordre (for historikk/regnskap).
  //    Merker som "gelato-direct" slik at Gelato Shopify-appen ikke auto-fulfiller.
  const payload = {
    order: {
      line_items: [{
        variant_id: LEGENDEKOPP_VARIANT_ID,
        quantity: 1,
        properties: [
          { name: "Seilnummer", value: order.seilnummer || "" },
          { name: "Årstall", value: String(order.arstall || "") },
          { name: "_gelato_direct", value: "true" },
        ],
      }],
      email: order.email,
      financial_status: "paid",
      fulfillment_status: "fulfilled",
      note,
      tags: "legendekopp,vipps-recurring,gelato-direct",
      shipping_address: {
        first_name: firstName,
        last_name: lastName,
        address1: street,
        zip,
        city,
        country: "Norway",
      },
    },
  };

  try {
    const res = await fetch(`https://${shop}/admin/api/2024-10/orders.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    const orders = getStore("orders");
    order.shopifyOrderId = result?.order?.id || null;
    order.shopifyOrderName = result?.order?.name || null;
    order.fulfillment = result?.order?.id ? "shopify-order-created" : "shopify-order-failed";
    if (!result?.order?.id) console.error("Shopify ordre-opprettelse feilet:", JSON.stringify(result));
    await orders.set(reference, JSON.stringify(order));
    console.log(`Shopify kopp-ordre ${order.shopifyOrderName || "(ukjent)"} opprettet for ${reference}`);
  } catch (err) {
    console.error("createShopifyMugOrder error:", err);
  }

  // ── Gelato API: send personalisert trykk-ordre direkte ──
  await submitGelatoOrder(order, reference, artworkUrl);
}

// ─────────────────────────────────────────────
// submitGelatoOrder: kaller Gelato Orders API direkte med personalisert artwork.
// Omgår Gelato Shopify-appen (som bare kjenner til det statiske designet).
//
// Forutsetninger:
//   GELATO_API_KEY        — Gelato API-nøkkel (finnes i Netlify-env)
//   GELATO_PRODUCT_UID    — Gelato produkt-UID for 15oz hvit krus.
//                           Finn den i Gelato dashboard → Products → copy UID.
//                           Eksempel: "mug_product_msz_15-oz_mmat_ceramic-white_col_white"
// ─────────────────────────────────────────────
async function submitGelatoOrder(order, reference, artworkUrl) {
  const apiKey = process.env.GELATO_API_KEY;
  if (!apiKey) {
    console.error("submitGelatoOrder: GELATO_API_KEY mangler — kan ikke sende til Gelato");
    return;
  }

  const productUid = process.env.GELATO_PRODUCT_UID
    || "mug_product_msz_15-oz_mmat_ceramic-white_col_white";

  // Parse adresse "Gateveien 1, 0123 Oslo"
  const parts    = (order.adresse || "").split(",");
  const street   = (parts[0] || "").trim();
  const zipCity  = (parts[1] || "").trim().split(/\s+/);
  const zip      = zipCity[0] || "";
  const city     = zipCity.slice(1).join(" ");
  const nameParts = (order.navn || "").trim().split(/\s+/);
  const lastName  = nameParts.length > 1 ? nameParts.pop() : "";
  const firstName = nameParts.join(" ");

  const gelatoPayload = {
    orderReferenceId: `legendekopp-${reference}`,
    customerReferenceId: order.email,
    currency: "NOK",
    items: [{
      itemReferenceId: `mug-${reference}`,
      productUid,
      quantity: 1,
      fileUrl: artworkUrl,
    }],
    shippingAddress: {
      firstName,
      lastName,
      addressLine1: street,
      postCode: zip,
      city,
      country: "NO",
      email: order.email,
    },
  };

  try {
    const res = await fetch("https://order.gelatoapis.com/v4/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify(gelatoPayload),
    });
    const result = await res.json();
    const orders = getStore("orders");
    const saved  = await orders.get(reference, { type: "json" }) || order;
    if (result.id) {
      saved.gelatoOrderId     = result.id;
      saved.gelatoStatus      = result.status || "submitted";
      saved.gelatoArtworkUrl  = artworkUrl;
      console.log(`Gelato ordre ${result.id} opprettet for ${reference} (${order.seilnummer} / ${order.arstall})`);
    } else {
      console.error("submitGelatoOrder feilet:", JSON.stringify(result));
      saved.gelatoStatus = "failed";
      saved.gelatoError  = JSON.stringify(result);
    }
    await orders.set(reference, JSON.stringify(saved));
    return result;
  } catch (err) {
    console.error("submitGelatoOrder exception:", err);
  }
}
