import { getStore } from "@netlify/blobs";

// This is the return URL after Vipps payment — user lands here
export default async (req) => {
  const url = new URL(req.url);
  const reference = url.searchParams.get("reference");
  const siteUrl = process.env.SITE_URL || "https://nbk.no";

  if (!reference) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${siteUrl}/?error=missing-reference` },
    });
  }

  try {
    // Check payment status with Vipps (don't rely solely on redirect)
    let paymentStatus = "unknown";

    if (process.env.VIPPS_CLIENT_ID) {
      const { Client } = await import("@vippsmobilepay/sdk");
      const client = Client({
        merchantSerialNumber: process.env.VIPPS_MSN,
        subscriptionKey: process.env.VIPPS_SUBSCRIPTION_KEY,
        useTestMode: process.env.VIPPS_TEST_MODE === "true",
        retryRequests: false,
      });

      const accessToken = await client.auth.getToken({
        clientId: process.env.VIPPS_CLIENT_ID,
        clientSecret: process.env.VIPPS_CLIENT_SECRET,
      });

      const payment = await client.payment.info(
        accessToken.token,
        reference
      );
      paymentStatus = payment?.state || "unknown";

      // If authorized, capture immediately for sail numbers
      if (paymentStatus === "AUTHORIZED") {
        const orders = getStore("orders");
        const order = await orders.get(reference, { type: "json" });

        if (order?.type === "sail-number") {
          await client.payment.capture(accessToken.token, reference, {
            modificationAmount: {
              currency: "NOK",
              value: order.amount,
            },
          });
          paymentStatus = "CAPTURED";
        }
      }
    }

    // Redirect to success or failure page
    if (
      paymentStatus === "AUTHORIZED" ||
      paymentStatus === "CAPTURED"
    ) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${siteUrl}/betaling-ok?reference=${reference}`,
        },
      });
    } else {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${siteUrl}/betaling-feilet?reference=${reference}&status=${paymentStatus}`,
        },
      });
    }
  } catch (err) {
    console.error("Vipps callback error:", err);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${siteUrl}/betaling-feilet?reference=${reference}&error=internal`,
      },
    });
  }
};
