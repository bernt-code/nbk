// Scheduled function — refreshes feed cache every 3 hours
// This pre-warms the cache so users don't wait for feed fetches

export const config = {
  schedule: "0 */3 * * *", // Every 3 hours
};

export default async () => {
  const siteUrl = process.env.SITE_URL || process.env.URL || "https://nbk.no";

  try {
    const res = await fetch(`${siteUrl}/api/feeds`);
    const data = await res.json();
    console.log(
      `Feed cache refreshed: ${data.itemCount} items from [${data.sources?.join(", ")}]`
    );
  } catch (err) {
    console.error("Feed refresh failed:", err.message);
  }
};
