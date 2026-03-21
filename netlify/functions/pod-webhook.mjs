import { getStore } from "@netlify/blobs";

// Gelato order status webhook
export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const event = await req.json();
    console.log("Gelato webhook received:", JSON.stringify(event));

    const orderReferenceId = event?.orderReferenceId;
    if (!orderReferenceId) {
      return Response.json(
        { error: "Missing orderReferenceId" },
        { status: 400 }
      );
    }

    // Update order status in Blobs
    const orders = getStore("orders");
    const order = await orders.get(orderReferenceId, { type: "json" });

    if (!order) {
      console.error(`Order not found: ${orderReferenceId}`);
      return Response.json({ error: "Order not found" }, { status: 404 });
    }

    // Map Gelato status
    const gelatoStatus = event?.status || event?.event || "unknown";
    order.gelatoStatus = gelatoStatus;
    order.gelatoUpdatedAt = new Date().toISOString();

    if (event?.shipment) {
      order.trackingCode = event.shipment.trackingCode;
      order.trackingUrl = event.shipment.trackingUrl;
      order.carrier = event.shipment.carrier;
    }

    await orders.set(orderReferenceId, JSON.stringify(order));
    console.log(`Order ${orderReferenceId} updated: ${gelatoStatus}`);

    return Response.json({ received: true });
  } catch (err) {
    console.error("POD webhook error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
};
