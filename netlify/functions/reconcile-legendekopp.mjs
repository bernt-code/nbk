// Sikkerhetsnett for legendekopp: sørger for at en betalt (ACTIVE) Vipps-avtale
// ALLTID får en Shopify-ordre, selv om agreement-activated-webhooken aldri
// fullførte. Kjøres automatisk på timeplan (hver time) som backstop, og kan
// trigges manuelt (admin-token) for testing/ops.
//
// Idempotent: behandler kun legendekopp-ordrer UTEN shopifyOrderId, og kun hvis
// den tilhørende Vipps-avtalen faktisk er ACTIVE (fullfører aldri en ubetalt).
//
// NB (2026-07-08): En Shopify-ordre med shopifyOrderId beviser IKKE at koppen
// faktisk er trykket/sendt av Gelato — gelato-direct-flyten merker Shopify-
// ordren "fulfilled" i samme øyeblikk den sendes til Gelato, ikke når Gelato
// bekrefter noe (verifisert: ordre #1009 har fulfillment.createdAt identisk
// med ordre.createdAt, og tom trackingInfo). Derfor gjør denne funksjonen nå
// i tillegg et ekte pull mot Gelato sitt Orders API (seksjon 4 under) for alle
// legendekopp-ordre som har fått en gelatoOrderId, og rapporterer reell
// fulfillmentStatus + sporing — uavhengig av om Shopify-ordren finnes.
import { getStore } from "@netlify/blobs";
import { createShopifyMugOrder } from "./vipps-webhook.mjs";

async function getVippsToken() {
  const res = await fetch("https://api.vipps.no/accesstoken/get", {
    method: "POST",
    headers: {
      "client_id": process.env.VIPPS_CLIENT_ID,
      "client_secret": process.env.VIPPS_CLIENT_SECRET,
      "Ocp-Apim-Subscription-Key": process.env.VIPPS_SUBSCRIPTION_KEY,
      "Merchant-Serial-Number": process.env.VIPPS_MSN,
    },
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Vipps auth failed");
  return data.access_token;
}

function vippsHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Ocp-Apim-Subscription-Key": process.env.VIPPS_SUBSCRIPTION_KEY,
    "Merchant-Serial-Number": process.env.VIPPS_MSN,
    "Vipps-System-Name": "nbk-reconcile",
    "Vipps-System-Version": "1.0.0",
  };
}

// ── Gelato-statusverifisering ──────────────────────────────────────────────
// Fulfillment-statuser Gelato bruker, se dashboard.gelato.com/docs/orders/order_details/.
// "Bekreftet sendt" (fysisk i frakt-kjeden) vs. "alarm" (krever oppfølging).
const GELATO_CONFIRMED_SHIPPED = new Set(["shipped", "in_transit", "delivered"]);
const GELATO_ALARM_STATUSES = new Set(["failed", "canceled", "on_hold", "returned"]);
// Hvor mange dager en ordre kan stå i en "underveis"-status (created/uploading/
// passed/in_production/printed/draft/pending_approval/pending_personalization/
// digitizing/not_connected) før vi flagger den som mistenkelig treg.
// Justerbar — ordre #1003 (første ekte ordre) fikk sporing i løpet av ~1 døgn.
const GELATO_STALE_DAYS = 5;

