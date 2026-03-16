/**
 * Normalize artwork URL for consistent comparison and storage.
 * Used by: server (deletedArtwork, cache hash), enrich-music.cjs, Enrich from URL.
 * Same URL in different forms (e.g. with/without fragment) should normalize to the same string.
 */
function normalizeArtworkUrl(url) {
  if (!url || typeof url !== "string") return "";
  let s = url.trim();
  try {
    const u = new URL(s);
    u.hash = "";
    u.searchParams.sort();
    s = u.href;
  } catch (_) {
    // leave as trimmed string
  }
  return s;
}

function getCoverCacheHash(url) {
  const normalized = normalizeArtworkUrl(url);
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

module.exports = { normalizeArtworkUrl, getCoverCacheHash };
