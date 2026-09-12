// /api/legends — offentlig liste over Legendekopp-kjøpere til Legendeveggen.
// Henter betalte (ikke-kansellerte) ordrer med Legendekopp-varianten fra Shopify
// (via client_credentials) og leser personaliseringen ut av ordrenotatet.
// Eksponerer KUN: seilnummer/fornavn (etter kjøperens «vis som»-valg), årstall, gave.
// «Legendevegg»-verdier: navn_og_nummer | kun_nummer (default) | anonym | skjul
// ALDRI adresse, e-post eller fullt navn.
// Begge kopp-variantene teller på veggen:
//   51936344375582 = original (Gelato-synket, brukes av Vipps-flyten)
//   59932864971038 = «personalisert» (manuell fulfillment, opt-ut-kassen fra 11.9.2026)
const LEGENDEKOPP_VARIANT_IDS = new Set([51936344375582, 59932864971038]);

async function getShopifyAccessToken(shop) {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  const client_id = process.env.SHOPIFY_API_KEY;
  const client_secret = process.env.SHOPIFY_API_SECRET;
  if (!client_id || !client_secret) return null;
  try {
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id, client_secret, grant_type: "client_credentials" }),
    });
    const data = await res.json();
    return data.access_token || null;
  } catch { return null; }
}

function field(note, label) {
  const m = note.match(new RegExp(label + ":\\s*([^|]+)"));
  return m ? m[1].trim() : "";
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  if (!shop) return Response.json({ legends: [] });
  const token = await getShopifyAccessToken(shop);
  if (!token) {
    console.error("legends: kunne ikke skaffe Shopify-token");
    return Response.json({ legends: [] });
  }
  try {
    const res = await fetch(
      `https://${shop}/admin/api/2024-10/orders.json?status=any&financial_status=paid&limit=250&fields=id,note,line_items,cancelled_at,created_at`,
      { headers: { "X-Shopify-Access-Token": token } }
    );
    const data = await res.json();
    const orders = Array.isArray(data.orders) ? data.orders : [];
    const legends = [];
    for (const o of orders) {
      if (o.cancelled_at) continue;
      const mugItems = (o.line_items || []).filter(li => LEGENDEKOPP_VARIANT_IDS.has(Number(li.variant_id)));
      if (!mugItems.length) continue;
      // Personalisering ligger enten som linjeegenskaper (cart/add-kjeden fra 12.9.2026,
      // og Vipps-flytens egne ordrer) eller i notatet (eldre permalink-ordrer).
      const props = {};
      for (const li of mugItems) for (const pr of (li.properties || [])) if (pr && pr.name) props[pr.name] = String(pr.value || "").trim();
      const note = o.note || "";
      const seil = props.Seilnummer || field(note, "Seilnummer");
      if (!seil) continue;
      const visning = props._Legendevegg || field(note, "Legendevegg");
      // «Legendevegg: skjul» holder ordren utenfor veggen uten å røre selve
      // ordren. Brukes til vareprøver, interne testkjøp og duplikater — og
      // hvis noen senere ber om å bli fjernet fra veggen. Ordren beholdes
      // intakt i Shopify (regnskap, sporing, historikk). (2026-07-16)
      if (visning === "skjul") continue;
      const navn = props._Navn || field(note, "Navn");
      const arstall = parseInt(props.Siden || props["Årstall"] || field(note, "Årstall"), 10);
      const gave = !!props._Gave_fra || /Gave fra:/.test(note);
      const pm = seil.match(/^([A-Za-z-]+)/);
      const prefix = pm ? pm[1].toUpperCase() : "NOR";
      const item = { year: Number.isFinite(arstall) ? arstall : null, prefix, gave, created: o.created_at };
      if (visning === "anonym") {
        item.sail = "Anonym legende"; item.anonymous = true; item.prefix = null;
      } else if (visning === "navn_og_nummer") {
        item.sail = seil; item.name = (navn.trim().split(/\s+/)[0] || "");
      } else {
        item.sail = seil; // kun_nummer / default
      }
      legends.push(item);
    }
    legends.sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
    return Response.json({ legends }, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (err) {
    console.error("legends error:", err);
    return Response.json({ legends: [] });
  }
};
