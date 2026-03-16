/**
 * Test enrichment script: call MusicBrainz, Discogs, TheAudioDB for sample
 * artist/album; capture response shapes; validate artwork URLs; report.
 * Usage: node scripts/test-enrichment-and-artwork.cjs
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const https = require("https");
const http = require("http");

const THEAUDIODB_API_KEY = process.env.THEAUDIODB_API_KEY || process.env.VITE_THEAUDIODB_API_KEY;
const DISCOGS_KEY = process.env.DISCOGS_CONSUMER_KEY || "tZjfkLGDJNkrBqFSGvMq";
const DISCOGS_SECRET = process.env.DISCOGS_CONSUMER_SECRET || "igonnBnRkSmcXhNnnUAemJPxnywuIEOC";
const USER_AGENT = "IntegrationFactorMusicApp/1.0 (contact@integrationfactor.com)";

const SAMPLES = [
  { artist: "Pink Floyd", album: "The Wall" },
  { artist: "Daft Punk", album: "Random Access Memories" },
  { artist: "Unknown Artist", album: "Some Obscure Album 1999" },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpsGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...opts.headers },
      ...opts,
    };
    https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, opts).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ statusCode: res.statusCode, data });
        }
      });
    }).on("error", reject);
  });
}

function httpHead(url) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const req = lib.request(
      url,
      { method: "HEAD", timeout: 8000 },
      (res) => {
        resolve({
          statusCode: res.statusCode,
          location: res.headers.location,
          contentType: res.headers["content-type"],
        });
      }
    );
    req.on("error", (err) => resolve({ error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ error: "timeout" });
    });
    req.end();
  });
}

async function checkArtworkUrl(label, url) {
  if (!url) return { label, url: null, status: "no-url" };
  const result = await httpHead(url);
  if (result.error) return { label, url, status: "error", detail: result.error };
  if (result.statusCode === 200)
    return { label, url, status: "ok", statusCode: 200, contentType: result.contentType };
  if (result.statusCode === 301 || result.statusCode === 302)
    return { label, url, status: "redirect", statusCode: result.statusCode, location: result.location };
  return { label, url, status: "fail", statusCode: result.statusCode };
}

async function testMusicBrainz(artist, album) {
  const q = `${artist} ${album}`.replace(/[^a-z0-9\s]/gi, " ").replace(/\s+/g, " ").trim();
  const url = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(q)}&fmt=json&limit=5`;
  const res = await httpsGet(url);
  const releases = res.data?.releases || [];
  const first = releases[0] || null;
  const summary = {
    api: "MusicBrainz",
    statusCode: res.statusCode,
    resultCount: releases.length,
    firstRelease: first
      ? {
          id: first.id,
          title: first.title,
          "artist-credit": first["artist-credit"]?.map((a) => a.artist?.name).filter(Boolean),
          date: first.date,
        }
      : null,
    artworkUrl: first?.id
      ? `https://coverartarchive.org/release/${first.id}/front-500`
      : null,
  };
  return summary;
}

async function testDiscogs(artist, album) {
  const url = `https://api.discogs.com/database/search?type=release&artist=${encodeURIComponent(artist)}&release_title=${encodeURIComponent(album)}`;
  const res = await httpsGet(url, {
    headers: { Authorization: `Discogs key=${DISCOGS_KEY}, secret=${DISCOGS_SECRET}` },
  });
  const results = res.data?.results || [];
  const first = results[0] || null;
  const summary = {
    api: "Discogs",
    statusCode: res.statusCode,
    resultCount: results.length,
    firstResult: first
      ? {
          id: first.id,
          title: first.title,
          year: first.year,
          cover_image: first.cover_image ? "(present)" : "(missing)",
        }
      : null,
    artworkUrl: first?.cover_image || null,
  };
  return summary;
}

async function testTheAudioDB(artist, album) {
  if (!THEAUDIODB_API_KEY) return { api: "TheAudioDB", status: "no-api-key" };
  const url = `https://theaudiodb.com/api/v1/json/${THEAUDIODB_API_KEY}/searchalbum.php?s=${encodeURIComponent(artist)}&a=${encodeURIComponent(album)}`;
  const res = await httpsGet(url);
  const albums = res.data?.album || [];
  const first = albums[0] || null;
  const summary = {
    api: "TheAudioDB",
    statusCode: res.statusCode,
    resultCount: Array.isArray(albums) ? albums.length : 0,
    firstAlbum: first
      ? {
          idAlbum: first.idAlbum,
          strAlbum: first.strAlbum,
          strArtist: first.strArtist,
          strAlbumThumb: first.strAlbumThumb ? "(present)" : "(missing)",
        }
      : null,
    artworkUrl: first?.strAlbumThumb || first?.strArtistWideThumb || null,
  };
  return summary;
}

async function main() {
  const report = { samples: [], artworkValidation: [], algorithmNotes: [] };

  console.log("=== Enrichment script test: 3 APIs + artwork validation ===\n");

  for (const { artist, album } of SAMPLES) {
    console.log(`\n--- Sample: ${artist} / ${album} ---`);
    const sampleReport = { artist, album, musicbrainz: null, discogs: null, theaudiodb: null };

    await sleep(500);
    const mb = await testMusicBrainz(artist, album);
    sampleReport.musicbrainz = mb;
    console.log("MusicBrainz:", JSON.stringify(mb, null, 2).slice(0, 500) + "...");

    await sleep(500);
    const d = await testDiscogs(artist, album);
    sampleReport.discogs = d;
    console.log("Discogs:", JSON.stringify(d, null, 2).slice(0, 500) + "...");

    await sleep(500);
    const t = await testTheAudioDB(artist, album);
    sampleReport.theaudiodb = t;
    console.log("TheAudioDB:", JSON.stringify(t, null, 2).slice(0, 400) + "...");

    report.samples.push(sampleReport);
  }

  console.log("\n=== Validating artwork URLs (HEAD requests) ===\n");
  const urlsToCheck = [];
  for (const s of report.samples) {
    if (s.musicbrainz?.artworkUrl) urlsToCheck.push({ label: "Cover Art Archive (MB)", url: s.musicbrainz.artworkUrl });
    if (s.discogs?.artworkUrl) urlsToCheck.push({ label: "Discogs cover_image", url: s.discogs.artworkUrl });
    if (s.theaudiodb?.artworkUrl) urlsToCheck.push({ label: "TheAudioDB strAlbumThumb", url: s.theaudiodb.artworkUrl });
  }
  for (const { label, url } of urlsToCheck) {
    const result = await checkArtworkUrl(label, url);
    report.artworkValidation.push(result);
    console.log(`${label}: ${result.status} ${result.statusCode || ""} ${result.url || ""}`);
    await sleep(200);
  }

  const reportPath = path.join(__dirname, "enrichment-test-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log("\nFull report written to:", reportPath);
}

const fs = require("fs");
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
