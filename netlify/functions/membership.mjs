// Membership signup — Vipps Recurring agreement creation.
// Støtter optional reserveNumber (aktiv) eller members[] (familie) for å koble
// seilnummer-reservering til medlemskap.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

// Verifiser en signert claim-token (utstedt av NBK-admin) som lar en eksisterende
// nummer-eier re-tegne medlemskap paa sitt eget opptatte nummer. Returnerer Set av
// numre token-en autoriserer, eller tomt Set. HMAC-noekkel = ADMIN_TOKEN.
function verifyClaim(token) {
  try {
    if (!token || !process.env.ADMIN_TOKEN) return new Set();
    const dot = token.lastIndexOf(".");
    if (dot < 1) return new Set();
    const p = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac("sha256", process.env.ADMIN_TOKEN).update(p).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return new Set();
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return new Set();
    return new Set((payload.n || []).map(Number));
  } catch {
    return new Set();
  }
}

// Pris i øre. Familie regnes ut basert på antall familiemedlemmer.
const FAMILIE_BASE = 35000;      // = aktiv-prisen
const FAMILIE_PER_EKSTRA = 16000; // 160 kr per ekstra nummer
const FAMILIE_MIN = 2;
const FAMILIE_MAX = 5;

const TIERS = {
  aktiv: {
    name: "Aktiv medlemskap",
    productName: "NBK Aktiv medlemskap",
    productDescription: "Årsmedlemskap i NBK. Gir rett til ett registrert nummer (NOR-seilnummer eller W-BIB).",
    amount: 35000,
  },
  stotte: {
    name: "Støttemedlem",
    productName: "NBK Støttemedlem",
    productDescription: "Årlig støttemedlemskap i NBK. Støtter klubbens drift og virksomhet.",
    amount: 20000,
  },
  familie: {
    name: "Familiemedlemskap",
    productName: "NBK Familiemedlemskap",
    productDescription: "Årlig familiemedlemskap i NBK. Dekker 2-5 personer med hvert sitt nummer.",
    // amount beregnes per request basert på members.length
  },
};

