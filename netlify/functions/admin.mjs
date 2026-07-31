import { getStore } from "@netlify/blobs";

// ── Auth ──────────────────────────────────────────────────────────────────
import { timingSafeEqual } from "crypto";

function checkAuth(req) {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken || !token) return false;
  // Konstant-tids sammenligning for å unngå timing-angrep
  const a = Buffer.from(token);
  const b = Buffer.from(adminToken);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
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
      if (body.isJunior !== undefined) entry.isJunior = body.isJunior;

      // 2026-07-31: Feltene medlemsflyten normalt setter via agreement-activated-
      // webhooken. Uten disse teller ikke nummeret som BETALT MEDLEM i
      // /api/admin/numbers (som krever purchaseReference "member-*" + memberEmail),
      // og den daglige statussjekken ser ikke personen i det hele tatt.
      // Trengs for å fullføre for hånd et medlemskap som ER betalt, men som aldri
      // ble koblet — f.eks. avtale opprettet uten reserveNumber.
      if (body.memberEmail !== undefined) entry.memberEmail = body.memberEmail;
      if (body.purchaseReference !== undefined) entry.purchaseReference = body.purchaseReference;
      if (body.purchasedAt !== undefined) entry.purchasedAt = body.purchasedAt;
      if (body.payments !== undefined && body.payments && typeof body.payments === "object") {
        entry.payments = { ...(entry.payments || {}), ...body.payments };
      }

      // Rydd en fastlåst pending-reservasjon (f.eks. når webhooken ikke fullførte flippen)
      if (body.clearReservation === true) {
        delete entry.reservedBy;
        delete entry.reservedEmail;
        delete entry.reservedPhone;
        delete entry.reservedAt;
        delete entry.reservedReason;
        delete entry.pendingMembershipReference;
      }

      entry.updatedAt = new Date().toISOString();

      await saveRegistry(store, registry);

      // Redact email/phone fra logg
      const safeBody = { ...body };
      if (safeBody.ownerEmail) safeBody.ownerEmail = "[REDACTED]";
      if (safeBody.ownerPhone) safeBody.ownerPhone = "[REDACTED]";
      if (safeBody.memberEmail) safeBody.memberEmail = "[REDACTED]";
      console.log(`Admin ${isNew ? "inserted" : "updated"} NOR ${number}:`, JSON.stringify(safeBody));
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
      const amountNOK = body.amountNOK || 350;
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
                description: `${norLabel} – Seilnummer og medlemskap ${year}`,
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

    // ── POST /api/admin/populate-range ────────────────────────────────────
    // Batch-add seilnummer som "available" i et område. Hopper over numre
    // som allerede finnes (uansett status). Brukes ved utvidelse av registeret.
    // Body: { from: 503, to: 1000 } — begge inkluderte.
    if (req.method === "POST" && path.endsWith("/populate-range")) {
      const body = await req.json().catch(() => ({}));
      const from = Number(body.from);
      const to = Number(body.to);

      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > 99999) {
        return Response.json(
          { error: "Ugyldig from/to (heltall, 0 ≤ from ≤ to ≤ 99999)" },
          { status: 400 }
        );
      }
      if (to - from > 5000) {
        return Response.json(
          { error: "For stort område (maks 5000 numre per kall)" },
          { status: 400 }
        );
      }

      const { store, registry } = await loadRegistry();
      const existing = new Set(registry.numbers.map((n) => n.number));
      const added = [];

      for (let n = from; n <= to; n++) {
        if (!existing.has(n)) {
          registry.numbers.push({ number: n, status: "available" });
          added.push(n);
        }
      }

      // Sorter for ryddig listing
      registry.numbers.sort((a, b) => a.number - b.number);
      await saveRegistry(store, registry);

      console.log(`Admin populated range ${from}-${to}: ${added.length} new available numbers`);
      return Response.json({
        success: true,
        from,
        to,
        addedCount: added.length,
        skippedCount: (to - from + 1) - added.length,
        firstAdded: added.slice(0, 5),
        lastAdded: added.slice(-5),
        totalNumbersNow: registry.numbers.length,
      });
    }

    // ── POST /api/admin/stop-agreement ────────────────────────────────────
    // Stopper ÉN gammel Vipps Recurring-avtale (de gamle 200-«NOR <n>»-abonnementene).
    // SIKKERHETSSPERRE: stopper BARE avtaler med productName "NOR <n>" — ALDRI medlemskap.
    // Body: { agreementId: "agr_xxx" }
    if (req.method === "POST" && path.endsWith("/stop-agreement")) {
      const body = await req.json().catch(() => ({}));
      const { agreementId } = body;

      if (!agreementId || typeof agreementId !== "string") {
        return Response.json({ error: "Mangler agreementId" }, { status: 400 });
      }

      const vippsToken = await getVippsToken();

      // 1. Hent avtalen først, så vi vet HVA vi stopper
      const getRes = await fetch(
        `https://api.vipps.no/recurring/v3/agreements/${encodeURIComponent(agreementId)}`,
        { headers: vippsHeaders(vippsToken) }
      );
      const agreement = await getRes.json().catch(() => ({}));

      if (!getRes.ok) {
        console.error("stop-agreement: kunne ikke hente avtale", agreementId, JSON.stringify(agreement));
        return Response.json(
          { error: `Fant ikke avtale ${agreementId}`, details: agreement },
          { status: getRes.status === 404 ? 404 : 502 }
        );
      }

      // 2. SIKKERHETSSPERRE: kun gamle "NOR <n>"-avtaler, aldri medlemskap
      const productName = (agreement.productName || "").trim();
      const isOldNumberSub = /^NOR\s+\d+$/i.test(productName);
      const isMembership = /medlemskap/i.test(productName);
      if (!isOldNumberSub || isMembership) {
        return Response.json(
          {
            error: "Avslått av sikkerhetssperre",
            reason: `productName "${productName}" tillates ikke — stop-agreement stopper BARE gamle «NOR <n>»-avtaler, aldri medlemskap.`,
            agreementId,
            productName,
          },
          { status: 403 }
        );
      }

      // 3. Allerede stoppet? Ingenting å gjøre.
      if (agreement.status === "STOPPED") {
        return Response.json({ success: true, alreadyStopped: true, agreementId, productName, status: "STOPPED" });
      }

      // 4. Stopp avtalen (PATCH status=STOPPED)
      const patchRes = await fetch(
        `https://api.vipps.no/recurring/v3/agreements/${encodeURIComponent(agreementId)}`,
        {
          method: "PATCH",
          headers: { ...vippsHeaders(vippsToken), "Idempotency-Key": `stop-${agreementId}-${Date.now()}` },
          body: JSON.stringify({ status: "STOPPED" }),
        }
      );

      if (!patchRes.ok) {
        const errText = await patchRes.text();
        console.error("stop-agreement: PATCH feilet", agreementId, patchRes.status, errText.slice(0, 300));
        return Response.json(
          { error: `Kunne ikke stoppe avtale ${agreementId}`, vippsStatus: patchRes.status, details: errText.slice(0, 300) },
          { status: 502 }
        );
      }

      console.log(`Admin STOPPET avtale ${agreementId} (${productName})`);
      return Response.json({ success: true, agreementId, productName, prevStatus: agreement.status, status: "STOPPED" });
    }

    // ── POST /api/admin/reconcile-memberships ─────────────────────────────
    // Selvhelbredende opprydning: fullfør medlemskap som henger i
    // "pending-membership" fordi agreement-activated-webhooken aldri fullførte
    // koblingen (order-blob borte / cannot-disambiguate / webhook avvist).
    // For hver pending-reservasjon: finn den tilhørende AKTIVE Vipps-avtalen,
    // og skriv medlemmet inn i registeret med NØYAKTIG samme felt som webhooken
    // ville satt (status=taken, owner, memberEmail, purchaseReference, payments).
    // Trygg å kjøre flere ganger (idempotent — hopper over alt som ikke er pending).
    // Skriver ALDRI med mindre det finnes en matchende AKTIV avtale (aldri ubetalt).
    // ?dryRun=true gir forhåndsvisning uten å skrive.
    if (req.method === "POST" && path.endsWith("/reconcile-memberships")) {
      const dryRun = url.searchParams.get("dryRun") === "true";

      // 1. Hent AKTIVE Vipps Recurring-avtaler (kun medlemskap)
      const vippsToken = await getVippsToken();
      const agrRes = await fetch(
        "https://api.vipps.no/recurring/v3/agreements?status=ACTIVE",
        { headers: vippsHeaders(vippsToken) }
      );
      const agrData = await agrRes.json();
      if (!agrRes.ok || !Array.isArray(agrData)) {
        return Response.json({ error: "Kunne ikke hente Vipps-avtaler", details: agrData }, { status: 502 });
      }
      const memberAgreements = agrData.filter((a) =>
        /medlemskap|st(ø|o)ttemedlem/i.test(a.productName || "")
      );

      // 2. Last registry + tilstøtende blobs
      const { store, registry } = await loadRegistry();
      const ordersStore = getStore("orders");
      const membersStore = getStore("members");
      const agreementsMap = getStore("agreements");

      const tierFromProduct = (p) =>
        /familie/i.test(p) ? "familie" : /st(ø|o)tte/i.test(p) ? "stotte" : "aktiv";

      // 3. Grupper pending-reservasjoner på pendingMembershipReference
      //    (familie deler én reference på tvers av flere numre)
      const pendingEntries = registry.numbers.filter((n) =>
        n.reservedReason === "pending-membership" && n.pendingMembershipReference
      );
      const groups = {};
      for (const e of pendingEntries) {
        (groups[e.pendingMembershipReference] ||= []).push(e);
      }

      const report = { dryRun, groups: Object.keys(groups).length, completed: [], skipped: [] };
      let mutated = false;
      const TOL_MS = 10000; // toleranse for created≈reservedAt-match

      for (const [ref, entries] of Object.entries(groups)) {
        // Autoritativ kilde hvis order-blob fortsatt finnes
        let order = null;
        try { order = await ordersStore.get(ref, { type: "json" }); } catch {}

        // Finn matchende AKTIV avtale: via order.agreementId, ellers created≈reservedAt
        let agreement = null;
        if (order?.agreementId) {
          agreement = memberAgreements.find((a) => a.id === order.agreementId) || null;
        }
        if (!agreement) {
          const resTimes = entries.map((e) => Date.parse(e.reservedAt)).filter(Boolean);
          const t0 = resTimes.length ? Math.min(...resTimes) : null;
          if (t0 !== null) {
            let best = null, bestD = Infinity;
            for (const a of memberAgreements) {
              const d = Math.abs(Date.parse(a.created) - t0);
              if (d < bestD) { bestD = d; best = a; }
            }
            if (best && bestD <= TOL_MS) agreement = best;
          }
        }

        if (!agreement) {
          report.skipped.push({ ref, numbers: entries.map((e) => e.number), reason: "ingen matchende AKTIV Vipps-avtale" });
          continue;
        }

        const email = (order?.email || entries[0].reservedEmail || "").toLowerCase();
        if (!email) {
          report.skipped.push({ ref, numbers: entries.map((e) => e.number), reason: "mangler e-post" });
          continue;
        }
        const amount = order?.amount ?? agreement.pricing?.amount ?? null;
        const tier = order?.tier || tierFromProduct(agreement.productName || "");
        const year = String(new Date(agreement.created).getFullYear());

        // Navn for hvert nummer: order.members[].name → order.name (aktiv) →
        // eksisterende registrert eier → reservedBy
        const nameForNumber = (entry) => {
          const num = entry.number;
          if (Array.isArray(order?.members)) {
            const m = order.members.find((m) => Number(m.number) === Number(num));
            if (m?.name) return m.name;
          }
          if (order?.name && order?.reserveNumber !== undefined &&
              Number(order.reserveNumber) === Number(num)) return order.name;
          if (entry.owner) return entry.owner;
          return entry.reservedBy || null;
        };

        const completedNums = [];
        for (const entry of entries) {
          entry.status = "taken";
          entry.owner = nameForNumber(entry) || entry.owner;
          entry.memberEmail = email;
          entry.purchasedAt = new Date().toISOString();
          entry.purchaseReference = ref;
          if (!entry.payments || typeof entry.payments !== "object") entry.payments = {};
          entry.payments[year] = {
            paid: true, amount, agreementId: agreement.id,
            source: "reconcile", at: new Date().toISOString(),
          };
          delete entry.reservedBy;
          delete entry.reservedEmail;
          delete entry.reservedPhone;
          delete entry.reservedAt;
          delete entry.reservedReason;
          delete entry.pendingMembershipReference;
          completedNums.push(entry.number);
        }

        if (!dryRun) {
          // Map agreementId → reference for fremtidige charge-webhooks
          try { await agreementsMap.set(agreement.id, ref); } catch {}
          // Skriv/oppdater medlemsrecord (parity med webhook)
          try {
            const memberData = {
              email,
              name: order?.name || entries[0].reservedBy || null,
              phone: order?.phone || entries[0].reservedPhone || null,
              tier,
              agreementId: agreement.id,
              activatedAt: new Date().toISOString(),
              reference: ref,
              numbersReserved: completedNums,
              numbersReservedAt: new Date().toISOString(),
              source: "reconcile",
            };
            if (completedNums.length === 1) memberData.numberReserved = completedNums[0];
            await membersStore.set(email, JSON.stringify(memberData));
          } catch (e) {
            console.error("reconcile: kunne ikke lagre medlemsrecord:", e);
          }
          mutated = true;
        }

        report.completed.push({
          ref, agreementId: agreement.id, productName: agreement.productName,
          tier, email, amount, numbers: completedNums,
        });
      }

      if (mutated && !dryRun) {
        await saveRegistry(store, registry);
      }

      console.log(`reconcile-memberships: ${report.completed.length} fullført, ${report.skipped.length} hoppet over (dryRun=${dryRun})`);
      return Response.json({ success: true, ...report });
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
// deployed: 1775998392
