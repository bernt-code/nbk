// Legendekopp + Støttemedlem — Vipps Recurring-avtale.
// Koppen (500 kr) tas som initialCharge; støttemedlemskap (300 kr/år) er det
// årlige beløpet. Når avtalen aktiveres, lager vipps-webhook en Shopify-ordre
// med personaliseringen (nummer + årstall) i notatet, slik at Gelato-appen
// trykker koppen akkurat som ved et vanlig kasse-kjøp.
import { getStore } from "@netlify/blobs";

const KOPP_INITIAL = 50000;  // 500 kr i øre — kopp + støttemedlem år 1
const STOTTE_AARLIG = 30000; // 300 kr i øre — årlig støttemedlemskap

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await req.json();
    const {
      navn, epost, telefon,
      seilnummer, arstall,
      adresse, visningsnavn,
      isGift, giverNavn, mottakerNavn,
    } = body;

    if (!navn || !epost || !seilnummer || !adresse) {
      return Response.json(
        { error: "Mangler påkrevde felt: navn, epost, seilnummer, adresse" },
        { status: 400 }
      );
    }

    const siteUrl = process.env.SITE_URL || "https://nbk.no";
    const reference = `legendekopp-${Date.now()}`;

    // Lagre ordren med all personalisering + leveringsinfo, slik at webhooken
    // kan gjenskape Shopify-ordren når avtalen aktiveres.
    const orders = getStore("orders");
    const orderPayload = {
      type: "legendekopp",
      navn,
      email: epost.toLowerCase(),
      phone: telefon || null,
      seilnummer,
      arstall: arstall || null,
      adresse,
      visningsnavn: visningsnavn || null,
      isGift: !!isGift,
      giverNavn: giverNavn || null,
      mottakerNavn: (isGift && mottakerNavn) ? mottakerNavn : null,
      koppAmount: KOPP_INITIAL,
      stotteAmount: STOTTE_AARLIG,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    await orders.set(reference, JSON.stringify(orderPayload));

    if (!process.env.VIPPS_CLIENT_ID) {
      return Response.json({
        success: true, reference,
        message: "Ordre lagret. Vipps ikke konfigurert.",
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

    // Recurring-avtale: 300 kr/år, med engangstrekk 500 kr (kopp + år 1) ved signering.
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
        pricing: { type: "LEGACY", amount: STOTTE_AARLIG, currency: "NOK" },
        interval: { unit: "YEAR", count: 1 },
        merchantRedirectUrl: `${siteUrl}/api/vipps/callback?reference=${reference}&kind=legendekopp`,
        merchantAgreementUrl: `${siteUrl}/legendekoppen/`,
        productName: "NBK Legendekopp + Støttemedlem",
        productDescription: "Legendekopp (500 kr) + årlig støttemedlemskap 300 kr/år".slice(0, 100),
        initialCharge: {
          amount: KOPP_INITIAL,
          description: "Legendekopp + støttemedlem år 1".slice(0, 45),
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

    orderPayload.agreementId = agreement.agreementId;
    await orders.set(reference, JSON.stringify(orderPayload));
    // Deterministisk webhook-matching: agreementId -> reference
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
    console.error("legendekopp error:", err);
    return Response.json({ error: "Internal server error", details: err.message }, { status: 500 });
  }
};
