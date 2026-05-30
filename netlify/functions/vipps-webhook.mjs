import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const event = await req.json();
    console.log("Vipps webhook received:", JSON.stringify(event));

    // Vipps sender forskjellige event-typer.
    // ePayment: { reference, name: "epayments.payment.*" }
    // Recurring agreement: { agreementId, name: "recurring.agreement-activated.v1", ... }
    // Recurring charge: { agreementId, chargeId, name: "recurring.charge-captured.v1", ... }

    const eventName = event?.name || "UNKNOWN";

    // ── Recurring agreement-events (medlemskap) ──
    if (eventName.startsWith("recurring.agreement")) {
      return await handleAgreementEvent(event);
    }

    // ── Recurring charge-events (årlig fornyelse) ──
    if (eventName.startsWith("recurring.charge")) {
      return await handleChargeEvent(event);
    }

    // ── ePayment-events (seilnummer + shop) ──
    const reference = event?.reference;
    if (!reference) {
      return Response.json({ error: "Missing reference" }, { status: 400 });
    }

    const orders = getStore("orders");
    const orderData = await orders.get(reference, { type: "json" });
    if (!orderData) {
      console.error(`Order not found for reference: ${reference}`);
      return Response.json({ error: "Order not found" }, { status: 404 });
    }

    const paymentStatus = event?.pspReference ? "AUTHORIZED" : eventName;

    if (paymentStatus === "AUTHORIZED" || paymentStatus === "epayments.payment.captured.v1") {
      if (orderData.type === "sail-number") await handleSailNumberPayment(reference, orderData);
      else if (orderData.type === "shop-order") await handleShopOrderPayment(reference, orderData);
      orderData.status = "paid";
      orderData.paidAt = new Date().toISOString();
      await orders.set(reference, JSON.stringify(orderData));
    } else if (paymentStatus === "CANCELLED" || paymentStatus === "epayments.payment.cancelled.v1") {
      if (orderData.type === "sail-number") await releaseSailNumber(orderData.number);
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

// ─────────────────────────────────────────────
// Membership / Recurring handlers
// ─────────────────────────────────────────────
async function handleAgreementEvent(event) {
  const eventName = event.name;
  const agreementId = event.agreementId;
  console.log(`Recurring agreement event: ${eventName} for ${agreementId}`);

  // Finn membership-order basert på agreementId
  const orders = getStore("orders");
  // Vi må iterere — orders har reference som nøkkel, vi lagret agreementId i innholdet
  // Bedre løsning: sett opp en agreements-blob som mapper agreementId → reference
  const agreements = getStore("agreements");
  let reference = await agreements.get(agreementId);

  if (!reference) {
    // Første gang vi ser denne agreementId — finn via order-payload
    const list = await orders.list();
    for (const item of (list.blobs || [])) {
      const data = await orders.get(item.key, { type: "json" });
      if (data?.agreementId === agreementId) {
        reference = item.key;
        await agreements.set(agreementId, reference);
        break;
      }
    }
  }

  if (!reference) {
    console.error(`No membership order found for agreementId: ${agreementId}`);
    return Response.json({ received: true, note: "agreement not matched" });
  }

  const order = await orders.get(reference, { type: "json" });
  if (!order) return Response.json({ received: true });

  if (eventName === "recurring.agreement-activated.v1") {
    // Avtale aktivert — lagre som aktivt medlem
    const members = getStore("members");
    const memberData = {
      email: order.email,
      name: order.name,
      phone: order.phone,
      tier: order.tier,
      agreementId,
      activatedAt: new Date().toISOString(),
      reference,
      numberReserved: null,
    };

    // Hvis det var et pending nummer-valg, fullfør reservasjonen
    if (order.reserveNumber) {
      const sailStore = getStore("sail-numbers");
      const registry = await sailStore.get("registry", { type: "json" });
      if (registry) {
        const entry = registry.numbers.find(n => n.number === Number(order.reserveNumber));
        if (entry && entry.pendingMembershipReference === reference) {
          entry.status = "taken";
          entry.owner = order.name;
          entry.memberEmail = order.email;
          entry.purchasedAt = new Date().toISOString();
          entry.purchaseReference = reference;
          delete entry.reservedBy;
          delete entry.reservedEmail;
          delete entry.reservedPhone;
          delete entry.reservedAt;
          delete entry.reservedReason;
          delete entry.pendingMembershipReference;
          registry.lastUpdated = new Date().toISOString();
          await sailStore.set("registry", JSON.stringify(registry));
          memberData.numberReserved = Number(order.reserveNumber);
          memberData.numberReservedAt = new Date().toISOString();
          console.log(`NOR ${order.reserveNumber} tildelt ${order.name} via membership-flyt`);
        }
      }
    }

    await members.set(order.email.toLowerCase(), JSON.stringify(memberData));
    order.status = "active";
    order.activatedAt = new Date().toISOString();
    await orders.set(reference, JSON.stringify(order));
    console.log(`Membership activated: ${order.name} (${order.tier})`);
  } else if (eventName === "recurring.agreement-rejected.v1" ||
             eventName === "recurring.agreement-stopped.v1") {
    // Avtale avvist/stoppet — frigi pending nummer hvis det finnes
    if (order.reserveNumber) {
      const sailStore = getStore("sail-numbers");
      const registry = await sailStore.get("registry", { type: "json" });
      if (registry) {
        const entry = registry.numbers.find(n => n.number === Number(order.reserveNumber));
        if (entry && entry.pendingMembershipReference === reference) {
          entry.status = "available";
          delete entry.reservedBy;
          delete entry.reservedEmail;
          delete entry.reservedPhone;
          delete entry.reservedAt;
          delete entry.reservedReason;
          delete entry.pendingMembershipReference;
          registry.lastUpdated = new Date().toISOString();
          await sailStore.set("registry", JSON.stringify(registry));
          console.log(`NOR ${order.reserveNumber} frigitt — avtale ${eventName}`);
        }
      }
    }
  

  return Response.json({ received: true });
}

async function handleChargeEvent(event) {
  const eventName = event.name;
  const agreementId = event.agreementId;
  const chargeId = event.chargeId;
  console.log(`Recurring charge event: ${eventName} for agreement ${agreementId}`);

  const members = getStore("members");
  // Vi vet ikke email direkte fra event, må slå opp via agreements-blob
  const agreements = getStore("agreements");
  const reference = await agreements.get(agreementId);
  const orders = getStore("orders");
  const order = reference ? await orders.get(reference, { type: "json" }) : null;

  if (order?.email) {
    const member = await members.get(order.email.toLowerCase(), { type: "json" });
    if (member) {
      member.lastChargeAt = new Date().toISOString();
      member.lastChargeId = chargeId;
      member.lastChargeStatus = eventName;
      await members.set(order.email.toLowerCase(), JSON.stringify(member));
    }
  }

  return Response.json({ received: true });
}

// ─────────────────────────────────────────────
// Sail-number + shop handlers (uendret)
// ─────────────────────────────────────────────
async function handleSailNumberPayment(reference, order) {
  const store = getStore("sail-numbers");
  let registry;
  try { registry = await store.get("registry", { type: "json" }); } catch { return; }
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
  try { registry = await store.get("registry", { type: "json" }); } catch { return; }
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
  if (!process.env.GELATO_API_KEY) return;
  try {
    const gelatoOrder = await fetch("https://order.gelatoapis.com/v4/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": process.env.GELATO_API_KEY },
      body: JSON.stringify({
        orderReferenceId: reference,
        customerReferenceId: order.buyerEmail,
        currency: "NOK",
        items: [{ itemReferenceId: `mug-${reference}`, productUid: order.productUid, quantity: 1, fileUrl: order.designUrl }],
        shippingAddress: order.shippingAddress,
      }),
    });
    const result = await gelatoOrder.json();
    const orders = getStore("orders");
    order.gelatoOrderId = result.id;
    order.gelatoStatus = "submitted";
    await orders.set(reference, JSON.stringify(order));
  } catch (err) {
    console.error("Failed to create Gelato order:", err);
  }
}