async function getGelatoOrder(gelatoOrderId) {
  const res = await fetch(`https://order.gelatoapis.com/v4/orders/${gelatoOrderId}`, {
    headers: { "Content-Type": "application/json", "X-API-KEY": process.env.GELATO_API_KEY },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gelato svarte ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// Verifiser én legendekopp-ordre mot Gelato sitt Orders API (reell status,
// ikke bare "har vi en Shopify-ordre"). Skriver cachet status tilbake på
// order-blobben kun når dryRun=false — samme kontrakt som resten av
// reconcile-funksjonen ("dryRun ⇒ ingen skriving").
async function verifyGelatoOrder(reference, order, dryRun, ordersStore) {
  const entry = { reference, gelatoOrderId: order.gelatoOrderId };
  let g;
  try {
    g = await getGelatoOrder(order.gelatoOrderId);
  } catch (e) {
    entry.error = "Gelato-kall feilet: " + (e?.message || e);
    return entry;
  }

  const pkg = g?.shipment?.packages?.[0] || null;
  const ageDays = order.createdAt
    ? (Date.now() - new Date(order.createdAt).getTime()) / 86400000
    : null;
  const status = g?.fulfillmentStatus || "ukjent";

  entry.fulfillmentStatus = status;
  entry.trackingCode = pkg?.trackingCode || null;
  entry.trackingUrl = pkg?.trackingUrl || null;
  entry.shipmentMethod = g?.shipment?.shipmentMethodName || null;
  entry.ageDays = ageDays !== null ? Math.round(ageDays * 10) / 10 : null;

  if (GELATO_ALARM_STATUSES.has(status)) {
    entry.alarm = true;
    entry.alarmReason = `Gelato-status "${status}" krever oppfølging`;
  } else if (!GELATO_CONFIRMED_SHIPPED.has(status) && ageDays !== null && ageDays > GELATO_STALE_DAYS) {
    entry.alarm = true;
    entry.alarmReason = `Fortsatt "${status}" etter ${entry.ageDays} dager — ingen bekreftet forsendelse ennå`;
  } else {
    entry.alarm = false;
  }

  if (!dryRun) {
    try {
      order.gelatoFulfillmentStatus = status;
      order.trackingCode = entry.trackingCode;
      order.trackingUrl = entry.trackingUrl;
      order.gelatoCheckedAt = new Date().toISOString();
      await ordersStore.set(reference, JSON.stringify(order));
    } catch {
      // Cache-skriving er best-effort — rapporten er allerede korrekt uansett.
    }
  }

  return entry;
}

function summarizeGelatoVerified(gelatoVerified) {
  const withStatus = gelatoVerified.filter((e) => !e.error);
  return {
    checked: withStatus.length,
    confirmedShipped: withStatus.filter((e) => GELATO_CONFIRMED_SHIPPED.has(e.fulfillmentStatus)).length,
    alarms: withStatus.filter((e) => e.alarm).length,
    errors: gelatoVerified.filter((e) => e.error).length,
  };
}

// Kjerne-logikk. dryRun=true ⇒ ingen skriving, kun rapport over hva som ville skjedd.
// Rapporten inneholder kun referanser/ordrenavn — ingen navn/epost/adresse.
export async function runReconcileLegendekopp({ dryRun = false } = {}) {
  const orders = getStore("orders");
  const agreementsMap = getStore("agreements");

  // 1) Finn legendekopp-ordrer som mangler Shopify-ordre
  const list = await orders.list();
  const pending = [];
  for (const item of (list.blobs || [])) {
    let o = null;
    try { o = await orders.get(item.key, { type: "json" }); } catch {}
    if (o && o.type === "legendekopp" && o.agreementId && !o.shopifyOrderId) {
      pending.push({ reference: item.key, order: o });
    }
  }

  const report = { dryRun, checked: (list.blobs || []).length, pending: pending.length, fulfilled: [], skipped: [] };

  // 2)+3) Hent AKTIVE Vipps-avtaler og fullfør pending — men KUN hvis det
  //    faktisk er noe pending. Dette er nå en "if" (var tidligere en "return"),
  //    slik at Gelato-verifiseringen i seksjon 4 alltid kjører, selv når
  //    pending=0 (det vanlige, daglige tilfellet).
  if (pending.length > 0) {
    let activeIds = new Set();
    try {
      const token = await getVippsToken();
      const res = await fetch("https://api.vipps.no/recurring/v3/agreements?status=ACTIVE", { headers: vippsHeaders(token) });
      const data = await res.json();
      if (Array.isArray(data)) activeIds = new Set(data.map((a) => a.id));
    } catch (e) {
      report.error = "Kunne ikke hente Vipps-avtaler: " + (e?.message || e);
      return report;
    }

    for (const { reference, order } of pending) {
      if (!activeIds.has(order.agreementId)) {
        report.skipped.push({ reference, reason: "avtale ikke ACTIVE" });
        continue;
      }
      if (dryRun) { report.fulfilled.push({ reference, willCreate: true }); continue; }
      try {
        await createShopifyMugOrder(order, reference); // setter shopifyOrderId + lagrer
        const fresh = await orders.get(reference, { type: "json" });
        if (fresh?.shopifyOrderId) {
          fresh.status = "active";
          fresh.activatedAt = fresh.activatedAt || new Date().toISOString();
          fresh.reconciledAt = new Date().toISOString();
          fresh.fulfillmentSource = fresh.fulfillmentSource || "reconcile";
          await orders.set(reference, JSON.stringify(fresh));
          try { await agreementsMap.set(order.agreementId, reference); } catch {}
          report.fulfilled.push({ reference, shopifyOrderName: fresh.shopifyOrderName || null });
        } else {
          report.skipped.push({ reference, reason: "Shopify-ordre feilet" });
        }
      } catch (e) {
        report.skipped.push({ reference, reason: "feil: " + (e?.message || e) });
      }
    }
  }

  // 4) NYTT (2026-07-08): reell Gelato-statusverifisering. Kjører ALLTID (også
  //    når pending=0), for ALLE legendekopp-ordre som har en gelatoOrderId —
  //    ikke bare de som var "pending" over. En Shopify-ordre alene beviser
  //    ikke fysisk forsendelse; dette henter reell status fra Gelato Orders
  //    API v4 (GET /v4/orders/{id}), som er lesing — trygt også ved dryRun.
  report.gelatoVerified = [];
  if (!process.env.GELATO_API_KEY) {
    report.gelatoVerified.push({ error: "GELATO_API_KEY mangler i miljøvariabler — kan ikke verifisere reell status" });
  } else {
    try {
      for (const item of (list.blobs || [])) {
        let o = null;
        try { o = await orders.get(item.key, { type: "json" }); } catch {}
        if (!o || o.type !== "legendekopp" || !o.gelatoOrderId) continue;
        const entry = await verifyGelatoOrder(item.key, o, dryRun, orders);
        report.gelatoVerified.push(entry);
      }
    } catch (e) {
      report.gelatoVerified.push({ error: "Uventet feil under Gelato-verifisering: " + (e?.message || e) });
    }
  }
  report.gelatoSummary = summarizeGelatoVerified(report.gelatoVerified);

  return report;
}

export default async (req) => {
  const url = new URL(req.url);
  // Scheduled-kjøring fra Netlify sender en POST med { next_run } i body.
  let scheduled = false;
  if (req.method === "POST") {
    try { const b = await req.text(); if (b && b.includes("next_run")) scheduled = true; } catch {}
  }
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const key = url.searchParams.get("key") || bearer;
  const isAdmin = !!process.env.ADMIN_TOKEN && key === process.env.ADMIN_TOKEN;
  // Muter kun ved scheduled-kjøring eller gyldig admin-token; ellers tørrkjør.
  const dryRun = url.searchParams.get("dryRun") === "true" || !(scheduled || isAdmin);
  try {
    const report = await runReconcileLegendekopp({ dryRun });
    return Response.json({ ok: true, scheduled, ...report });
  } catch (e) {
    console.error("reconcile-legendekopp error:", e);
    return Response.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
};

export const config = { schedule: "0 * * * *" };
