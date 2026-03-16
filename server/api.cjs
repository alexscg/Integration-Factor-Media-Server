const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { Resend } = require("resend");
const { MongoClient, ObjectId } = require("mongodb");
const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 3001;

// NAS config for download proxy
const NAS_HOST = process.env.NAS_HOST;
const NAS_PORT = process.env.NAS_PORT;
const NAS_USER = process.env.NAS_USER;
const NAS_PASS = process.env.NAS_PASS;

// Track running processes
const runningProcesses = {
  sync: null,
  enrich: null
};

// Configuration
const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || "integration-factor";
const TRACKS_COLLECTION = process.env.TRACKS_COLLECTION || process.env.COLLECTION_NAME || "tracks";
const ALBUMS_COLLECTION = process.env.ALBUMS_COLLECTION || "albums";
const DELETED_ARTWORK_COLLECTION = process.env.DELETED_ARTWORK_COLLECTION || "deletedArtwork";
const USERS_COLLECTION = "users";
const SESSIONS_COLLECTION = "sessions";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CONTACT_TO_EMAIL = process.env.CONTACT_TO_EMAIL || "integration.factor@gmail.com";
const CONTACT_FROM_EMAIL = process.env.CONTACT_FROM_EMAIL || "Integration Factor <onboarding@resend.dev>";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SYNC_ENRICH_ENABLED = process.env.SYNC_ENRICH_ENABLED === "true";
const COVER_CACHE_DIR = process.env.COVER_CACHE_DIR
  ? path.resolve(path.join(__dirname, ".."), process.env.COVER_CACHE_DIR)
  : null;
if (!MONGODB_URI || typeof MONGODB_URI !== "string" || !MONGODB_URI.trim()) {
  console.error("[api] MONGODB_URI is not set. Copy .env.example to .env and set MONGODB_URI (or copy .env from the UI repo).");
  process.exit(1);
}

if (COVER_CACHE_DIR) {
  if (!fs.existsSync(COVER_CACHE_DIR)) {
    fs.mkdirSync(COVER_CACHE_DIR, { recursive: true });
    console.log("[api] Cover cache dir created:", COVER_CACHE_DIR);
  }
}

// CORS: allow origins from env (comma-separated) or default DEV/PROD + localhost. Previews: *.vercel.app allowed when list is used.
const DEFAULT_CORS_ORIGINS = [
  "https://dev.integrationfactor.com",
  "https://integrationfactor.com",
  "https://www.integrationfactor.com",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
].join(",");
const corsOriginList = (process.env.CORS_ORIGINS || DEFAULT_CORS_ORIGINS)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (corsOriginList.includes(origin)) return cb(null, true);
    if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json());

// Resolve token from Authorization Bearer or x-admin-token
function getTokenFromRequest(req) {
  const authHeader = req.headers["authorization"];
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, "").trim();
  }
  return req.headers["x-admin-token"] || null;
}

// Validate auth: static ADMIN_TOKEN or valid session token
async function validateAuth(req) {
  const token = getTokenFromRequest(req);
  if (ADMIN_TOKEN && token === ADMIN_TOKEN) {
    return { ok: true, username: "admin" };
  }
  if (!token || !db) return { ok: false };
  const sessionsCollection = db.collection(SESSIONS_COLLECTION);
  const session = await sessionsCollection.findOne({
    token,
    expiresAt: { $gt: new Date() }
  });
  if (!session) return { ok: false };
  const usersCollection = db.collection(USERS_COLLECTION);
  const user = await usersCollection.findOne({ _id: session.userId });
  if (!user) return { ok: false };
  return { ok: true, username: user.username, userId: user._id };
}

// Admin protection middleware (accepts static token or session token)
const adminAuth = async (req, res, next) => {
  try {
    const auth = await validateAuth(req);
    if (!auth.ok) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    req.auth = auth;
    next();
  } catch (err) {
    next(err);
  }
};

// Helper to escape regex
function escapeRegex(text) {
  return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}

// Log every request to see what hits the server
app.use((req, res, next) => {
  console.log("[request]", req.method, req.url);
  next();
});

const { normalizeArtworkUrl } = require("../scripts/normalize-artwork-url.cjs");

let db;
let tracksColl;
let albumsColl;
let deletedArtworkColl;

// Connect to MongoDB
async function connectDB() {
  try {
    console.log("Connecting to MongoDB with URI:", MONGODB_URI ? "defined" : "undefined");
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DATABASE_NAME);
    tracksColl = db.collection(TRACKS_COLLECTION);
    albumsColl = db.collection(ALBUMS_COLLECTION);
    deletedArtworkColl = db.collection(DELETED_ARTWORK_COLLECTION);
    await deletedArtworkColl.createIndex(
      { albumId: 1, artworkUrl: 1 },
      { unique: true }
    ).catch(() => {});
    // Ensure unique index on users.username for auth
    const usersCol = db.collection(USERS_COLLECTION);
    await usersCol.createIndex({ username: 1 }, { unique: true }).catch(() => {});
    await db.collection(SESSIONS_COLLECTION).createIndex({ expiresAt: 1 }).catch(() => {});
    console.log("Connected to MongoDB");
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err);
    process.exit(1);
  }
}

// Health check – confirms this server is running and routes work
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "API server with download route is running" });
});

// Cover art proxy – avoids 401 from archive.org; caches images on disk when COVER_CACHE_DIR is set
const COVER_PROXY_USER_AGENT = "IntegrationFactorMusicApp/1.0 (https://integrationfactor.com; contact@integrationfactor.com)";

const COVER_ALLOWED_HOSTS = new Set([
  "coverartarchive.org",
  "archive.org",
  "discogs.com",
  "www.discogs.com",
  "i.discogs.com",
  "theaudiodb.com",
  "www.theaudiodb.com",
  "r2.theaudiodb.com",
]);

function isAllowedCoverProxyUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const h = u.hostname.toLowerCase().replace(/^www\./, "");
    if (COVER_ALLOWED_HOSTS.has(h)) return true;
    if (h.endsWith(".archive.org") || h.endsWith(".theaudiodb.com")) return true;
    return false;
  } catch {
    return false;
  }
}

const COVER_CACHE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
const CONTENT_TYPE_TO_EXT = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

