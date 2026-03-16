/**
 * One-time migration: renames "music" → "tracks", creates "albums" collection.
 * - Builds album docs from current music (group by artist+album) with metadata + trackIds.
 * - Copies music docs to tracks with albumId set; then drops music.
 * Run with: node scripts/migrate-music-to-tracks-and-albums.cjs
 * Requires MONGODB_URI, DATABASE_NAME. Uses COLLECTION_NAME for source (default "music").
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { MongoClient, ObjectId } = require("mongodb");

const DATABASE_NAME = process.env.DATABASE_NAME || "integration-factor";
const SOURCE_COLLECTION = process.env.COLLECTION_NAME || "music";
const TRACKS_COLLECTION = "tracks";
const ALBUMS_COLLECTION = "albums";

// Album metadata fields to take from first track of each group (same as current track metadata for album-level stuff)
const ALBUM_META_FIELDS = [
  "artist", "album", "genre", "year", "releaseYear",
  "coverArtSmall", "coverArtLarge", "coverArtworkExtra",
  "mbReleaseId", "albumId", "confidenceScore", "mbMatchMethod",
  "label", "catalogNumber", "audioLanguage"
];

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is required.");
    process.exit(1);
  }
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(DATABASE_NAME);
    const music = db.collection(SOURCE_COLLECTION);
    const tracksColl = db.collection(TRACKS_COLLECTION);
    const albumsColl = db.collection(ALBUMS_COLLECTION);

    const count = await music.countDocuments();
    if (count === 0) {
      console.log("No documents in '%s'. Nothing to migrate.", SOURCE_COLLECTION);
      return;
    }

    console.log("Step 1: Building album documents from %s (group by artist+album)...", SOURCE_COLLECTION);
    const groups = await music.aggregate([
      { $group: { _id: { artist: "$artist", album: "$album" }, trackIds: { $push: "$_id" }, doc: { $first: "$$ROOT" } } }
    ]).toArray();

    const albumDocs = [];
    const trackIdToAlbumId = new Map(); // track _id (object) -> album _id

    for (const g of groups) {
      const albumId = new ObjectId();
      const first = g.doc;
      const meta = {};
      for (const key of ALBUM_META_FIELDS) {
        if (first[key] !== undefined && first[key] !== null) meta[key] = first[key];
      }
      albumDocs.push({
        _id: albumId,
        artist: g._id.artist,
        album: g._id.album,
        ...meta,
        trackIds: g.trackIds
      });
      for (const tid of g.trackIds) {
        trackIdToAlbumId.set(tid.toString(), albumId);
      }
    }

    console.log("Step 2: Inserting %d albums into '%s'...", albumDocs.length, ALBUMS_COLLECTION);
    await albumsColl.deleteMany({});
    if (albumDocs.length > 0) {
      await albumsColl.insertMany(albumDocs);
    }

    console.log("Step 3: Copying tracks to '%s' with albumId...", TRACKS_COLLECTION);
    await tracksColl.deleteMany({});
    const cursor = music.find({});
    let inserted = 0;
    const batchSize = 500;
    let batch = [];
    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      const albumId = trackIdToAlbumId.get(doc._id.toString());
      const { _id, ...rest } = doc;
      batch.push({ _id, ...rest, albumId });
      if (batch.length >= batchSize) {
        await tracksColl.insertMany(batch);
        inserted += batch.length;
        console.log("  Inserted %d tracks...", inserted);
        batch = [];
      }
    }
    if (batch.length > 0) {
      await tracksColl.insertMany(batch);
      inserted += batch.length;
    }
    console.log("  Total tracks inserted: %d", inserted);

    console.log("Step 4: Creating indexes on tracks...");
    await tracksColl.createIndex({ albumId: 1 }).catch(() => {});
    await tracksColl.createIndex({ name: "text", artist: "text", album: "text" }).catch(() => {});
    await tracksColl.createIndex({ genre: 1 }).catch(() => {});
    await tracksColl.createIndex({ artist: 1 }).catch(() => {});
    await tracksColl.createIndex({ album: 1 }).catch(() => {});

    console.log("Step 5: Creating indexes on albums...");
    await albumsColl.createIndex({ artist: 1, album: 1 }).catch(() => {});
    await albumsColl.createIndex({ genre: 1 }).catch(() => {});

    console.log("Step 6: Dropping old collection '%s'...", SOURCE_COLLECTION);
    await db.dropCollection(SOURCE_COLLECTION).catch((e) => {
      console.warn("Drop failed (maybe already dropped):", e.message);
    });

    console.log("Migration complete. Use TRACKS_COLLECTION='tracks' and ALBUMS_COLLECTION='albums' (or default in code).");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
