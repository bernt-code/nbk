// Sikkerhetsnett for legendekopp: sørger for at en betalt (ACTIVE) Vipps-avtale
// ALLTID får en Shopify-ordre, selv om agreement-activated-webhooken aldri
// fullførte. Kjøres automatisk på timeplan (hver time) som backstop, og kan
// trigges manuelt (admin-token) for testing/ops.
//
// Idempotent: behandler kun legendekopp-ordrer UTEN shopifyOrderId, og kun hvis
// den tilhørende Vipps-avtalen faktisk er ACTIVE (fullfører aldri en ubetalt).
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
  if (pending.length === 0) return report;

  // 2) Hent AKTIVE Vipps-avtaler — kun disse skal fullføres (aldri ubetalt)
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

  // 3) Fullfør de som har en ACTIVE avtale
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
