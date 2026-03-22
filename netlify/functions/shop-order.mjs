import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await req.json();
    const {
      productId,
      sailNumber,
      buyerName,
      buyerEmail,
      buyerPhone,
      shippingAddress,
    } = body;

    // Validate required fields
    if (!productId || !sailNumber || !buyerName || !buyerEmail || !shippingAddress) {
      return Response.json(
        {
          error:
            "Missing required fields: productId, sailNumber, buyerName, buyerEmail, shippingAddress",
        },
        { status: 400 }
      );
    }

    // Validate sail number format
    if (!/^NOR \d{1,4}$/.test(sailNumber)) {
      return Response.json(
        { error: "Invalid sail number format. Use: NOR 123" },
        { status: 400 }
      );
    }

    // Validate shipping address
    const { name, street, city, postalCode, country } = shippingAddress;
    if (!name || !street || !city || !postalCode || !country) {
      return Response.json(
        {
          error:
            "Shipping address must include: name, street, city, postalCode, country",
        },
        { status: 400 }
      );
    }

    const siteUrl = process.env.SITE_URL || "https://nbk.no";
    const reference = `shop-${productId}-${Date.now()}`;

    // Store order in Blobs
    const orders = getStore("orders");
    const order = {
      type: "shop-order",
      productId,
      sailNumber,
      buyerName,
      buyerEmail,
      buyerPhone: buyerPhone || null,
      shippingAddress,
      amount: 50000, // 500 NOK in øre
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    await orders.set(reference, JSON.stringify(order));

    // Create Vipps payment
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
        const paymentRes = await fetch("https://api.vipps.no/epayment/v1/payments", {
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
            amount: { currency: "NOK", value: 50000 },
            paymentMethod: { type: "WALLET" },
            reference,
            paymentDescription: `NBK Kopp: ${sailNumber}`,
            userFlow: "WEB_REDIRECT",
            returnUrl: `${siteUrl}/api/vipps/callback?reference=${reference}`,
          }),
        });
        const payment = await paymentRes.json();

        if (payment.redirectUrl) {
          return Response.json({
            success: true,
            reference,
            redirectUrl: payment.redirectUrl,
            message: `Order created for ${sailNumber} mug. Complete Vipps payment.`,
          });
        }
      }
    }

    // No Vipps — dev mode
    return Response.json({
      success: true,
      reference,
      message: `Order created for ${sailNumber} mug. Vipps not configured.`,
    });
  } catch (err) {
    console.error("shop-order error:", err);
    return Response.json(
      { error: "Internal server error", details: err.message },
      { status: 500 }
    );
  }
};
