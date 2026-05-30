// Membership signup — Vipps Recurring agreement creation
// Two tiers (vedtatt 2026-05-14):
//   - Aktiv: 350 kr/år, inkluderer ett NOR- eller W-BIB-nummer
//   - Støttemedlem: 200 kr/år
import { getStore } from "@netlify/blobs";

const TIERS = {
  aktiv: {
    name: "Aktiv medlemskap",
    productName: "NBK Aktiv medlemskap",
    productDescription: "Årsmedlemskap i NBK. Gir rett til ett registrert nummer (NOR-seilnummer eller W-BIB).",
    amount: 35000, // 350 NOK i øre
  },
  stotte: {
    name: "Støttemedlem",
    productName: "NBK Støttemedlem",
    productDescription: "Årlig støttemedlemskap i NBK. Støtter klubbens drift og virksomhet.",
    amount: 20000, // 200 NOK i øre
  },
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await req.json();
    const { tier, name, email, phone } = body;

    if (!tier || !TIERS[tier]) {
      return Response.json({ error: "Ugyldig tier (aktiv eller stotte)" }, { status: 400 });
    }
    if (!name || !email) {
      return Response.json({ error: "Navn og e-post må fylles ut" }, { status: 400 });
    }

    const config = TIERS[tier];
    const siteUrl = process.env.SITE_URL || "https://nbk-no.netlify.app";
    const reference = `member-${tier}-${Date.now()}`;

    // Lagre i orders-blob for webhook-lookup
    const orders = getStore("orders");
    await orders.set(reference, JSON.stringify({
      type: "membership",
      tier,
      name,
      email,
      phone: phone || null,
      amount: config.amount,
      createdAt: new Date().toISOString(),
    }));

    // Hvis Vipps ikke er konfigurert, returner med beskjed (dev mode)
    if (!process.env.VIPPS_CLIENT_ID) {
      return Response.json({
        success: true,
        reference,
        message: `${config.name} reservert for ${name}. Vipps ikke konfigurert — betaling hoppet over.`,
      });
    }

    // Hent Vipps access token
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
      return Response.json({
        success: false,
        reference,
        error: "Vipps autentisering feilet",
      }, { status: 502 });
    }

    // Opprett Recurring Agreement
    // Vipps API: https://developer.vippsmobilepay.com/docs/APIs/recurring-api/
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
        pricing: {
          type: "LEGACY",
          amount: config.amount,
          currency: "NOK",
        },
        interval: {
          unit: "YEAR",
          count: 1,
        },
        merchantRedirectUrl: `${siteUrl}/api/vipps/callback?reference=${reference}&kind=membership`,
        merchantAgreementUrl: `${siteUrl}/medlemskap/`,
        productName: config.productName,
        productDescription: config.productDescription,
        scope: "name email phoneNumber",
        userinfoUrlPrefix: `${siteUrl}/api/membership/userinfo`,
        // Send første trekk umiddelbart ved aktivering
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
        success: false,
        reference,
        error: "Kunne ikke opprette Vipps-avtale",
        details: agreement,
      }, { status: 502 });
    }

    // Lagre agreement-info i blob
    const orderData = JSON.parse(await orders.get(reference));
    orderData.agreementId = agreement.agreementId;
    await orders.set(reference, JSON.stringify(orderData));

    return Response.json({
      success: true,
      reference,
      agreementId: agreement.agreementId,
      redirectUrl: agreement.vippsConfirmationUrl,
      message: `${config.name} — fullfør avtalen i Vipps-appen for å aktivere`,
    });

  } catch (err) {
    console.error("membership error:", err);
    return Response.json({
      error: "Internal server error",
      details: err.message,
    }, { status: 500 });
  }
};
