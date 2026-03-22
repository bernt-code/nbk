import { getStore } from "@netlify/blobs";

// This is the return URL after Vipps payment — user lands here
export default async (req) => {
  const url = new URL(req.url);
  const reference = url.searchParams.get("reference");
  const siteUrl = process.env.SITE_URL || "https://nbk-no.netlify.app";

  if (!reference) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${siteUrl}/?error=missing-reference` },
    });
  }

  try {
    let paymentStatus = "unknown";

    if (process.env.VIPPS_CLIENT_ID) {
      // Get access token
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

        // Check payment status
        const infoRes = await fetch(
          `https://api.vipps.no/epayment/v1/payments/${reference}`,
          { headers }
        );
        const payment = await infoRes.json();
        paymentStatus = payment?.state || "unknown";

        // If authorized, capture immediately for sail numbers
        if (paymentStatus === "AUTHORIZED") {
          const orders = getStore("orders");
          const order = await orders.get(reference, { type: "json" });

          if (order?.type === "sail-number") {
            await fetch(
              `https://api.vipps.no/epayment/v1/payments/${reference}/capture`,
              {
                method: "POST",
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify({
                  modificationAmount: {
                    currency: "NOK",
                    value: order.amount,
                  },
                }),
              }
            );
            paymentStatus = "CAPTURED";
          }
        }
      }
    }

    // Redirect to success or failure page
    if (paymentStatus === "AUTHORIZED" || paymentStatus === "CAPTURED") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${siteUrl}/betaling-ok/?reference=${reference}`,
        },
      });
    } else {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${siteUrl}/betaling-feilet/?reference=${reference}&status=${paymentStatus}`,
        },
      });
    }
  } catch (err) {
    console.error("Vipps callback error:", err);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${siteUrl}/betaling-feilet/?reference=${reference}&error=internal`,
      },
    });
  }
};
