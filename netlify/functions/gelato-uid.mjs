// Midlertidig debug-funksjon — slett etter bruk
// GET /api/gelato-uid?secret=<ADMIN_TOKEN>
export default async (req) => {
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret") || "";
  if (secret !== process.env.ADMIN_TOKEN) {
    return new Response("Forbidden", { status: 403 });
  }

  const apiKey = process.env.GELATO_API_KEY;
  if (!apiKey) return Response.json({ error: "GELATO_API_KEY mangler" }, { status: 500 });

  // Hent stores koblet til kontoen
  const storesRes = await fetch("https://ecommerce.gelatoapis.com/v1/stores", {
    headers: { "X-API-KEY": apiKey }
  });
  const stores = await storesRes.json();

  const results = [];
  for (const store of (stores.stores || stores || [])) {
    const storeId = store.id || store.storeId;
    const prodsRes = await fetch(
      `https://ecommerce.gelatoapis.com/v1/stores/${storeId}/products?limit=50`,
      { headers: { "X-API-KEY": apiKey } }
    );
    const prods = await prodsRes.json();
    for (const p of (prods.products || prods || [])) {
      results.push({
        store: store.domain || storeId,
        title: p.title || p.name,
        externalId: p.externalProductId || p.externalId,
        productUid: p.productUid || p.variants?.[0]?.productUid || "?",
      });
    }
  }
  return Response.json(results, { status: 200 });
};