function getCoverCacheHash(url) {
  const normalized = url.trim();
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

function getCoverCachePath(decodedUrl) {
  if (!COVER_CACHE_DIR) return null;
  const hash = getCoverCacheHash(decodedUrl);
  for (const ext of COVER_CACHE_EXTENSIONS) {
    const filePath = path.join(COVER_CACHE_DIR, hash + ext);
    if (fs.existsSync(filePath)) return { hash, ext, filePath };
  }
  return { hash, ext: null, filePath: null };
}

function ensureCoverCacheDir() {
  if (!COVER_CACHE_DIR) return;
  if (!fs.existsSync(COVER_CACHE_DIR)) {
    fs.mkdirSync(COVER_CACHE_DIR, { recursive: true });
  }
}

/** Delete cached file for this URL if present. Hash must match getCoverCacheHash (trim-only) for existing cache. */
function deleteCoverCacheByUrl(originalUrl) {
  if (!COVER_CACHE_DIR || !originalUrl) return;
  const decoded = typeof originalUrl === "string" ? originalUrl.trim() : "";
  if (!decoded) return;
  const hash = getCoverCacheHash(decoded);
  for (const ext of COVER_CACHE_EXTENSIONS) {
    const filePath = path.join(COVER_CACHE_DIR, hash + ext);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log("[api] Deleted cover cache file:", filePath);
      }
    } catch (err) {
      console.error("[api] Error deleting cover cache file:", err.message);
    }
  }
}

function contentTypeToExt(contentType) {
  if (!contentType || typeof contentType !== "string") return ".jpg";
  const ct = contentType.toLowerCase().split(";")[0].trim();
  return CONTENT_TYPE_TO_EXT[ct] || ".jpg";
}

// Cover Art Archive: on 404 for /front-250 or /front-500, try release JSON and use first image thumbnail
const CAA_HEADERS = {
  "User-Agent": COVER_PROXY_USER_AGENT,
  "Accept": "image/*",
  "Referer": "https://coverartarchive.org/",
};

async function fetchAsBuffer(url, headers = CAA_HEADERS) {
  let res = await fetch(url, { method: "GET", redirect: "manual", headers });
  // CAA returns 307 to the actual image (e.g. archive.org). Follow manually so we send the same headers.
  if (res.status === 307 || res.status === 302 || res.status === 301) {
    const location = res.headers.get("location");
    if (location) {
      const nextUrl = location.startsWith("http") ? location : new URL(location, url).href;
      if (isAllowedCoverProxyUrl(nextUrl)) {
        res = await fetch(nextUrl, { method: "GET", redirect: "follow", headers });
      }
    }
  }
  if (!res.ok) return { ok: false, status: res.status };
  const buf = await res.arrayBuffer();
  const contentType = res.headers.get("content-type") || "image/jpeg";
  return { ok: true, buf: Buffer.from(buf), contentType };
}

async function fetchCoverAsBuffer(url) {
  const headers = { "User-Agent": COVER_PROXY_USER_AGENT, "Accept": "image/*" };
  try {
    const u = new URL(url);
    if (u.hostname.toLowerCase() === "i.discogs.com") {
      headers["Referer"] = "https://www.discogs.com/";
    }
  } catch (_) {}
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers,
  });
  if (!res.ok) return { ok: false, status: res.status };
  const buf = await res.arrayBuffer();
  const contentType = res.headers.get("content-type") || "image/jpeg";
  return { ok: true, buf: Buffer.from(buf), contentType };
}

function getCoverArtArchiveFallbackUrl(decodedUrl) {
  // Match .../release/{mbid}/front-250 or .../front-500 (no community "front" chosen)
  const m = decodedUrl.match(/^https?:\/\/coverartarchive\.org\/release\/([a-f0-9-]{36})\/front-(250|500)\/?$/i);
  if (!m) return null;
  const [, mbid, size] = m;
  return { mbid, size };
}

const CAA_JSON_HEADERS = {
  "User-Agent": COVER_PROXY_USER_AGENT,
  "Accept": "application/json",
  "Referer": "https://coverartarchive.org/",
};

function pickFirstThumbUrl(first) {
  const thumbs = first?.thumbnails;
  if (!thumbs) return null;
  return thumbs["250"] || thumbs.small || thumbs["500"] || thumbs.large || first.image;
}

async function fetchFirstImageFromCoverArtArchive(mbid, useRelease = true) {
  const path = useRelease ? "release" : "release-group";
  const apiUrl = `https://coverartarchive.org/${path}/${mbid}`;
  const res = await fetch(apiUrl, {
    method: "GET",
    redirect: "follow",
    headers: CAA_JSON_HEADERS,
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || !Array.isArray(data.images) || data.images.length === 0) return null;
  return pickFirstThumbUrl(data.images[0]);
}

async function getReleaseGroupIdFromMusicBrainz(releaseMbid) {
  const url = `https://musicbrainz.org/ws/2/release/${releaseMbid}?fmt=json&inc=release-groups`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "User-Agent": COVER_PROXY_USER_AGENT },
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const rg = data?.["release-group"];
  return rg?.id || null;
}

// Cover-proxy: serve from cache if present, else fetch (CAA with fallback, others generic) and optionally cache
async function handleCoverProxy(req, res) {
  try {
    const raw = req.query.url;
    if (!raw || typeof raw !== "string") {
      return res.status(400).json({ error: "Missing url query" });
    }
    const decoded = decodeURIComponent(raw);
    if (!isAllowedCoverProxyUrl(decoded)) {
      return res.status(400).json({ error: "URL not allowed" });
    }

    ensureCoverCacheDir();
    const cacheInfo = getCoverCachePath(decoded);
    if (cacheInfo && cacheInfo.filePath) {
      const ext = path.extname(cacheInfo.filePath).toLowerCase();
      const contentType = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" }[ext] || "image/jpeg";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.sendFile(cacheInfo.filePath);
      return;
    }

    const isCaaOrArchive = () => {
      const h = new URL(decoded).hostname.toLowerCase();
      return h === "coverartarchive.org" || h === "archive.org" || h.endsWith(".archive.org");
    };

    let result;
    if (isCaaOrArchive()) {
      result = await fetchAsBuffer(decoded);
      if (!result.ok && result.status === 404) {
        const fallback = getCoverArtArchiveFallbackUrl(decoded);
        if (fallback) {
          let fallbackImageUrl = await fetchFirstImageFromCoverArtArchive(fallback.mbid, true);
          if (!fallbackImageUrl) {
            const releaseGroupId = await getReleaseGroupIdFromMusicBrainz(fallback.mbid);
            if (releaseGroupId) {
              fallbackImageUrl = await fetchFirstImageFromCoverArtArchive(releaseGroupId, false);
            }
          }
          if (fallbackImageUrl && isAllowedCoverProxyUrl(fallbackImageUrl)) {
            result = await fetchAsBuffer(fallbackImageUrl);
          }
        }
      }
    } else {
      result = await fetchCoverAsBuffer(decoded);
    }

    if (!result.ok) {
      return res.status(result.status === 401 ? 502 : result.status).json({
        error: "Upstream returned " + result.status,
      });
    }

    if (COVER_CACHE_DIR && result.buf && cacheInfo) {
      const ext = contentTypeToExt(result.contentType);
      const filePath = path.join(COVER_CACHE_DIR, cacheInfo.hash + ext);
      try {
        fs.writeFileSync(filePath, result.buf);
      } catch (writeErr) {
        console.error("[api] cover-proxy cache write error:", writeErr.message);
      }
    }

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", cacheInfo ? "public, max-age=31536000, immutable" : "public, max-age=86400");
    res.end(result.buf);
  } catch (err) {
    console.error("[api] cover-proxy error:", err.message);
    res.status(502).json({ error: "Proxy failed" });
  }
}

