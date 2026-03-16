/**
 * Inspect an album's cover art URLs and check if they resolve.
 * Usage: node scripts/inspect-album-cover.cjs <albumId>
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { MongoClient, ObjectId } = require("mongodb");
const https = require("https");
const http = require("http");

const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || "integration-factor";
const ALBUMS_COLLECTION = process.env.ALBUMS_COLLECTION || "albums";

function checkUrl(url) {
  return new Promise((resolve) => {
    if (!url || typeof url !== "string") {
      resolve({ status: null, error: "no url" });
      return;
    }
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers: { "User-Agent": "IntegrationFactorMusicApp/1.0" } }, (res) => {
      resolve({ status: res.statusCode, redirect: res.headers.location });
    });
    req.on("error", (err) => resolve({ status: null, error: err.message }));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve({ status: null, error: "timeout" });
    });
  });
}

async function main() {
  const albumId = process.argv[2];
  if (!albumId) {
    console.error("Usage: node scripts/inspect-album-cover.cjs <albumId>");
    process.exit(1);
  }
  if (!MONGODB_URI) {
    console.error("MONGODB_URI not set");
    process.exit(1);
  }
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DATABASE_NAME);
    const coll = db.collection(ALBUMS_COLLECTION);
    let doc = null;
    if (ObjectId.isValid(albumId) && String(new ObjectId(albumId)) === albumId) {
      doc = await coll.findOne({ _id: new ObjectId(albumId) });
    }
    if (!doc) {
      doc = await coll.findOne({ $or: [ { mbReleaseId: albumId }, { albumId } ] });
    }
    if (!doc) {
      console.error("Album not found:", albumId);
      process.exit(1);
    }
    console.log("Album:", doc.artist, "–", doc.album);
    console.log("_id:", doc._id);
    console.log("mbReleaseId:", doc.mbReleaseId || "(none)");
    console.log("mbMatchMethod:", doc.mbMatchMethod || "(none)");
    console.log("");
    const small = doc.coverArtSmall;
    const large = doc.coverArtLarge || small;
    const firstUrl = small || large;
    console.log("coverArtSmall:", small || "(none)");
    console.log("coverArtLarge:", doc.coverArtLarge || "(none)");
    console.log("coverArtworkExtra count:", (doc.coverArtworkExtra || []).length);
    if (doc.coverArtworkExtra?.length) {
      doc.coverArtworkExtra.forEach((e, i) => {
        console.log("  extra[" + i + "].small:", e.small);
        console.log("  extra[" + i + "].large:", e.large);
      });
    }
    if (!firstUrl) {
      console.log("\nNo cover art URLs stored.");
      return;
    }
    const host = (() => {
      try {
        return new URL(firstUrl).hostname.toLowerCase();
      } catch {
        return "";
      }
    })();
    const useProxy = host === "coverartarchive.org" || host === "archive.org" || host.endsWith(".archive.org");
    console.log("\nFirst cover URL host:", host);
    console.log("Frontend would use cover-proxy for this host:", useProxy);
    console.log("\nChecking URL reachability (direct GET)...");
    const resultSmall = small ? await checkUrl(small) : { status: null, error: "no small" };
    const resultLarge = large && large !== small ? await checkUrl(large) : resultSmall;
    console.log("coverArtSmall GET:", resultSmall.status ?? resultSmall.error);
    if (resultSmall.redirect) console.log("  redirect:", resultSmall.redirect);
    if (large && large !== small) {
      console.log("coverArtLarge GET:", resultLarge.status ?? resultLarge.error);
      if (resultLarge.redirect) console.log("  redirect:", resultLarge.redirect);
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
