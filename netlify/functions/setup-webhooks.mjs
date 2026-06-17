// Engangs-admin-funksjon: rydd opp Vipps-webhooks
// Kjøres via: curl -H "Authorization: Bearer $ADMIN_TOKEN" "https://nbk-no.netlify.app/api/setup-webhooks"
//
// Hva den gjør:
//   1. Lister alle eksisterende webhooks
//   2. Sletter de som peker til gammel WooCommerce (www.nbk.no/wc-api/...)
//   3. Oppretter ny Recurring-webhook som peker til vår Netlify-function
//
// Trygg å kjøre flere ganger (idempotent — sjekker eksisterende først)

const WEBHOOK_PATHNAME = "/api/vipps/webhook";
const WEBHOOK_BASE = `https://nbk-no.netlify.app${WEBHOOK_PATHNAME}`;
// SECURITY 2026-06-16: Når VIPPS_WEBHOOK_SECRET er satt, registrer webhooken MED
// ?secret=... slik at vipps-webhook sin strikte secret-validering kan slås PÅ uten
// å brekke flyten (Vipps kaller da URL-en inkl. secret). Uten env: bare-URL (uendret).
// Merk: bytt en eksisterende bare-URL-webhook til secret ved å slette den og kjøre på nytt.
const NETLIFY_WEBHOOK_URL = process.env.VIPPS_WEBHOOK_SECRET
  ? `${WEBHOOK_BASE}?secret=${encodeURIComponent(process.env.VIPPS_WEBHOOK_SECRET)}`
  : WEBHOOK_BASE;
// Dedup på pathname (ignorer query) så vi ikke lager duplikate webhooks.
const samePath = (u) => { try { return new URL(u).pathname === WEBHOOK_PATHNAME; } catch { return false; } };

const RECURRING_EVENTS = [
  "recurring.agreement-activated.v1",
  "recurring.agreement-rejected.v1",
  "recurring.agreement-stopped.v1",
  "recurring.agreement-expired.v1",
  "recurring.charge-captured.v1",
  "recurring.charge-failed.v1",
  "recurring.charge-canceled.v1",
  "recurring.charge-reserved.v1",
];

const EPAYMENT_EVENTS = [
  "epayments.payment.aborted.v1",
  "epayments.payment.authorized.v1",
  "epayments.payment.cancelled.v1",
  "epayments.payment.captured.v1",
  "epayments.payment.created.v1",
  "epayments.payment.expired.v1",
  "epayments.payment.refunded.v1",
  "epayments.payment.terminated.v1",
];

function checkAuth(req) {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  return process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

async function vippsToken() {
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
  if (!data.access_token) throw new Error("Vipps auth failed: " + JSON.stringify(data));
  return data.access_token;
}

function vippsHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Ocp-Apim-Subscription-Key": process.env.VIPPS_SUBSCRIPTION_KEY,
    "Merchant-Serial-Number": process.env.VIPPS_MSN,
    "Content-Type": "application/json",
    "Vipps-System-Name": "nbk-website",
    "Vipps-System-Version": "1.0.0",
  };
}

export default async (req) => {
  if (!checkAuth(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "true";

  try {
    const token = await vippsToken();
    const headers = vippsHeaders(token);

    // 1. List alle eksisterende webhooks
    const listRes = await fetch("https://api.vipps.no/webhooks/v1/webhooks", { headers });
    const listData = await listRes.json();
    const webhooks = listData.webhooks || [];

    const result = {
      dryRun,
      existing: webhooks.map(w => ({
        id: w.id,
        url: w.url,
        events: w.events,
      })),
      actions: [],
    };

    // 2. Identifiser webhooks å slette (peker til gammel WooCommerce)
    const toDelete = webhooks.filter(w =>
      w.url.includes("nbk.no/wc-api/") ||
      w.url.includes("www.nbk.no/wp-")
    );

    for (const w of toDelete) {
      result.actions.push({ action: "delete", id: w.id, url: w.url });
      if (!dryRun) {
        const delRes = await fetch(`https://api.vipps.no/webhooks/v1/webhooks/${w.id}`, {
          method: "DELETE",
          headers,
        });
        result.actions[result.actions.length - 1].status = delRes.status;
      }
    }

    // 3. Sjekk om Recurring-webhook til Netlify allerede finnes
    const hasNetlifyRecurring = webhooks.some(w =>
      samePath(w.url) &&
      w.events.some(e => e.startsWith("recurring."))
    );

    if (!hasNetlifyRecurring) {
      result.actions.push({
        action: "create",
        url: NETLIFY_WEBHOOK_URL,
        events: RECURRING_EVENTS,
        purpose: "Recurring agreement + charge events for medlemskap",
      });
      if (!dryRun) {
        const createRes = await fetch("https://api.vipps.no/webhooks/v1/webhooks", {
          method: "POST",
          headers,
          body: JSON.stringify({
            url: NETLIFY_WEBHOOK_URL,
            events: RECURRING_EVENTS,
          }),
        });
        const created = await createRes.json();
        result.actions[result.actions.length - 1].status = createRes.status;
        result.actions[result.actions.length - 1].response = created;
      }
    } else {
      result.actions.push({
        action: "skip",
        reason: "Recurring-webhook til Netlify finnes allerede",
      });
    }

    // 4. Sjekk at ePayment-webhook også er der (skal være det)
    const hasNetlifyEpayment = webhooks.some(w =>
      samePath(w.url) &&
      w.events.some(e => e.startsWith("epayments."))
    );
    if (!hasNetlifyEpayment) {
      result.actions.push({
        action: "create",
        url: NETLIFY_WEBHOOK_URL,
        events: EPAYMENT_EVENTS,
        purpose: "ePayment events (sail-numbers + shop)",
      });
      if (!dryRun) {
        const createRes = await fetch("https://api.vipps.no/webhooks/v1/webhooks", {
          method: "POST",
          headers,
          body: JSON.stringify({
            url: NETLIFY_WEBHOOK_URL,
            events: EPAYMENT_EVENTS,
          }),
        });
        const created = await createRes.json();
        result.actions[result.actions.length - 1].status = createRes.status;
        result.actions[result.actions.length - 1].response = created;
      }
    }

    return Response.json(result);
  } catch (err) {
    console.error("setup-webhooks error:", err);
    return Response.json({ error: err.message, stack: err.stack }, { status: 500 });
  }
};
