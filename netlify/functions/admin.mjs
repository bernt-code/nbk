import { getStore } from "@netlify/blobs";

// ── Auth ──────────────────────────────────────────────────────────────────
function checkAuth(req) {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  const adminToken = process.env.ADMIN_TOKEN;
  return adminToken && token === adminToken;
}

// ── Vipps token ───────────────────────────────────────────────────────────
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
  if (!data.access_token) throw new Error("Vipps auth failed: " + JSON.stringify(data));
  return data.access_token;
}

function vippsHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Ocp-Apim-Subscription-Key": process.env.VIPPS_SUBSCRIPTION_KEY,
    "Merchant-Serial-Number": process.env.VIPPS_MSN,
    "Content-Type": "application/json",
    "Vipps-System-Name": "nbk-admin",
    "Vipps-System-Version": "1.0.0",
  };
}

// ── Registry helpers ───────────────────────────────────────────────────────
async function loadRegistry() {
  const store = getStore("sail-numbers");
  const blob = await store.get("registry", { type: "json" });
  if (!blob) throw new Error("Registry blob not found");
  return { store, registry: blob };
}

async function saveRegistry(store, registry) {
  registry.lastUpdated = new Date().toISOString();
  await store.set("registry", JSON.stringify(registry));
}

// ── Main handler ───────────────────────────────────────────────────────────
export default async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (!checkAuth(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  try {
    // ── GET /api/admin/numbers ─────────────────────────────────────────────
    if (req.method === "GET" && path.endsWith("/numbers")) {
      const { registry } = await loadRegistry();
      const ordersStore = getStore("orders");

      // Enrich taken/reserved entries with email from orders store
      const numbers = await Promise.all(
        registry.numbers.map(async (n) => {
          if (n.purchaseReference) {
            try {
              const order = await ordersStore.get(n.purchaseReference, { type: "json" });
              if (order) {
                return {
                  ...n,
                  ownerEmail: n.ownerEmail || order.buyerEmail || null,
                  ownerPhone: n.ownerPhone || order.buyerPhone || null,
                };
              }
            } catch {
              // order not found — fine
            }
          }
          return n;
        })
      );

      const taken = numbers.filter((n) => n.status === "taken").length;
      const reserved = numbers.filter((n) => n.status === "reserved").length;
      const available = numbers.filter((n) => n.status === "available").length;

      return Response.json({
        lastUpdated: registry.lastUpdated,
        stats: { taken, reserved, available, total: numbers.length },
        numbers,
      });
    }

    // ── POST /api/admin/release ────────────────────────────────────────────
    if (req.method === "POST" && path.endsWith("/release")) {
      const body = await req.json();
      const { number } = body;

      if (number === undefined) {
        return Response.json({ error: "Missing number" }, { status: 400 });
      }

      const { store, registry } = await loadRegistry();
      const entry = registry.numbers.find((n) => n.number === number);

      if (!entry) {
        return Response.json({ error: `NOR ${number} not found` }, { status: 404 });
      }

      const prevOwner = entry.owner;
      entry.status = "available";
      entry.owner = null;
      entry.ownerEmail = undefined;
      entry.ownerPhone = undefined;
      entry.purchaseReference = undefined;
      entry.purchasedAt = undefined;
      entry.reservedBy = undefined;
      entry.reservedEmail = undefined;
      entry.reservedPhone = undefined;
      entry.reservedAt = undefined;
      entry.releasedAt = new Date().toISOString();

      await saveRegistry(store, registry);

      console.log(`Admin released NOR ${number} (was: ${prevOwner})`);
      return Response.json({ success: true, number, prevOwner });
    }

    // ── POST /api/admin/charge ─────────────────────────────────────────────
    // Creates a new Vipps ePayment link for a sail number (annual renewal)
    if (req.method === "POST" && path.endsWith("/charge")) {
      const body = await req.json();
      const { number, ownerName, amount = 10000 } = body;
      // amount in øre — default 100 NOK

      if (!number || !ownerName) {
        return Response.json({ error: "Missing number or ownerName" }, { status: 400 });
      }

      const token = await getVippsToken();
      const reference = `sail-${number}-${Date.now()}`;
      const siteUrl = process.env.SITE_URL || "https://nbk-no.netlify.app";

      const paymentRes = await fetch("https://api.vipps.no/epayment/v1/payments", {
        method: "POST",
        headers: {
          ...vippsHeaders(token),
          "Idempotency-Key": reference,
        },
        body: JSON.stringify({
          amount: { currency: "NOK", value: amount },
          paymentMethod: { type: "WALLET" },
          reference,
          paymentDescription: `Seilnummer NOR ${number} – Årsavgift ${new Date().getFullYear()}`,
          userFlow: "WEB_REDIRECT",
          returnUrl: `${siteUrl}/api/vipps-callback?reference=${reference}`,
        }),
      });

      const payment = await paymentRes.json();

      if (!payment.redirectUrl) {
        console.error("Vipps charge creation failed:", JSON.stringify(payment));
        return Response.json(
          { error: "Vipps payment creation failed", details: payment },
          { status: 502 }
        );
      }

      // Store order for webhook processing
      const ordersStore = getStore("orders");
      await ordersStore.set(
        reference,
        JSON.stringify({
          type: "sail-number",
          number,
          buyerName: ownerName,
          buyerEmail: body.ownerEmail || null,
          buyerPhone: body.ownerPhone || null,
          amount,
          createdAt: new Date().toISOString(),
          isRenewal: true,
          initiatedBy: "admin",
        })
      );

      console.log(`Admin created charge for NOR ${number} (${ownerName}): ${reference}`);
      return Response.json({
        success: true,
        reference,
        redirectUrl: payment.redirectUrl,
        amount,
      });
    }

    // ── PATCH /api/admin/number ────────────────────────────────────────────
    // Manually update owner name, email, phone, status, or legend flag
    if (req.method === "PATCH" && path.endsWith("/number")) {
      const body = await req.json();
      const { number } = body;

      if (number === undefined) {
        return Response.json({ error: "Missing number" }, { status: 400 });
      }

      const { store, registry } = await loadRegistry();
      let entry = registry.numbers.find((n) => n.number === number);
      let isNew = false;

      if (!entry) {
        // Upsert — create new entry if not found
        entry = { number, status: "taken", owner: null };
        registry.numbers.push(entry);
        registry.numbers.sort((a, b) => a.number - b.number);
        isNew = true;
      }

      // Apply only fields that were sent
      if (body.owner !== undefined) entry.owner = body.owner;
      if (body.ownerEmail !== undefined) entry.ownerEmail = body.ownerEmail;
      if (body.ownerPhone !== undefined) entry.ownerPhone = body.ownerPhone;
      if (body.status !== undefined) entry.status = body.status;
      if (body.isLegend !== undefined) entry.isLegend = body.isLegend;
      if (body.legendHolder !== undefined) entry.legendHolder = body.legendHolder;
      if (body.requiresApplication !== undefined) entry.requiresApplication = body.requiresApplication;
      entry.updatedAt = new Date().toISOString();

      await saveRegistry(store, registry);

      console.log(`Admin ${isNew ? "inserted" : "updated"} NOR ${number}:`, JSON.stringify(body));
      return Response.json({ success: true, entry, isNew });
    }

    // ── GET /api/admin/recurring ──────────────────────────────────────────
    // List all Vipps Recurring agreements, enriched with phone + crossref
    if (req.method === "GET" && path.endsWith("/recurring")) {
      const vippsToken = await getVippsToken();
      const status = url.searchParams.get("status") || "ACTIVE";

      const res = await fetch(
        `https://api.vipps.no/recurring/v3/agreements?status=${status}`,
        { headers: vippsHeaders(vippsToken) }
      );
      const data = await res.json();

      if (!res.ok) {
        console.error("Vipps Recurring error:", JSON.stringify(data));
        return Response.json({ error: "Vipps Recurring API feil", details: data }, { status: 502 });
      }

      const agreements = Array.isArray(data) ? data : [];

      // Extract phone number from vippsConfirmationUrl JWT payload
      function extractPhone(agreement) {
        try {
          const jwt = agreement.vippsConfirmationUrl;
          if (!jwt) return null;
          const parts = jwt.split("token=");
          if (parts.length < 2) return null;
          const token = parts[1].split(".")[1]; // JWT payload
          const payload = JSON.parse(atob(token));
          return payload.mob ? String(payload.mob) : null;
        } catch { return null; }
      }

      // Extract NOR number from productName e.g. "NOR 18" → 18
      function extractNumber(agreement) {
        const m = (agreement.productName || "").match(/NOR\s+(\d+)/i);
        return m ? parseInt(m[1]) : null;
      }

      // Load registry to cross-reference
      const { registry } = await loadRegistry();
      const registryByNumber = {};
      for (const n of registry.numbers) registryByNumber[n.number] = n;

      // Enrich agreements
      const activeNorNumbers = new Set();
      const enriched = agreements.map(a => {
        const phone = extractPhone(a);
        const norNumber = extractNumber(a);
        if (norNumber !== null && status === "ACTIVE") activeNorNumbers.add(norNumber);
        const regEntry = norNumber !== null ? registryByNumber[norNumber] : null;
        return {
          id: a.id,
          norNumber,
          productName: a.productName,
          phone,
          status: a.status,
          amount: a.pricing?.amount ?? null,
          created: a.created,
          start: a.start,
          stop: a.stop,
          owner: regEntry?.owner ?? null,
          ownerEmail: regEntry?.ownerEmail ?? null,
        };
      });

      // Find taken numbers WITHOUT active recurring (only when fetching ACTIVE)
      let missingRecurring = [];
      if (status === "ACTIVE") {
        missingRecurring = registry.numbers
          .filter(n => n.status === "taken" && !n.isLegend && !activeNorNumbers.has(n.number))
          .map(n => ({ number: n.number, owner: n.owner, ownerEmail: n.ownerEmail, ownerPhone: n.ownerPhone }));
      }

      return Response.json({ success: true, agreements: enriched, missingRecurring, status });
    }

    // ── POST /api/admin/charge-all ────────────────────────────────────────
    // Send annual Vipps Recurring charge to all active agreements
    if (req.method === "POST" && path.endsWith("/charge-all")) {
      const body = await req.json().catch(() => ({}));
      const amountNOK = body.amountNOK || 200;
      const dueDate = body.dueDate || new Date().toISOString().slice(0, 10);
      const year = new Date(dueDate).getFullYear();
      const amount = Math.round(amountNOK * 100); // øre

      const vippsToken = await getVippsToken();

      // Fetch all active agreements
      const listRes = await fetch(
        "https://api.vipps.no/recurring/v3/agreements?status=ACTIVE",
        { headers: vippsHeaders(vippsToken) }
      );
      const agreements = await listRes.json();
      if (!Array.isArray(agreements)) {
        return Response.json({ error: "Kunne ikke hente avtaler fra Vipps" }, { status: 502 });
      }

      const results = { sent: [], skipped: [], failed: [] };

      for (const ag of agreements) {
        const norMatch = (ag.productName || "").match(/NOR\s+(\d+)/i);
        const norLabel = norMatch ? `NOR ${norMatch[1]}` : ag.productName || ag.id;
        const orderRef = `nbk-${(norLabel).replace(/\s+/g, "-").toLowerCase()}-${year}`;

        try {
          const chargeRes = await fetch(
            `https://api.vipps.no/recurring/v3/agreements/${ag.id}/charges`,
            {
              method: "POST",
              headers: { ...vippsHeaders(vippsToken), "Idempotency-Key": orderRef },
              body: JSON.stringify({
                amount,
                currency: "NOK",
                description: `${norLabel} – Årsavgift ${year}`,
                due: dueDate,
                retryDays: 5,
                orderReference: orderRef,
              }),
            }
          );
          const chargeData = await chargeRes.json();
          if (chargeRes.ok) {
            results.sent.push({ agreementId: ag.id, norLabel, chargeId: chargeData.chargeId });
          } else if (chargeRes.status === 409) {
            // Already charged this year (idempotency)
            results.skipped.push({ agreementId: ag.id, norLabel, reason: "allerede sendt" });
          } else {
            results.failed.push({ agreementId: ag.id, norLabel, error: chargeData });
          }
        } catch (e) {
          results.failed.push({ agreementId: ag.id, norLabel, error: e.message });
        }
      }

      console.log(`charge-all: ${results.sent.length} sent, ${results.skipped.length} skipped, ${results.failed.length} failed`);
      return Response.json({ success: true, year, dueDate, amountNOK, ...results });
    }

    // ── GET /api/admin/payment-status ─────────────────────────────────────
    // Check Vipps payment status for a reference
    if (req.method === "GET" && path.endsWith("/payment-status")) {
      const reference = url.searchParams.get("ref");
      if (!reference) {
        return Response.json({ error: "Missing ref param" }, { status: 400 });
      }

      const token = await getVippsToken();
      const res = await fetch(
        `https://api.vipps.no/epayment/v1/payments/${reference}`,
        { headers: vippsHeaders(token) }
      );
      const data = await res.json();
      return Response.json(data);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    console.error("Admin API error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
};

export const config = {
  path: ["/api/admin/:action*"],
};
