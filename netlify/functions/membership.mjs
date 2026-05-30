// Membership signup — Vipps Recurring agreement creation.
// Støtter optional reserveNumber for å koble seilnummer-reservering til medlemskap.
import { getStore } from "@netlify/blobs";

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
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await req.json();
    const { tier, name, email, phone, reserveNumber } = body;

    if (!tier || !TIERS[tier]) {
      return Response.json({ error: "Ugyldig tier (aktiv eller stotte)" }, { status: 400 });
    }
    if (!name || !email) {
      return Response.json({ error: "Navn og e-post må fylles ut" }, { status: 400 });
    }

    const config = TIERS[tier];
    const siteUrl = process.env.SITE_URL || "https://nbk-no.netlify.app";
    const reference = `member-${tier}-${Date.now()}`;

    // Hvis bruker valgte nummer på forhånd, reserver det som "pending-membership"
    if (reserveNumber && tier === "aktiv") {
      const sailStore = getStore("sail-numbers");
      const registry = await sailStore.get("registry", { type: "json" });
      if (registry) {
        const entry = registry.numbers.find(n => n.number === Number(reserveNumber));
        if (entry && entry.status === "available") {
          entry.status = "reserved";
          entry.reservedBy = name;
          entry.reservedEmail = email;
          entry.reservedPhone = phone || null;
          entry.reservedAt = new Date().toISOString();
          entry.reservedReason = "pending-membership";
          entry.pendingMembershipReference = reference;
          registry.lastUpdated = new Date().toISOString();
          await sailStore.set("registry", JSON.stringify(registry));
        }
      }
    }

    const orders = getStore("orders");
    await orders.set(reference, JSON.stringify({
      type: "membership",
      tier,
      name,
      email: email.toLowerCase(),
      phone: phone || null,
      amount: config.amount,
      reserveNumber: reserveNumber ? Number(reserveNumber) : null,
      createdAt: new Date().toISOString(),
    }));

    if (!process.env.VIPPS_CLIENT_ID) {
      return Response.json({
        success: true, reference,
        message: `${config.name} reservert for ${name}. Vipps ikke konfigurert.`,
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
      console.error("Vipps auth failed:", tokenData);
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
        pricing: { type: "LEGACY", amount: config.amount, currency: "NOK" },
        interval: { unit: "YEAR", count: 1 },
        merchantRedirectUrl: `${siteUrl}/api/vipps/callback?reference=${reference}&kind=membership`,
        merchantAgreementUrl: `${siteUrl}/medlemskap/`,
        productName: config.productName,
        productDescription: config.productDescription,
        initialCharge: {
          amount: config.amount,
          description: `${config.productName} ${new Date().getFullYear()}`,
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
