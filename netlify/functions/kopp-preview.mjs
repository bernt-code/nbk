import { createHmac } from "crypto";

// /api/kopp-preview?nr=NOR+111&ar=1980
// Genererer HMAC server-side og redirecter til kopp-print.
// Gjør det mulig for siden å vise live personalisert preview uten å
// eksponere ADMIN_TOKEN på klienten.
export default async (req) => {
  const url = new URL(req.url);
  const nr   = url.searchParams.get("nr") || "";
  const ar   = url.searchParams.get("ar") || "";
  const side = url.searchParams.get("side") || "";

  if (!nr || !ar) {
    return new Response("Missing nr or ar", { status: 400 });
  }

  const adminSecret = process.env.ADMIN_TOKEN;
  if (!adminSecret) {
    return new Response("ADMIN_TOKEN not configured", { status: 500 });
  }

  const token = createHmac("sha256", adminSecret)
    .update(`${nr}:${ar}`)
    .digest("hex")
    .slice(0, 16);

  const siteUrl = process.env.SITE_URL || "https://nbk.no";
  const printUrl =
    `${siteUrl}/api/kopp-print` +
    `?nr=${encodeURIComponent(nr)}` +
    `&ar=${encodeURIComponent(ar)}` +
    `&t=${token}&fmt=png` +
    (side ? `&side=${encodeURIComponent(side)}` : "");

  return Response.redirect(printUrl, 302);
};

export const config = { path: "/api/kopp-preview" };
