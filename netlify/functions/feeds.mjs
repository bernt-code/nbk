import { getStore } from "@netlify/blobs";
import Parser from "rss-parser";

const CACHE_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  try {
    // Check cache first
    const store = getStore("feeds");
    try {
      const cached = await store.get("combined-feed", { type: "json" });
      if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < CACHE_TTL_MS) {
        return Response.json(cached);
      }
    } catch {
      // Cache miss or Blobs unavailable — fetch fresh
    }

    // Fetch all feeds in parallel
    const results = await Promise.allSettled([
      fetchRSS(),
      fetchFacebook(),
      fetchInstagram(),
    ]);

    // Collect items from successful fetches
    const items = [];
    const sources = [];

    if (results[0].status === "fulfilled") {
      items.push(...results[0].value);
      sources.push("rss");
    }
    if (results[1].status === "fulfilled") {
      items.push(...results[1].value);
      sources.push("facebook");
    }
    if (results[2].status === "fulfilled") {
      items.push(...results[2].value);
      sources.push("instagram");
    }

    // Sort by date, newest first
    items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const feed = {
      items,
      sources,
      fetchedAt: new Date().toISOString(),
      itemCount: items.length,
    };

    // Cache the result
    try {
      await store.set("combined-feed", JSON.stringify(feed));
    } catch {
      // Caching failed — still return the data
    }

    return Response.json(feed);
  } catch (err) {
    console.error("feeds error:", err);
    return Response.json(
      { error: "Failed to fetch feeds", details: err.message },
      { status: 500 }
    );
  }
};

async function fetchRSS() {
  const rssUrl = process.env.RSS_FEED_URL;
  if (!rssUrl) return [];

  const parser = new Parser();
  const feed = await parser.parseURL(rssUrl);

  return feed.items.map((item) => ({
    title: item.title,
    content: item.contentSnippet || item.content || "",
    url: item.link,
    image: item.enclosure?.url || null,
    timestamp: item.isoDate || item.pubDate,
    source: "rss",
    author: item.creator || item.author || null,
  }));
}

async function fetchFacebook() {
  const token = process.env.FACEBOOK_PAGE_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  if (!token || !pageId) return [];

  const url = `https://graph.facebook.com/v22.0/${pageId}/feed?fields=message,created_time,permalink_url,full_picture&limit=10&access_token=${token}`;
  const res = await fetch(url);

  if (!res.ok) {
    console.error("Facebook API error:", res.status, await res.text());
    return [];
  }

  const data = await res.json();
  return (data.data || [])
    .filter((post) => post.message) // Skip posts without text
    .map((post) => ({
      title: null,
      content: post.message,
      url: post.permalink_url,
      image: post.full_picture || null,
      timestamp: post.created_time,
      source: "facebook",
      author: null,
    }));
}

async function fetchInstagram() {
  const token = process.env.INSTAGRAM_TOKEN;
  if (!token) return [];

  const url = `https://graph.instagram.com/me/media?fields=id,caption,media_url,permalink,timestamp,media_type&limit=10&access_token=${token}`;
  const res = await fetch(url);

  if (!res.ok) {
    console.error("Instagram API error:", res.status, await res.text());
    return [];
  }

  const data = await res.json();
  return (data.data || []).map((post) => ({
    title: null,
    content: post.caption || "",
    url: post.permalink,
    image: post.media_type !== "VIDEO" ? post.media_url : null,
    timestamp: post.timestamp,
    source: "instagram",
    mediaType: post.media_type,
    author: null,
  }));
}
