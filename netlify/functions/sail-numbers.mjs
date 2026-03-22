import { getStore } from "@netlify/blobs";
import { readFile } from "fs/promises";
import { resolve } from "path";

// Load sail number data — starts from JSON file, runtime state in Blobs
async function loadRegistry() {
  const store = getStore("sail-numbers");

  // Try Blobs first (has latest state including reservations/purchases)
  try {
    const blob = await store.get("registry", { type: "json" });
    if (blob) return blob;
  } catch {
    // Blobs not available (local dev) or empty — fall through
  }

  // Fall back to JSON file
  const filePath = resolve("data/sail-numbers.json");
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

async function saveRegistry(registry) {
  const store = getStore("sail-numbers");
  registry.lastUpdated = new Date().toISOString();
  await store.set("registry", JSON.stringify(registry));
}

export default async (req) => {
  const url = new URL(req.url);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  try {
    // GET /api/sail-numbers — list numbers
    if (req.method === "GET") {
      const registry = await loadRegistry();
      const status = url.searchParams.get("status"); // "available", "taken", or null for all

      let numbers = registry.numbers;
      if (status) {
        numbers = numbers.filter((n) => n.status === status);
      }

      return Response.json({
        lastUpdated: registry.lastUpdated,
        count: numbers.length,
        numbers,
      });
    }

    // POST /api/sail-numbers — reserve a number (initiates Vipps payment)
    if (req.method === "POST") {
      const body = await req.json();
      const { number, buyerName, buyerEmail, buyerPhone } = body;

      if (!number || !buyerName || !buyerEmail) {
        return Response.json(
          { error: "Missing required fields: number, buyerName, buyerEmail" },
          { status: 400 }
        );
      }

      const registry = await loadRegistry();
      const entry = registry.numbers.find((n) => n.number === number);

      if (!entry) {
        return Response.json(
          { error: `Sail number NOR ${number} does not exist in registry` },
          { status: 404 }
        );
      }

      if (entry.status !== "available") {
        return Response.json(
          { error: `NOR ${number} is not available (status: ${entry.status})` },
          { status: 409 }
        );
      }

      // Reserve the number
      entry.status = "reserved";
      entry.reservedBy = buyerName;
      entry.reservedEmail = buyerEmail;
      entry.reservedPhone = buyerPhone || null;
      entry.reservedAt = new Date().toISOString();
      await saveRegistry(registry);

      // Create Vipps payment
      const siteUrl = process.env.SITE_URL || "https://nbk.no";
      const reference = `sail-${number}-${Date.now()}`;

      // Store order details in Blobs for webhook lookup
      const orders = getStore("orders");
      await orders.set(
        reference,
        JSON.stringify({
          type: "sail-number",
          number,
          buyerName,
          buyerEmail,
          buyerPhone: buyerPhone || null,
          amount: 10000, // 100 NOK in øre
          createdAt: new Date().toISOString(),
        })
      );

      // If Vipps is configured, create payment
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

        if (!tokenData.access_token) {
          console.error("Vipps auth failed:", tokenData);
          return Response.json({
            success: true,
            reference,
            message: `NOR ${number} reserved. Vipps auth failed.`,
          });
        }

        // Create ePayment
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
            amount: { currency: "NOK", value: 10000 },
            paymentMethod: { type: "WALLET" },
            reference,
            paymentDescription: `Seilnummer NOR ${number}`,
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
            message: `NOR ${number} reserved. Complete payment to confirm.`,
          });
        }

        console.error("Vipps payment creation failed:", payment);
        return Response.json({
          success: true,
          reference,
          message: `NOR ${number} reserved. Payment setup failed.`,
        });
      }

      // No Vipps configured — just return success (dev/test mode)
      return Response.json({
        success: true,
        reference,
        message: `NOR ${number} reserved for ${buyerName}. Vipps not configured — payment skipped.`,
      });
    }

    return Response.json({ error: "Method not allowed" }, { status: 405 });
  } catch (err) {
    console.error("sail-numbers error:", err);
    return Response.json(
      { error: "Internal server error", details: err.message },
      { status: 500 }
    );
  }
};
