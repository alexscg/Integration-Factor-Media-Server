/**
 * Shared validation: ensure a URL returns 2xx and the response is an image
 * (Content-Type image/* or magic bytes). Used by enrich-music.cjs and server api (Enrich from URL).
 */
const https = require("https");
const http = require("http");

const DEFAULT_USER_AGENT = "IntegrationFactorMusicApp/1.0 (https://integrationfactor.com; contact@integrationfactor.com)";

function isImageMagic(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

/**
 * @param {string} url - Image URL to validate
 * @param {{ userAgent?: string, timeout?: number }} [opts]
 * @returns {Promise<boolean>}
 */
async function isValidImageUrl(url, opts = {}) {
  if (!url || typeof url !== "string" || !url.trim()) return false;
  const userAgent = opts.userAgent || DEFAULT_USER_AGENT;
  const timeout = opts.timeout ?? 12000;
  return new Promise((resolve) => {
    const u = url.trim();
    let parsed;
    try {
      parsed = new URL(u.startsWith("http") ? u : "https://" + u);
    } catch {
      return resolve(false);
    }
    const lib = parsed.protocol === "https:" ? https : http;
    const headers = { "User-Agent": userAgent, "Accept": "image/*" };
    if (parsed.hostname.toLowerCase() === "i.discogs.com") {
      headers["Referer"] = "https://www.discogs.com/";
    }
    const requestOpts = { headers, timeout };
    let settled = false;
    const once = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = lib.get(parsed.href, requestOpts, (res) => {
      const follow = res.statusCode >= 300 && res.statusCode < 400 && res.headers.location;
      if (follow) {
        return isValidImageUrl(res.headers.location, opts).then((v) => once(v));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return once(false);
      }
      const ct = (res.headers["content-type"] || "").toLowerCase().split(";")[0].trim();
      if (ct.startsWith("image/")) {
        res.destroy();
        return once(true);
      }
      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(chunk);
        if (chunks.length >= 2) {
          res.destroy();
          const buf = Buffer.concat(chunks);
          once(buf.length >= 12 && isImageMagic(buf));
        }
      });
      res.on("end", () => {
        if (settled) return;
        if (chunks.length > 0) {
          const buf = Buffer.concat(chunks);
          once(buf.length >= 4 && isImageMagic(buf));
        } else {
          once(!!ct.startsWith("image/"));
        }
      });
    });
    req.on("error", () => once(false));
    req.on("timeout", () => {
      req.destroy();
      once(false);
    });
  });
}

module.exports = { isValidImageUrl, isImageMagic };
