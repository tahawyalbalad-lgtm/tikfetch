// api/fetch.js
// Vercel Serverless Function.
// Calls the TikWM API from the SERVER instead of the browser. Some free
// APIs like TikWM block or rate-limit requests that come directly from
// browsers (CORS, missing headers, IP-based throttling). Calling it from
// our own server avoids that and gives us one place to fix things if
// TikWM's response shape ever changes.

function isValidTikTokUrl(url) {
  try {
    const u = new URL(url);
    return /tiktok\.com/i.test(u.hostname);
  } catch {
    return false;
  }
}

const hits = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_HITS = 20;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, start: now };
  if (now - entry.start > WINDOW_MS) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count += 1;
  hits.set(ip, entry);
  if (entry.count > MAX_HITS) {
    return res.status(429).json({ error: "Too many requests. Please try again shortly." });
  }

  const tiktokUrl = req.query.url;
  if (!tiktokUrl || typeof tiktokUrl !== "string") {
    return res.status(400).json({ error: "Missing 'url' query parameter." });
  }
  if (!isValidTikTokUrl(tiktokUrl)) {
    return res.status(400).json({ error: "Invalid TikTok URL." });
  }

  try {
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(tiktokUrl)}&hd=1`;
    const upstream = await fetch(apiUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Upstream API error ${upstream.status}` });
    }

    const data = await upstream.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error("TikTok fetch proxy error:", err);
    return res.status(500).json({ error: "Server error while contacting TikTok API." });
  }
}
