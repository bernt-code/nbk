import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const event = await req.json();
    console.log("Vipps webhook received:", JSON.stringify(event));

    const reference = event?.reference;
    if (!reference) {
      return Response.json({ error: "Missing reference" }, { status: 400 });
    }

    // Look up the order
    const orders = getStore("orders");
    const orderData = await orders.get(reference, { type: "json" });

    if (!orderData) {
      console.error(`Order not found for reference: ${reference}`);
      return Response.json({ error: "Order not found" }, { status: 404 });
    }

    const paymentStatus = event?.pspReference
      ? "AUTHORIZED"
      : event?.name || "UNKNOWN";

    console.log(
      `Payment ${reference}: status=${paymentStatus}, type=${orderData.type}`
    );

    if (
      paymentStatus === "AUTHORIZED" ||
      paymentStatus === "epayments.payment.captured.v1"
    ) {
      // Payment successful
      if (orderData.type === "sail-number") {
        await handleSailNumberPayment(reference, orderData);
      } else if (orderData.type === "shop-order") {
        await handleShopOrderPayment(reference, orderData);
      }

      // Update order status
      orderData.status = "paid";
      orderData.paidAt = new Date().toISOString();
      await orders.set(reference, JSON.stringify(orderData));
    } else if (
      paymentStatus === "CANCELLED" ||
      paymentStatus === "epayments.payment.cancelled.v1"
    ) {
      // Payment cancelled — release reservation
      if (orderData.type === "sail-number") {
        await releaseSailNumber(orderData.number);
      }

      orderData.status = "cancelled";
      orderData.cancelledAt = new Date().toISOString();
      await orders.set(reference, JSON.stringify(orderData));
    }

    return Response.json({ received: true });
  } catch (err) {
    console.error("Vipps webhook error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
};

async function handleSailNumberPayment(reference, order) {
  const store = getStore("sail-numbers");
  let registry;

  try {
    registry = await store.get("registry", { type: "json" });
  } catch {
    return; // Can't update without registry
  }

  if (!registry) return;

  const entry = registry.numbers.find((n) => n.number === order.number);
  if (entry) {
    entry.status = "taken";
    entry.owner = order.buyerName;
    entry.reservedBy = undefined;
    entry.reservedEmail = undefined;
    entry.reservedPhone = undefined;
    entry.reservedAt = undefined;
    entry.purchasedAt = new Date().toISOString();
    entry.purchaseReference = reference;
    registry.lastUpdated = new Date().toISOString();
    await store.set("registry", JSON.stringify(registry));
    console.log(`Sail number NOR ${order.number} assigned to ${order.buyerName}`);
  }
}

async function releaseSailNumber(number) {
  const store = getStore("sail-numbers");
  let registry;

  try {
    registry = await store.get("registry", { type: "json" });
  } catch {
    return;
  }

  if (!registry) return;

  const entry = registry.numbers.find((n) => n.number === number);
  if (entry && entry.status === "reserved") {
    entry.status = "available";
    entry.owner = null;
    entry.reservedBy = undefined;
    entry.reservedEmail = undefined;
    entry.reservedPhone = undefined;
    entry.reservedAt = undefined;
    registry.lastUpdated = new Date().toISOString();
    await store.set("registry", JSON.stringify(registry));
    console.log(`Sail number NOR ${number} released back to available`);
  }
}

async function handleShopOrderPayment(reference, order) {
  // Create Gelato order after payment confirmed
  if (!process.env.GELATO_API_KEY) {
    console.log("Gelato not configured — skipping POD order creation");
    return;
  }

  try {
    const gelatoOrder = await fetch(
      "https://order.gelatoapis.com/v4/orders",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": process.env.GELATO_API_KEY,
        },
        body: JSON.stringify({
          orderReferenceId: reference,
          customerReferenceId: order.buyerEmail,
          currency: "NOK",
          items: [
            {
              itemReferenceId: `mug-${reference}`,
              productUid: order.productUid,
              quantity: 1,
              fileUrl: order.designUrl,
            },
          ],
          shippingAddress: order.shippingAddress,
        }),
      }
    );

    const result = await gelatoOrder.json();
    console.log("Gelato order created:", JSON.stringify(result));

    // Store Gelato order ID
    const orders = getStore("orders");
    order.gelatoOrderId = result.id;
    order.gelatoStatus = "submitted";
    await orders.set(reference, JSON.stringify(order));
  } catch (err) {
    console.error("Failed to create Gelato order:", err);
  }
}
