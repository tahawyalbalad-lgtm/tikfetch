// api/download.js
// Vercel Serverless Function.
// Fetches the actual media file server-side (video/audio/cover) and streams it
// back to the browser with a correct Content-Type and Content-Disposition
// header, so the browser saves a real .mp4 / .mp3 / .jpg file instead of
// opening a tab, following a redirect chain that ends in HTML, or saving a
// stray .txt file.

function pickExtensionAndType(type) {
  switch (type) {
    case "hd":
    case "sd":
      return { ext: "mp4", contentType: "video/mp4" };
    case "audio":
      return { ext: "mp3", contentType: "audio/mpeg" };
    case "cover":
      return { ext: "jpg", contentType: "image/jpeg" };
    default:
      return { ext: "bin", contentType: "application/octet-stream" };
  }
}

// Simple in-memory rate limit (best-effort; resets on cold start)
const hits = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_HITS = 30;

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

  const { url, type } = req.query;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing 'url' query parameter." });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL." });
  }

  // Only allow http(s) targets — avoid file:// or other schemes being proxied.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return res.status(400).json({ error: "Invalid URL scheme." });
  }

  const { ext, contentType } = pickExtensionAndType(type);

  try {
    const upstream = await fetch(parsed.toString(), {
      // TikTok/TikWM CDN URLs sometimes check the Referer/User-Agent before serving the file.
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Referer: "https://www.tiktok.com/",
      },
    });

    if (!upstream.ok || !upstream.body) {
      return res.status(upstream.status || 502).json({ error: `Upstream fetch failed (${upstream.status})` });
    }

    const upstreamType = upstream.headers.get("content-type") || "";
    // Ignore text/html or text/plain upstream types — those indicate an error
    // page or a redirect stub, not real media, and would be the source of
    // the ".txt" downloads. Force our own known-good content type instead.
    const finalType = upstreamType.startsWith("video/") || upstreamType.startsWith("audio/") || upstreamType.startsWith("image/")
      ? upstreamType
      : contentType;

    res.setHeader("Content-Type", finalType);
    res.setHeader("Content-Disposition", `attachment; filename="tikfetch-${type || "file"}.${ext}"`);
    res.setHeader("Cache-Control", "no-store");

    const arrayBuffer = await upstream.arrayBuffer();
    res.status(200).send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error("Download proxy error:", err);
    res.status(500).json({ error: "Server error while downloading the file." });
  }
}
