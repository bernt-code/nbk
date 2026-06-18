import { getStore } from "@netlify/blobs";
import { createShopifyMugOrder } from "./vipps-webhook.mjs";

// Returns from Vipps — håndterer både ePayment og Recurring agreement-confirmation
export default async (req) => {
  const url = new URL(req.url);
  const reference = url.searchParams.get("reference");
  const kind = url.searchParams.get("kind"); // "membership" for Recurring, ellers ePayment
  const siteUrl = process.env.SITE_URL || "https://nbk-no.netlify.app";

  if (!reference) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${siteUrl}/?error=missing-reference` },
    });
  }

  try {
    if (kind === "membership" || kind === "legendekopp") {
      // Recurring agreement-flow (medlemskap + legendekopp) — sjekk status, redirect til velkomst eller feil
      return await handleMembershipCallback(reference, siteUrl);
    }
    return await handleEpaymentCallback(reference, siteUrl);
  } catch (err) {
    console.error("Vipps callback error:", err);
    return new Response(null, {
      status: 302,
      headers: { Location: `${siteUrl}/betaling-feilet/?reference=${reference}&error=internal` },
    });
  }
};

async function handleMembershipCallback(reference, siteUrl) {
  const orders = getStore("orders");
  const order = await orders.get(reference, { type: "json" });
  if (!order?.agreementId) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${siteUrl}/betaling-feilet/?reference=${reference}&kind=membership&error=no-agreement` },
    });
  }

  let agreementStatus = "PENDING";
  if (process.env.VIPPS_CLIENT_ID) {
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
    if (tokenData.access_token) {
      const infoRes = await fetch(`https://api.vipps.no/recurring/v3/agreements/${order.agreementId}`, {
        headers: {
          "Authorization": `Bearer ${tokenData.access_token}`,
          "Ocp-Apim-Subscription-Key": process.env.VIPPS_SUBSCRIPTION_KEY,
          "Merchant-Serial-Number": process.env.VIPPS_MSN,
        },
      });
      const agreement = await infoRes.json();
      agreementStatus = agreement?.status || "UNKNOWN";
    }
  }

  if (agreementStatus === "ACTIVE") {
    // SIKKERHETSNETT: lag Shopify-ordren for legendekoppen hvis webhooken
    // ikke (ennå) gjorde det — idempotent (kun hvis ingen shopifyOrderId).
    if (order.type === "legendekopp" && !order.shopifyOrderId) {
      try {
        await createShopifyMugOrder(order, reference);
        const fresh = await orders.get(reference, { type: "json" });
        if (fresh?.shopifyOrderId) {
          fresh.status = "active";
          fresh.activatedAt = fresh.activatedAt || new Date().toISOString();
          fresh.fulfillmentSource = fresh.fulfillmentSource || "callback";
          await orders.set(reference, JSON.stringify(fresh));
        }
      } catch (e) {
        console.error("Callback legendekopp-fulfillment feilet:", e);
      }
    }
    return new Response(null, {
      status: 302,
      headers: { Location: `${siteUrl}/betaling-ok/?reference=${reference}&kind=membership` },
    });
  } else {
    return new Response(null, {
      status: 302,
      headers: { Location: `${siteUrl}/betaling-feilet/?reference=${reference}&kind=membership&status=${agreementStatus}` },
    });
  }
}

async function handleEpaymentCallback(reference, siteUrl) {
  let paymentStatus = "unknown";
  if (process.env.VIPPS_CLIENT_ID) {
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
    if (tokenData.access_token) {
      const headers = {
        "Authorization": `Bearer ${tokenData.access_token}`,
        "Ocp-Apim-Subscription-Key": process.env.VIPPS_SUBSCRIPTION_KEY,
        "Merchant-Serial-Number": process.env.VIPPS_MSN,
        "Vipps-System-Name": "nbk-website",
        "Vipps-System-Version": "1.0.0",
      };
      const infoRes = await fetch(`https://api.vipps.no/epayment/v1/payments/${reference}`, { headers });
      const payment = await infoRes.json();
      paymentStatus = payment?.state || "unknown";

      if (paymentStatus === "AUTHORIZED") {
        const orders = getStore("orders");
        const order = await orders.get(reference, { type: "json" });
        if (order?.type === "sail-number") {
          await fetch(`https://api.vipps.no/epayment/v1/payments/${reference}/capture`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ modificationAmount: { currency: "NOK", value: order.amount } }),
          });
          paymentStatus = "CAPTURED";
        }
      }
    }
  }

  if (paymentStatus === "AUTHORIZED" || paymentStatus === "CAPTURED") {
    return new Response(null, {
      status: 302,
      headers: { Location: `${siteUrl}/betaling-ok/?reference=${reference}` },
    });
  } else {
    return new Response(null, {
      status: 302,
      headers: { Location: `${siteUrl}/betaling-feilet/?reference=${reference}&status=${paymentStatus}` },
    });
  }
}