app.get("/api/cover-proxy", handleCoverProxy);
app.get("/api/cover-proxy/", handleCoverProxy);
app.get("/cover-proxy", handleCoverProxy); // in case proxy strips /api prefix

// --- Auth (Utils login) ---
// POST /api/auth/login — body: { username, password }; returns { token, expiresAt, username }
app.post("/api/auth/login", async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: "Database not ready" });
    const { username, password } = req.body || {};
    if (!username || typeof password !== "string") {
      return res.status(400).json({ error: "Username and password required" });
    }
    const usersCol = db.collection(USERS_COLLECTION);
    const user = await usersCol.findOne({ username: username.trim().toLowerCase() });
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const sessionsCol = db.collection(SESSIONS_COLLECTION);
    await sessionsCol.insertOne({
      token,
      userId: user._id,
      expiresAt
    });
    res.json({
      token,
      expiresAt: expiresAt.toISOString(),
      username: user.username
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me — validate token, return { username }; 401 if invalid
app.get("/api/auth/me", async (req, res) => {
  try {
    const auth = await validateAuth(req);
    if (!auth.ok) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    res.json({ username: auth.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/logout — invalidate session for token in header
app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = getTokenFromRequest(req);
    if (token && db) {
      const sessionsCol = db.collection(SESSIONS_COLLECTION);
      await sessionsCol.deleteOne({ token });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Contact form (3 per day per IP, email to integration.factor@gmail.com) ---
app.post("/api/contact", async (req, res) => {
  try {
    const { fullname, email, message } = req.body || {};
    if (!fullname || typeof fullname !== "string" || !fullname.trim()) {
      return res.status(400).json({ error: "Full name is required" });
    }
    if (!email || typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ error: "Email is required" });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ error: "Invalid email format" });
    }
    if (!message || typeof message !== "string" || message.trim().length < 10) {
      return res.status(400).json({ error: "Message must be at least 10 characters" });
    }
    if (!RESEND_API_KEY) {
      console.error("RESEND_API_KEY is not set; cannot send contact email");
      return res.status(503).json({ error: "Contact form is not configured. Please try again later." });
    }
    const resend = new Resend(RESEND_API_KEY);
    const html = [
      "<p><strong>From:</strong> " + escapeHtml(fullname.trim()) + "</p>",
      "<p><strong>Email:</strong> " + escapeHtml(email.trim()) + "</p>",
      "<p><strong>Message:</strong></p>",
      "<p>" + escapeHtml(message.trim()).replace(/\n/g, "<br>") + "</p>",
    ].join("");
    const { data, error } = await resend.emails.send({
      from: CONTACT_FROM_EMAIL,
      to: [CONTACT_TO_EMAIL],
      replyTo: email.trim(),
      subject: "Contact form: " + (fullname.trim().slice(0, 50) || "Message"),
      html,
    });
    if (error) {
      console.error("Resend error:", error.message || error);
      return res.status(502).json({
        error: "Failed to send message. Please try again later.",
        hint: process.env.NODE_ENV !== "production" ? (error.message || String(error)) : undefined,
      });
    }
    res.json({ success: true, id: data?.id });
  } catch (err) {
    console.error("Contact error:", err);
    res.status(500).json({ error: err.message });
  }
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Get all tracks (paginated)
app.get("/api/music", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 50);
    const skip = (page - 1) * limit;
    
    const music = await tracksColl.find({}).skip(skip).limit(limit).toArray();
    const total = await tracksColl.countDocuments();
    
    res.json({
      data: music,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get one album by _id and the page it would appear on (sort: artist, album; no genre filter)
app.get("/api/albums/by-id/:id", async (req, res) => {
  try {
    if (!db || !albumsColl) return res.status(503).json({ error: "Database not ready" });
    let oid;
    try {
      oid = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: "Invalid album id" });
    }
    const album = await albumsColl.findOne({ _id: oid });
    if (!album) return res.status(404).json({ error: "Album not found" });
    const limit = 10;
    const artistVal = album.artist ?? "";
    const albumVal = album.album ?? "";
    const sortBefore = {
      $or: [
        { artist: { $lt: artistVal } },
        { artist: artistVal, album: { $lt: albumVal } }
      ]
    };
    const countBefore = await albumsColl.countDocuments(sortBefore);
    const page = Math.max(1, Math.ceil((countBefore + 1) / limit));
    res.json({ data: album, page, limit });
  } catch (err) {
    console.error("[api] /api/albums/by-id error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get all albums (paginated) from albums collection
app.get("/api/albums", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 10);
    const skip = (page - 1) * limit;
    const genre = req.query.genre;

    const filter = genre ? { genre: { $regex: genre, $options: "i" } } : {};
    const albums = await albumsColl.find(filter).sort({ artist: 1, album: 1 }).skip(skip).limit(limit).toArray();
    const total = await albumsColl.countDocuments(filter);

    res.json({
      data: albums,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error("[api] /api/albums error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Delete artwork from album + cache, record in deletedArtwork (admin only). Uniqueness is per album only.
app.delete("/api/albums/:albumId/artwork", adminAuth, async (req, res) => {
  try {
    if (!db || !albumsColl || !deletedArtworkColl) return res.status(503).json({ error: "Database not ready" });
    let albumOid;
    try {
      albumOid = new ObjectId(req.params.albumId);
    } catch {
      return res.status(400).json({ error: "Invalid album id" });
    }
    const url = req.body?.url;
    if (!url || typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "url is required in body" });
    }
    const originalUrl = url.trim();
    const normalizedUrl = normalizeArtworkUrl(originalUrl);

    const album = await albumsColl.findOne({ _id: albumOid });
    if (!album) return res.status(404).json({ error: "Album not found" });

    const primarySmall = album.coverArtSmall || null;
    const primaryLarge = album.coverArtLarge || album.coverArtSmall || null;
    const extra = Array.isArray(album.coverArtworkExtra) ? album.coverArtworkExtra : [];
    const urlsToMatch = [primarySmall, primaryLarge].filter(Boolean);
    for (const e of extra) {
      const u = e?.large || e?.small;
      if (u) urlsToMatch.push(u);
    }
    const normalizedMatch = (u) => u && normalizeArtworkUrl(u) === normalizedUrl;
    const isOnAlbum = urlsToMatch.some(normalizedMatch);

    const update = {};
    if (normalizedMatch(primarySmall) || normalizedMatch(primaryLarge)) {
      const remaining = extra.filter((e) => {
        const u = e?.large || e?.small;
        return !u || normalizeArtworkUrl(u) !== normalizedUrl;
      });
      const first = remaining[0];
      const fallback = first ? (first.large || first.small) : null;
      update.coverArtSmall = fallback || null;
      update.coverArtLarge = fallback || null;
      update.coverArtworkExtra = fallback ? remaining.slice(1) : remaining;
    } else {
      update.coverArtworkExtra = extra.filter((e) => {
        const u = e?.large || e?.small;
        return !u || normalizeArtworkUrl(u) !== normalizedUrl;
      });
    }

    if (Object.keys(update).length) {
      await albumsColl.updateOne({ _id: albumOid }, { $set: update });
    }

    deleteCoverCacheByUrl(originalUrl);
    await deletedArtworkColl.updateOne(
      { albumId: albumOid, artworkUrl: normalizedUrl },
      { $set: { albumId: albumOid, artworkUrl: normalizedUrl, deletedAt: new Date() } },
      { upsert: true }
    );

    const updated = await albumsColl.findOne({ _id: albumOid });
    res.json({ data: updated });
  } catch (err) {
    console.error("[api] DELETE /api/albums/:albumId/artwork error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Make an artwork URL the primary cover for the album (admin only)
app.post("/api/albums/:albumId/artwork/primary", adminAuth, async (req, res) => {
  try {
    if (!db || !albumsColl) return res.status(503).json({ error: "Database not ready" });
    let albumOid;
    try {
      albumOid = new ObjectId(req.params.albumId);
    } catch {
      return res.status(400).json({ error: "Invalid album id" });
    }
    const url = req.body?.url;
    if (!url || typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "url is required in body" });
    }
    const originalUrl = url.trim();
    const normalizedUrl = normalizeArtworkUrl(originalUrl);

    const album = await albumsColl.findOne({ _id: albumOid });
    if (!album) return res.status(404).json({ error: "Album not found" });

    const primaryLarge = album.coverArtLarge || album.coverArtSmall || null;
    const primarySmall = album.coverArtSmall || null;
    const extra = Array.isArray(album.coverArtworkExtra) ? album.coverArtworkExtra : [];
    if (normalizedUrl === normalizeArtworkUrl(primarySmall) || normalizedUrl === normalizeArtworkUrl(primaryLarge)) {
      return res.json({ data: album });
    }

    let newPrimaryUrl = null;
    for (const e of extra) {
      const u = e?.large || e?.small;
      if (u && normalizeArtworkUrl(u) === normalizedUrl) {
        newPrimaryUrl = u;
        break;
      }
    }
    if (!newPrimaryUrl) return res.status(400).json({ error: "URL not found on album" });

    const newExtra = [];
    if (primaryLarge || primarySmall) {
      const prev = primaryLarge || primarySmall;
      if (prev !== newPrimaryUrl) newExtra.push({ small: prev, large: prev });
    }
    for (const e of extra) {
      const u = e?.large || e?.small;
      if (u && normalizeArtworkUrl(u) !== normalizedUrl) newExtra.push(e);
    }

    await albumsColl.updateOne(
      { _id: albumOid },
      { $set: { coverArtSmall: newPrimaryUrl, coverArtLarge: newPrimaryUrl, coverArtworkExtra: newExtra } }
    );
    const updated = await albumsColl.findOne({ _id: albumOid });
    res.json({ data: updated });
  } catch (err) {
    console.error("[api] POST /api/albums/:albumId/artwork/primary error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get tracks for one album (by album _id)
app.get("/api/albums/:albumId/tracks", async (req, res) => {
  try {
    const albumId = req.params.albumId;
    let oid;
    try {
      oid = new ObjectId(albumId);
    } catch {
      return res.status(400).json({ error: "Invalid album id" });
    }
    const tracks = await tracksColl.find({ albumId: oid }).sort({ discNumber: 1, name: 1 }).toArray();
    res.json({ data: tracks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search music
app.get("/api/music/search", async (req, res) => {
  try {
    const { q, genre, artist, field } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 50);
    const skip = (page - 1) * limit;
    
    let filter = {};
    
    let albumIdMatch = null;
    if (q) {
      const trimmed = String(q).trim();
      // If query looks like a MongoDB ObjectId (24 hex chars), treat as "find album by ID" → return only the album, not tracks
      const isObjectId = /^[a-f0-9]{24}$/i.test(trimmed);
      if (isObjectId && albumsColl) {
        try {
          const oid = new ObjectId(trimmed);
          albumIdMatch = await albumsColl.findOne({ _id: oid });
        } catch (_) {}
      }
      if (!albumIdMatch) {
        const escapedQ = escapeRegex(trimmed);
        const searchRegex = { $regex: escapedQ, $options: "i" };
        if (field && field !== "all") {
          if (field === "year") {
            filter.$or = [
              { year: searchRegex },
              { releaseYear: searchRegex }
            ];
          } else {
            filter[field] = searchRegex;
          }
        } else {
          filter.$or = [
            { name: searchRegex },
            { artist: searchRegex },
            { album: searchRegex },
            { year: searchRegex },
            { releaseYear: searchRegex }
          ];
        }
      }
    }
    if (albumIdMatch) {
      // Album ID search: return no tracks, only the matched album so UI can show "album found" and link to Browse
      return res.json({
        data: [],
        page: 1,
        limit,
        total: 0,
        totalPages: 0,
        albumIdMatch
      });
    }
    if (genre) {
      filter.genre = { $regex: genre, $options: "i" };
    }
    if (artist) {
      filter.artist = { $regex: artist, $options: "i" };
    }
    
    const music = await tracksColl.find(filter).skip(skip).limit(limit).toArray();
    const total = await tracksColl.countDocuments(filter);
    
    res.json({
      data: music,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get genres (from tracks)
app.get("/api/genres", async (req, res) => {
  try {
    const genres = await tracksColl.distinct("genre");
    res.setHeader("Cache-Control", "public, max-age=300"); // 5 minutes
    res.json(genres);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get artists
app.get("/api/artists", async (req, res) => {
  try {
    const { genre } = req.query;
    let filter = {};
    if (genre) {
      filter.genre = genre;
    }
    const artists = await tracksColl.distinct("artist", filter);
    res.json(artists);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get stats
app.get("/api/stats", async (req, res) => {
  try {
    const total = await tracksColl.countDocuments();
    const genres = await tracksColl.distinct("genre");
    const artists = await tracksColl.distinct("artist");
    
    res.setHeader("Cache-Control", "public, max-age=300"); // 5 minutes
    res.json({
      totalSongs: total,
      totalGenres: genres.length,
      totalArtists: artists.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get enrichment progress (protected)
app.get("/api/enrichment-progress", adminAuth, async (req, res) => {
  try {
    const progressFile = path.join(__dirname, "..", "scripts", "enrich-progress.json");
    
    const lastRunStatsFile = path.join(__dirname, "..", "scripts", "enrich-last-run-stats.json");
    let lastRunStats = null;
    try {
      if (fs.existsSync(lastRunStatsFile)) {
        lastRunStats = JSON.parse(fs.readFileSync(lastRunStatsFile, "utf8"));
      }
    } catch (e) {
      // ignore
    }

    if (!fs.existsSync(progressFile)) {
      return res.json({
        running: runningProcesses.enrich !== null,
        progress: 0,
        processed: 0,
        total: 0,
        stats: null,
        lastRunStats
      });
    }

    const progressData = JSON.parse(fs.readFileSync(progressFile, "utf8"));
    const processedCount = Object.keys(progressData.processedAlbums || {}).length;

    // Get total albums count from DB (albums collection)
    const totalAlbums = await albumsColl.countDocuments();

    let total = totalAlbums;
    // If library changed since progress file was created, processedCount can exceed total.
    // Clamp total so progress does not go above 100%.
    if (total > 0 && processedCount > total) {
      total = processedCount;
    }
    const rawProgress = total > 0 ? (processedCount / total) * 100 : 0;
    const progress = Math.min(100, Math.round(rawProgress));

    res.json({
      running: runningProcesses.enrich !== null,
      progress,
      processed: processedCount,
      total,
      stats: progressData.stats || null,
      lastRunStats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get NAS sync progress (protected)
app.get("/api/sync-progress", adminAuth, async (req, res) => {
  try {
    const progressFile = path.join(__dirname, "..", "scripts", "nas-sync-progress.json");
    
    if (!fs.existsSync(progressFile)) {
      return res.json({
        status: "idle",
        running: false,
        scanned: 0,
        synced: 0,
        total: 0,
        lastTotal: 0,
        startTime: null,
        endTime: null,
        error: null
      });
    }
    
    const progressData = JSON.parse(fs.readFileSync(progressFile, "utf8"));
    progressData.running = runningProcesses.sync !== null;
    
    res.json(progressData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start NAS sync
app.post("/api/sync/start", adminAuth, (req, res) => {
  if (!SYNC_ENRICH_ENABLED) {
    return res.status(503).json({ error: "Sync and enrichment are disabled in this environment. Run from local only." });
  }
  if (runningProcesses.sync) {
    return res.status(400).json({ error: "Sync already running" });
  }
  
  const scriptPath = path.join(__dirname, "..", "scripts", "nas-sync.cjs");
  
  console.log("Starting NAS sync...");
  const proc = spawn("node", [scriptPath], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit"
  });
  
  runningProcesses.sync = proc;
  
  proc.on("close", (code) => {
    console.log(`NAS sync finished with code ${code}`);
    runningProcesses.sync = null;
  });
  
  proc.on("error", (err) => {
    console.error("NAS sync error:", err);
    runningProcesses.sync = null;
  });
  
  res.json({ success: true, message: "NAS sync started" });
});

// Stop NAS sync
app.post("/api/sync/stop", adminAuth, (req, res) => {
  if (!SYNC_ENRICH_ENABLED) {
    return res.status(503).json({ error: "Sync and enrichment are disabled in this environment. Run from local only." });
  }
  if (!runningProcesses.sync) {
    return res.status(400).json({ error: "No sync running" });
  }
  
  runningProcesses.sync.kill();
  runningProcesses.sync = null;
  
  res.json({ success: true, message: "NAS sync stopped" });
});

// Start enrichment – reset progress and stats so the script runs from zero; keep previous run stats for display
app.post("/api/enrich/start", adminAuth, (req, res) => {
  if (!SYNC_ENRICH_ENABLED) {
    return res.status(503).json({ error: "Sync and enrichment are disabled in this environment. Run from local only." });
  }
  if (runningProcesses.enrich) {
    return res.status(400).json({ error: "Enrichment already running" });
  }

  const progressFile = path.join(__dirname, "..", "scripts", "enrich-progress.json");
  const lastRunStatsFile = path.join(__dirname, "..", "scripts", "enrich-last-run-stats.json");
  try {
    if (fs.existsSync(progressFile)) {
      const existing = JSON.parse(fs.readFileSync(progressFile, "utf8"));
      if (existing.stats) {
        fs.writeFileSync(lastRunStatsFile, JSON.stringify(existing.stats, null, 2), "utf8");
      }
    }
  } catch (e) {
    // ignore
  }
  const resetProgress = {
    processedAlbums: {},
    stats: { found: 0, notFound: 0, withArt: 0, byMethod: {} }
  };
  fs.writeFileSync(progressFile, JSON.stringify(resetProgress, null, 2), "utf8");

  const scriptPath = path.join(__dirname, "..", "scripts", "enrich-music.cjs");

  console.log("Starting enrichment (progress reset to zero)...");
  const proc = spawn("node", [scriptPath], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit"
  });

  runningProcesses.enrich = proc;

  proc.on("close", (code) => {
    console.log(`Enrichment finished with code ${code}`);
    runningProcesses.enrich = null;
  });

  proc.on("error", (err) => {
    console.error("Enrichment error:", err);
    runningProcesses.enrich = null;
  });

  res.json({ success: true, message: "Enrichment started" });
});

// Stop enrichment
app.post("/api/enrich/stop", adminAuth, (req, res) => {
  if (!SYNC_ENRICH_ENABLED) {
    return res.status(503).json({ error: "Sync and enrichment are disabled in this environment. Run from local only." });
  }
  if (!runningProcesses.enrich) {
    return res.status(400).json({ error: "No enrichment running" });
  }

  runningProcesses.enrich.kill();
  runningProcesses.enrich = null;

  res.json({ success: true, message: "Enrichment stopped" });
});

// Single album enrichment – run enrichment only for the album with this albumId (or mbReleaseId)
app.post("/api/enrich/single", adminAuth, (req, res) => {
  if (!SYNC_ENRICH_ENABLED) {
    return res.status(503).json({ error: "Sync and enrichment are disabled in this environment. Run from local only." });
  }
  if (runningProcesses.enrich) {
    return res.status(400).json({ error: "Full enrichment is running; stop it first" });
  }
  const albumId = req.body?.albumId;
  if (!albumId || typeof albumId !== "string" || !albumId.trim()) {
    return res.status(400).json({ error: "albumId is required" });
  }
  const id = albumId.trim();
  const scriptPath = path.join(__dirname, "..", "scripts", "enrich-music.cjs");
  console.log("Starting single album enrichment for albumId:", id);
  const proc = spawn("node", [scriptPath, "--single", id], {
    cwd: path.join(__dirname, ".."),
    stdio: ["inherit", "pipe", "pipe"]
  });
  proc.stdout.on("data", (chunk) => process.stdout.write(chunk));
  proc.stderr.on("data", (chunk) => process.stderr.write(chunk));
  proc.on("close", (code) => {
    const status = code === 0 ? "success" : "failed";
    console.log(`Single album enrichment finished with code ${code} (${status})`);
  });
  proc.on("error", (err) => {
    console.error("Single album enrichment error:", err);
  });
  res.json({ success: true, message: `Single album enrichment started for albumId: ${id}` });
});

// Get overall status (protected)
app.get("/api/status", adminAuth, (req, res) => {
  res.json({
    syncRunning: runningProcesses.sync !== null,
    enrichRunning: runningProcesses.enrich !== null
  });
});

// --- Enrich from URL (MusicBrainz, Discogs, or TheAudioDB page URL) ---
const DISCOGS_KEY = process.env.DISCOGS_CONSUMER_KEY;
const DISCOGS_SECRET = process.env.DISCOGS_CONSUMER_SECRET;
const THEAUDIODB_API_KEY = process.env.THEAUDIODB_API_KEY || process.env.VITE_THEAUDIODB_API_KEY;
const DISCOGS_USER_AGENT = "IntegrationFactorMusicApp/1.0 (https://integrationfactor.com; contact@integrationfactor.com)";
const { isValidImageUrl } = require("../scripts/validate-cover-url.cjs");

function parseEnrichmentUrl(urlString) {
  if (!urlString || typeof urlString !== "string") return null;
  const trimmed = urlString.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed.startsWith("http") ? trimmed : "https://" + trimmed);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = u.pathname.replace(/\/+$/, "") || "/";

    // MusicBrainz: .../release/<uuid>
    if (host === "musicbrainz.org") {
      const m = pathname.match(/^\/release\/([a-f0-9-]{36})/i);
      if (m) return { service: "musicbrainz", id: m[1] };
    }
    // Discogs: .../release/<numeric> or .../master/<numeric> or .../master/<numeric>-slug
    if (host === "discogs.com") {
      const releaseM = pathname.match(/^\/release\/(\d+)/);
      if (releaseM) return { service: "discogs", id: releaseM[1] };
      const masterM = pathname.match(/^\/master\/(\d+)(?:[-/]|$)/);
      if (masterM) return { service: "discogs-master", id: masterM[1] };
    }
    // TheAudioDB: .../album/<id>
    if (host === "theaudiodb.com") {
      const m = pathname.match(/^\/album\/(\d+)/);
      if (m) return { service: "theaudiodb", id: m[1] };
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchMetadataFromMusicBrainz(mbid) {
  const releaseUrl = `https://musicbrainz.org/ws/2/release/${mbid}?fmt=json`;
  console.log("[MusicBrainz] GET (from-url)", releaseUrl);
  console.log("[MusicBrainz] payload:", { mbid });
  const res = await fetch(releaseUrl, {
    headers: { "User-Agent": COVER_PROXY_USER_AGENT, "Accept": "application/json" },
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data) return null;
  const title = data.title || null;
  const date = data.date ? data.date.substring(0, 4) : null;
  const artistCredit = data["artist-credit"] && data["artist-credit"][0];
  const artist = artistCredit?.artist?.name || artistCredit?.name || null;
  let coverSmall = null;
  let coverLarge = null;
  try {
    const caaUrl = `https://coverartarchive.org/release/${mbid}`;
    console.log("[MusicBrainz] GET (from-url, cover art)", caaUrl);
    const caaRes = await fetch(caaUrl, {
      headers: { "User-Agent": COVER_PROXY_USER_AGENT, "Accept": "application/json" },
    });
    if (caaRes.ok) {
      const caa = await caaRes.json().catch(() => null);
      if (caa?.images?.length) {
        const thumb = caa.images[0].thumbnails?.small || caa.images[0].thumbnails?.["250"] || caa.images[0].image;
        const large = caa.images[0].thumbnails?.large || caa.images[0].thumbnails?.["500"] || caa.images[0].image;
        if (thumb) coverSmall = thumb;
        if (large) coverLarge = large;
      }
    }
  } catch (_) {}
  return {
    mbReleaseId: mbid,
    album: title,
    artist,
    releaseYear: date,
    coverArtSmall: coverSmall,
    coverArtLarge: coverLarge || coverSmall,
    mbMatchMethod: "from-url (MusicBrainz)",
  };
}

/** Resolve a Discogs master ID to a release ID (first version). */
async function resolveDiscogsMasterToRelease(masterId) {
  if (!DISCOGS_KEY || !DISCOGS_SECRET) return null;
  const url = `https://api.discogs.com/masters/${masterId}/versions?per_page=1`;
  console.log("[Discogs] GET (from-url, master versions)", url);
  const auth = Buffer.from(`${DISCOGS_KEY}:${DISCOGS_SECRET}`).toString("base64");
  const res = await fetch(url, {
    headers: {
      "User-Agent": DISCOGS_USER_AGENT,
      "Authorization": `Basic ${auth}`,
      "Accept": "application/json",
    },
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const first = data?.versions?.[0];
  return first?.id != null ? String(first.id) : null;
}

async function fetchMetadataFromDiscogs(releaseId) {
  if (!DISCOGS_KEY || !DISCOGS_SECRET) return null;
  const url = `https://api.discogs.com/releases/${releaseId}`;
  console.log("[Discogs] GET (from-url)", url);
  console.log("[Discogs] payload:", { releaseId });
  const auth = Buffer.from(`${DISCOGS_KEY}:${DISCOGS_SECRET}`).toString("base64");
  const res = await fetch(url, {
    headers: {
      "User-Agent": DISCOGS_USER_AGENT,
      "Authorization": `Basic ${auth}`,
      "Accept": "application/json",
    },
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data) return null;
  const title = data.title || null;
  const year = data.year ? String(data.year).substring(0, 4) : null;
  const artist = data.artists?.[0]?.name || null;
  const cover = data.cover_image || data.thumb || null;
  return {
    album: title,
    artist,
    releaseYear: year,
    coverArtSmall: cover,
    coverArtLarge: cover,
    mbMatchMethod: "from-url (Discogs)",
  };
}

async function fetchMetadataFromTheAudioDB(albumId) {
  if (!THEAUDIODB_API_KEY) return null;
  const url = `https://theaudiodb.com/api/v1/json/${THEAUDIODB_API_KEY}/album.php?m=${albumId}`;
  console.log("[TheAudioDB] GET (from-url)", url);
  console.log("[TheAudioDB] payload:", { albumId });
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const album = data?.album?.[0] || data?.albums?.[0];
  if (!album) return null;
  const title = album.strAlbum || null;
  const artist = album.strArtist || null;
  const year = album.intYearReleased ? String(album.intYearReleased) : null;
  const genre = album.strGenre || null;
  const thumb = album.strAlbumThumb || album.strAlbum3DThumb || null;
  return {
    album: title,
    artist,
    releaseYear: year,
    genre,
    coverArtSmall: thumb,
    coverArtLarge: thumb,
    mbMatchMethod: "from-url (TheAudioDB)",
  };
}

app.post("/api/enrich/from-url", adminAuth, async (req, res) => {
  if (!SYNC_ENRICH_ENABLED) {
    return res.status(503).json({ error: "Sync and enrichment are disabled in this environment. Run from local only." });
  }
  try {
    if (!db || !albumsColl) return res.status(503).json({ error: "Database not ready" });
    const { albumId, url } = req.body || {};
    if (!albumId || typeof albumId !== "string" || !albumId.trim()) {
      return res.status(400).json({ error: "albumId is required" });
    }
    if (!url || typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "url is required" });
    }
    const idTrim = albumId.trim();
    const urlTrim = url.trim();
    console.log("Enrich from URL: albumId=" + idTrim + ", url=" + urlTrim);
    const parsed = parseEnrichmentUrl(urlTrim);
    if (!parsed) {
      console.log("Enrich from URL: unsupported or invalid URL");
      return res.status(400).json({
        error: "Unsupported or invalid URL. Use a MusicBrainz release, Discogs release or master, or TheAudioDB album page.",
      });
    }
    console.log("Enrich from URL: parsed service=" + parsed.service + ", id=" + parsed.id);
    let metadata = null;
    if (parsed.service === "musicbrainz") {
      metadata = await fetchMetadataFromMusicBrainz(parsed.id);
    } else if (parsed.service === "discogs") {
      metadata = await fetchMetadataFromDiscogs(parsed.id);
    } else if (parsed.service === "discogs-master") {
      const releaseId = await resolveDiscogsMasterToRelease(parsed.id);
      if (!releaseId) {
        console.log("Enrich from URL: could not resolve Discogs master to release");
        return res.status(502).json({
          error: "Could not resolve Discogs master to a release. Try a direct release URL.",
        });
      }
      metadata = await fetchMetadataFromDiscogs(releaseId);
    } else if (parsed.service === "theaudiodb") {
      metadata = await fetchMetadataFromTheAudioDB(parsed.id);
    }
    if (!metadata) {
      console.log("Enrich from URL: could not fetch metadata from " + parsed.service);
      return res.status(502).json({
        error: `Could not fetch metadata from ${parsed.service}. Check the URL and try again.`,
      });
    }
    let albumOid = null;
    if (ObjectId.isValid(idTrim) && String(new ObjectId(idTrim)) === idTrim) {
      albumOid = new ObjectId(idTrim);
    }
    let albumDoc = await (albumOid ? albumsColl.findOne({ _id: albumOid }) : null);
    if (!albumDoc) {
      albumDoc = await albumsColl.findOne({ $or: [ { mbReleaseId: idTrim }, { albumId: idTrim } ] });
    }
    if (!albumDoc) {
      console.log("Enrich from URL: album not found with albumId=" + idTrim);
      return res.status(404).json({ error: "Album not found with that albumId." });
    }
    const updatePayload = {};
    const validateCover = (url) => isValidImageUrl(url, { userAgent: DISCOGS_USER_AGENT });
    const isDeleted = async (artworkUrl) => {
      if (!deletedArtworkColl) return false;
      const norm = normalizeArtworkUrl(artworkUrl);
      const doc = await deletedArtworkColl.findOne({ albumId: albumDoc._id, artworkUrl: norm });
      return !!doc;
    };
    if (metadata.coverArtSmall && !(await isDeleted(metadata.coverArtSmall))) {
      const smallValid = await validateCover(metadata.coverArtSmall);
      if (smallValid) {
        updatePayload.coverArtSmall = metadata.coverArtSmall;
        if (metadata.coverArtLarge && metadata.coverArtLarge !== metadata.coverArtSmall) {
          if (!(await isDeleted(metadata.coverArtLarge))) {
            const largeValid = await validateCover(metadata.coverArtLarge);
            if (largeValid) updatePayload.coverArtLarge = metadata.coverArtLarge;
            else updatePayload.coverArtLarge = metadata.coverArtSmall;
          } else updatePayload.coverArtLarge = metadata.coverArtSmall;
        } else {
          updatePayload.coverArtLarge = metadata.coverArtSmall;
        }
      } else if (metadata.coverArtLarge && !(await isDeleted(metadata.coverArtLarge))) {
        const largeValid = await validateCover(metadata.coverArtLarge);
        if (largeValid) {
          updatePayload.coverArtSmall = metadata.coverArtLarge;
          updatePayload.coverArtLarge = metadata.coverArtLarge;
        }
      }
    } else if (metadata.coverArtLarge && !(await isDeleted(metadata.coverArtLarge))) {
      const largeValid = await validateCover(metadata.coverArtLarge);
      if (largeValid) {
        updatePayload.coverArtSmall = metadata.coverArtLarge;
        updatePayload.coverArtLarge = metadata.coverArtLarge;
      }
    }
    if (metadata.mbReleaseId) updatePayload.mbReleaseId = metadata.mbReleaseId;
    if (metadata.releaseYear) updatePayload.releaseYear = metadata.releaseYear;
    if (metadata.genre) updatePayload.genre = metadata.genre;
    if (metadata.album != null) updatePayload.album = metadata.album;
    if (metadata.artist != null) updatePayload.artist = metadata.artist;
    if (metadata.mbMatchMethod) updatePayload.mbMatchMethod = metadata.mbMatchMethod;
    await albumsColl.updateOne({ _id: albumDoc._id }, { $set: updatePayload });
    console.log("Enrich from URL: updated album " + albumDoc._id + " from " + parsed.service + " (" + parsed.id + ")");
    console.log("Enrich from URL: fields updated:", Object.keys(updatePayload).join(", "));
    return res.json({
      success: true,
      message: `Album updated from ${parsed.service}.`,
      updated: Object.keys(updatePayload),
    });
  } catch (err) {
    console.error("Enrich from URL error:", err.message || err);
    return res.status(500).json({ error: err.message || "Enrich from URL failed" });
  }
});

// Authenticate with NAS and return session id
function nasAuth() {
  return new Promise((resolve, reject) => {
    const reqPath = `/webapi/entry.cgi?api=SYNO.API.Auth&version=7&method=login&account=${NAS_USER}&passwd=${encodeURIComponent(NAS_PASS)}&session=FileStation&format=sid`;
    const url = `http://${NAS_HOST}:${NAS_PORT}${reqPath}`;
    http.get(url, (resp) => {
      let data = "";
      resp.on("data", (chunk) => (data += chunk));
      resp.on("end", () => {
        try {
          const result = JSON.parse(data);
          if (result.success) resolve(result.data.sid);
          else reject(new Error(result.error?.code || "NAS auth failed"));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

// MIME type from file extension for audio (browser needs this to decode)
function getAudioMimeType(filename) {
  const ext = (filename || "").toLowerCase().replace(/^.*\./, "");
  const mime = {
    mp3: "audio/mpeg",
    mpeg: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    flac: "audio/flac",
    wav: "audio/wav",
    ogg: "audio/ogg",
    wma: "audio/x-ms-wma",
  }[ext];
  return mime || null;
}

// Request a URL and pipe to res, following redirects; allowOrigin is for CORS; rangeHeader for byte-range (playback)
function pipeNasDownload(downloadUrl, res, filename, disposition, allowOrigin, rangeHeader, followRedirect = true) {
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; IntegrationFactor/1.0)" };
  if (rangeHeader) headers.Range = rangeHeader;
  const opts = { headers };
  const req = http.get(downloadUrl, opts, (nasRes) => {
    // Follow redirect (NAS often returns 302 to the actual file)
    if (followRedirect && (nasRes.statusCode === 301 || nasRes.statusCode === 302)) {
      const location = nasRes.headers.location;
      if (location) {
        nasRes.resume(); // drain body so connection can be reused
        const redirectUrl = location.startsWith("http") ? location : `http://${NAS_HOST}:${NAS_PORT}${location}`;
        return pipeNasDownload(redirectUrl, res, filename, disposition, allowOrigin, rangeHeader, true);
      }
    }
    if (nasRes.statusCode !== 200 && nasRes.statusCode !== 206) {
      let body = "";
      nasRes.on("data", (c) => (body += c));
      nasRes.on("end", () => res.status(502).json({ error: "NAS download failed", detail: body }));
      return;
    }
    const ct = (nasRes.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    // Don't pipe non-media responses (browser would get "format error")
    if (ct.includes("application/json") || ct.includes("text/html") || ct.includes("text/plain")) {
      let body = "";
      nasRes.on("data", (c) => (body += c));
      nasRes.on("end", () => {
        console.warn("[download] NAS returned non-audio. Content-Type:", ct, "preview:", body.slice(0, 150));
        if (ct.includes("application/json")) {
          try {
            const j = JSON.parse(body);
            if (j && !j.success) res.status(502).json({ error: "NAS error", detail: j });
            else res.status(502).json({ error: "Unexpected NAS response" });
          } catch {
            res.status(502).json({ error: "NAS returned invalid response" });
          }
        } else {
          res.status(502).json({ error: "NAS returned non-audio response", contentType: ct });
        }
      });
      return;
    }
    // Sniff first chunk: NAS may return JSON/HTML with wrong Content-Type
    let firstChunk = null;
    const onFirstData = (chunk) => {
      if (firstChunk !== null) return;
      firstChunk = chunk;
      nasRes.pause();
      const b0 = chunk[0];
      const looksLikeJson = b0 === 0x7b; // {
      const looksLikeHtml = b0 === 0x3c; // <
      if (looksLikeJson || looksLikeHtml) {
        let body = chunk.toString("utf8");
        nasRes.on("data", (c) => (body += c.toString("utf8")));
        nasRes.on("end", () => {
          console.warn("[download] NAS returned text (not audio). Preview:", body.slice(0, 250));
          if (!res.headersSent) res.status(502).json({ error: "NAS returned text, not audio", preview: body.slice(0, 120) });
        });
        nasRes.resume();
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", allowOrigin || "*");
      res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
      res.setHeader("Content-Disposition", `${disposition}; filename="${filename.replace(/"/g, '\\"')}"`);
      const contentType = getAudioMimeType(filename) || (ct ? nasRes.headers["content-type"] : null) || "application/octet-stream";
      res.setHeader("Content-Type", contentType);
      if (nasRes.statusCode === 206) {
        res.status(206);
        const cr = nasRes.headers["content-range"];
        if (cr) res.setHeader("Content-Range", cr);
      }
      const cl = nasRes.headers["content-length"];
      if (cl) res.setHeader("Content-Length", cl);
      if (nasRes.headers["accept-ranges"]) res.setHeader("Accept-Ranges", nasRes.headers["accept-ranges"]);
      console.log("[download] piping audio. NAS Content-Type:", nasRes.headers["content-type"], "->", contentType);
      res.write(chunk);
      nasRes.removeListener("data", onFirstData);
      nasRes.pipe(res);
    };
    nasRes.on("data", onFirstData);
    nasRes.on("end", () => {
      if (firstChunk === null && !res.headersSent) res.status(502).json({ error: "NAS returned empty body" });
    });
  });
  req.on("error", (err) => {
    console.error("NAS download error:", err);
    if (!res.headersSent) res.status(502).json({ error: "NAS unavailable" });
  });
}

// Download (or stream for play) a music file from NAS by song id
app.get("/api/music/download", async (req, res) => {
  console.log("[download] request received, id:", req.query.id, "disposition:", req.query.disposition);
  try {
    const id = req.query.id;
    const disposition = req.query.disposition === "inline" ? "inline" : "attachment";
    if (!id) {
      return res.status(400).json({ error: "Missing id" });
    }
    let doc;
    try {
      doc = await tracksColl.findOne({ _id: new ObjectId(id) });
    } catch {
      doc = await tracksColl.findOne({ _id: id });
    }
    if (!doc || !doc.path) {
      return res.status(404).json({ error: "Song not found or no path" });
    }
    const sid = await nasAuth();
    const filename = doc.fileName || doc.path.split("/").pop() || "audio";
    // Synology File Station often expects path as JSON array, e.g. ["/Music/Pop/file.mp3"]
    const pathParam = encodeURIComponent(JSON.stringify([doc.path]));
    const downloadUrl = `http://${NAS_HOST}:${NAS_PORT}/webapi/entry.cgi?api=SYNO.FileStation.Download&version=2&method=download&path=${pathParam}&_sid=${sid}`;
    const allowOrigin = req.headers.origin || "*";
    const rangeHeader = req.headers.range || null;
    pipeNasDownload(downloadUrl, res, filename, disposition, allowOrigin, rangeHeader);
  } catch (err) {
    console.error("Download error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 404 handler – log so we know when no route matched
app.use((req, res) => {
  console.warn("[404] No route for", req.method, req.url);
  res.status(404).json({ error: "Not found", path: req.url });
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down server...");
  if (db && db.client) {
    await db.client.close();
    console.log("MongoDB connection closed");
  }
  process.exit(0);
});

// Start server
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`API server running on http://localhost:${PORT}`);
    console.log("Routes include: /api/music, /api/music/search, /api/music/download");
  });
});