function calculateFamiliePrice(memberCount) {
  return FAMILIE_BASE + FAMILIE_PER_EKSTRA * (memberCount - 1);
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await req.json();
    const { tier, name, email, phone, reserveNumber, members } = body;
    const claimedNums = verifyClaim(body.claim);

    if (!tier || !TIERS[tier]) {
      return Response.json({ error: "Ugyldig tier (aktiv, stotte eller familie)" }, { status: 400 });
    }
    if (!name || !email) {
      return Response.json({ error: "Navn og e-post må fylles ut" }, { status: 400 });
    }

    let amount;
    let productName;
    let productDescription;
    let normalizedMembers = null; // [{number, name}]

    if (tier === "familie") {
      // Validér members-array
      if (!Array.isArray(members) || members.length < FAMILIE_MIN || members.length > FAMILIE_MAX) {
        return Response.json({
          error: `Familiemedlemskap krever ${FAMILIE_MIN}-${FAMILIE_MAX} familiemedlemmer`,
        }, { status: 400 });
      }
      normalizedMembers = members.map(m => ({
        number: Number(m.number),
        name: (m.name || "").trim(),
      }));
      // Hver må ha både nummer og navn
      for (const m of normalizedMembers) {
        if (!Number.isInteger(m.number) || m.number < 0 || m.number > 99999) {
          return Response.json({ error: `Ugyldig nummer ${m.number}` }, { status: 400 });
        }
        if (!m.name) {
          return Response.json({ error: "Hvert familiemedlem må ha et navn" }, { status: 400 });
        }
      }
      // Sjekk for duplikater
      const numbers = normalizedMembers.map(m => m.number);
      if (new Set(numbers).size !== numbers.length) {
        return Response.json({ error: "Familien kan ikke ha duplikate numre" }, { status: 400 });
      }
      amount = calculateFamiliePrice(normalizedMembers.length);
      productName = TIERS.familie.productName;
      productDescription = `${TIERS.familie.productName} for ${normalizedMembers.length} personer (${normalizedMembers.length} numre)`;
    } else {
      amount = TIERS[tier].amount;
      productName = TIERS[tier].productName;
      productDescription = TIERS[tier].productDescription;
    }

    const siteUrl = process.env.SITE_URL || "https://nbk-no.netlify.app";
    const reference = `member-${tier}-${Date.now()}`;

    // Reserver nummer(e) som pending-membership
    if ((reserveNumber && tier === "aktiv") || (tier === "familie" && normalizedMembers)) {
      const sailStore = getStore("sail-numbers");
      const registry = await sailStore.get("registry", { type: "json" });
      if (registry) {
        const numbersToReserve = tier === "familie"
          ? normalizedMembers
          : [{ number: Number(reserveNumber), name }];

        // FØRST: sjekk at alle er ledige (atomic validering)
        const conflicts = [];
        for (const m of numbersToReserve) {
          const entry = registry.numbers.find(n => n.number === m.number);
          if (!entry) {
            conflicts.push(`NOR ${m.number} finnes ikke i registeret`);
          } else if (entry.status !== "available" && !claimedNums.has(Number(m.number))) {
            conflicts.push(`NOR ${m.number} er ikke ledig (status: ${entry.status})`);
          }
        }
        if (conflicts.length > 0) {
          return Response.json({
            error: "Ett eller flere numre er ikke tilgjengelig",
            conflicts,
          }, { status: 409 });
        }

        // DERETTER: reserver alle
        for (const m of numbersToReserve) {
          const entry = registry.numbers.find(n => n.number === m.number);
          if (claimedNums.has(Number(m.number))) {
            // Re-claim av eget opptatt nummer: rydd gammel eier foer ny reservasjon
            entry.owner = null;
            delete entry.ownerEmail;
            delete entry.purchaseReference;
          }
          entry.status = "reserved";
          entry.reservedBy = m.name; // person-navnet (familie), eller hovedperson (aktiv)
          entry.reservedEmail = email;
          entry.reservedPhone = phone || null;
          entry.reservedAt = new Date().toISOString();
          entry.reservedReason = "pending-membership";
          entry.pendingMembershipReference = reference;
        }
        registry.lastUpdated = new Date().toISOString();
        await sailStore.set("registry", JSON.stringify(registry));
      }
    }

    const orders = getStore("orders");
    const orderPayload = {
      type: "membership",
      tier,
      name,
      email: email.toLowerCase(),
      phone: phone || null,
      amount,
      createdAt: new Date().toISOString(),
    };
    if (tier === "aktiv") {
      orderPayload.reserveNumber = reserveNumber ? Number(reserveNumber) : null;
    } else if (tier === "familie") {
      orderPayload.members = normalizedMembers;
    }
    await orders.set(reference, JSON.stringify(orderPayload));

    if (!process.env.VIPPS_CLIENT_ID) {
      return Response.json({
        success: true, reference,
        message: `${productName} reservert for ${name}. Vipps ikke konfigurert.`,
      });
    }

    const tokenRes = await fetch("https://api.vipps.no/accesstoken/get", {
      method: "POST",
      headers: {
        "client_id": process.env.VIPPS_CLIENT_ID,
        "client_secret": process.env.VIPPS_CLIENT_SECRET,
        "Ocp-Apim-Subscription-Key": process.env.VIPPS_SUBSCRIPTION_KEY,
        "Merchant-Serial-Number": process.env.VIPPS_MSN,
      },
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error("Vipps auth failed (token request did not return access_token)");
      return Response.json({ success: false, error: "Vipps autentisering feilet" }, { status: 502 });
    }

    const agreementRes = await fetch("https://api.vipps.no/recurring/v3/agreements", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${tokenData.access_token}`,
        "Ocp-Apim-Subscription-Key": process.env.VIPPS_SUBSCRIPTION_KEY,
        "Merchant-Serial-Number": process.env.VIPPS_MSN,
        "Content-Type": "application/json",
        "Vipps-System-Name": "nbk-website",
        "Vipps-System-Version": "1.0.0",
        "Idempotency-Key": reference,
      },
      body: JSON.stringify({
        pricing: { type: "LEGACY", amount, currency: "NOK" },
        interval: { unit: "YEAR", count: 1 },
        merchantRedirectUrl: `${siteUrl}/api/vipps/callback?reference=${reference}&kind=membership`,
        merchantAgreementUrl: `${siteUrl}/medlemskap/`,
        productName,
        productDescription: productDescription.slice(0, 100), // Vipps-grense
        initialCharge: {
          amount,
          description: `${productName} ${new Date().getFullYear()}`.slice(0, 45),
          transactionType: "DIRECT_CAPTURE",
        },
      }),
    });

    const agreement = await agreementRes.json();
    if (!agreement.vippsConfirmationUrl) {
      console.error("Vipps Recurring agreement create failed:", agreement);
      return Response.json({
        success: false, reference, error: "Kunne ikke opprette Vipps-avtale", details: agreement,
      }, { status: 502 });
    }

    const orderData = JSON.parse(await orders.get(reference));
    orderData.agreementId = agreement.agreementId;
    await orders.set(reference, JSON.stringify(orderData));
    // Deterministisk webhook-matching: map agreementId -> reference med en gang,
    // slik at vipps-webhook slipper å gjette via pending-scan ("cannot disambiguate").
    try {
      await getStore("agreements").set(agreement.agreementId, reference);
    } catch (e) {
      console.error("Kunne ikke lagre agreements-mapping:", e);
    }

    return Response.json({
      success: true, reference,
      agreementId: agreement.agreementId,
      redirectUrl: agreement.vippsConfirmationUrl,
    });
  } catch (err) {
    console.error("membership error:", err);
    return Response.json({ error: "Internal server error", details: err.message }, { status: 500 });
  }
};
