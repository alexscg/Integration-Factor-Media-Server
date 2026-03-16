const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");

// Load .env from project root (same as server/api.cjs)
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

// Configuration from environment
const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || "integration-factor";
const TRACKS_COLLECTION = process.env.TRACKS_COLLECTION || process.env.COLLECTION_NAME || "tracks";
const ALBUMS_COLLECTION = process.env.ALBUMS_COLLECTION || "albums";

const MUSIC_EXTENSIONS = [".mp3", ".wav", ".flac", ".aac", ".ogg", ".wma", ".m4a"];
const SCAN_PATHS = [
  "Z:\\Classical",
  "Z:\\EDM",
  "Z:\\Opera and Classical",
  "Z:\\Other",
  "Z:\\Pop",
  "Z:\\Rock",
  "Z:\\Russian",
  "Z:\\Spanish",
  "Z:\\Trance"
];

function extractMusicInfo(filePath) {
  const fileName = path.basename(filePath, path.extname(filePath));
  const dirPath = path.dirname(filePath);
  const pathParts = dirPath.split(path.sep);
  
  let artist = "Unknown Artist";
  let genre = "";
  let album = "";
  
  // Find genre (first folder after Z:\)
  const zIndex = pathParts.indexOf("Z:");
  if (zIndex !== -1 && pathParts.length > zIndex + 1) {
    genre = pathParts[zIndex + 1];
    
    // Artist is typically the next folder after genre
    if (pathParts.length > zIndex + 2) {
      artist = pathParts[zIndex + 2];
    }
    
    // Album is typically the folder containing the file
    if (pathParts.length > zIndex + 3) {
      album = pathParts[pathParts.length - 1];
    }
  }
  
  // Clean up song name
  let songName = fileName
    .replace(/^\d{1,3}[\s\-_.]+/, "")
    .replace(/^Track\s*\d+[\s\-_.]+/i, "")
    .trim();
  
  if (songName.toLowerCase() === "cdimage" || songName.toLowerCase() === "track") {
    songName = album || artist;
  }
  
  // Multi-disc: strip " (CD 1)", " (Disc 2)" etc. for grouping; keep full album for display
  let albumBase = album;
  let discNumber = 1;
  const discMatch = album.match(/\s*[\(\-\s]*(?:CD|Disc)\s*(\d+)\s*\)?\s*$/i) || album.match(/\s+CD\s*(\d+)\s*$/i);
  if (discMatch) {
    discNumber = parseInt(discMatch[1], 10) || 1;
    albumBase = album.replace(/\s*[\(\-\s]*(?:CD|Disc)\s*\d+\s*\)?\s*$/i, "").replace(/\s+CD\s*\d+\s*$/i, "").trim();
  }
  
  return {
    name: songName,
    artist: artist,
    year: "",
    genre: genre,
    album: album,
    albumBase: albumBase || album,
    discNumber,
    path: filePath,
    fileName: path.basename(filePath)
  };
}

function scanDirectory(dir, files = []) {
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      
      if (item.isDirectory()) {
        scanDirectory(fullPath, files);
      } else if (item.isFile()) {
        const ext = path.extname(item.name).toLowerCase();
        if (MUSIC_EXTENSIONS.includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  } catch (err) {
    console.error(`Error scanning ${dir}:`, err.message);
  }
  
  return files;
}

async function uploadToMongoDB(musicData) {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    console.log("Connecting to MongoDB...");
    await client.connect();
    console.log("Connected successfully!");
    
    const db = client.db(DATABASE_NAME);
    const tracksColl = db.collection(TRACKS_COLLECTION);
    const albumsColl = db.collection(ALBUMS_COLLECTION);
    
    console.log("Clearing existing tracks...");
    await tracksColl.deleteMany({});
    
    const batchSize = 1000;
    let inserted = 0;
    for (let i = 0; i < musicData.length; i += batchSize) {
      const batch = musicData.slice(i, i + batchSize);
      await tracksColl.insertMany(batch);
      inserted += batch.length;
      console.log(`Inserted ${inserted}/${musicData.length} tracks...`);
    }
    console.log(`\nUploaded ${musicData.length} tracks. Rebuilding albums...`);
    
    const { ObjectId } = require("mongodb");
    const pipeline = [
      { $addFields: { albumBase: { $ifNull: ["$albumBase", "$album"] }, discNum: { $ifNull: ["$discNumber", 1] } } },
      { $group: { _id: { artist: "$artist", album: "$albumBase" }, tracks: { $push: { _id: "$_id", discNum: "$discNum", name: "$name" } }, doc: { $first: "$$ROOT" } } }
    ];
    const groupsRaw = await tracksColl.aggregate(pipeline).toArray();
    const groups = groupsRaw.map((g) => {
      g.tracks.sort((a, b) => (a.discNum !== b.discNum ? a.discNum - b.discNum : (a.name || "").localeCompare(b.name || "")));
      return { _id: g._id, trackIds: g.tracks.map((t) => t._id), doc: g.doc };
    });
    await albumsColl.deleteMany({});
    for (const g of groups) {
      const first = g.doc;
      const albumMeta = {
        artist: g._id.artist,
        album: g._id.album,
        genre: first.genre,
        year: first.year,
        releaseYear: first.releaseYear,
        coverArtSmall: first.coverArtSmall,
        coverArtLarge: first.coverArtLarge,
        coverArtworkExtra: first.coverArtworkExtra,
        mbReleaseId: first.mbReleaseId,
        confidenceScore: first.confidenceScore,
        mbMatchMethod: first.mbMatchMethod,
        trackIds: g.trackIds
      };
      const albumDoc = await albumsColl.findOneAndUpdate(
        { artist: g._id.artist, album: g._id.album },
        { $set: albumMeta },
        { upsert: true, returnDocument: "after" }
      );
      await tracksColl.updateMany({ _id: { $in: g.trackIds } }, { $set: { albumId: albumDoc._id } });
    }
    console.log(`  Updated ${groups.length} albums.`);
    
    console.log("Creating indexes...");
    await tracksColl.createIndex({ name: "text", artist: "text", album: "text" }).catch(() => {});
    await tracksColl.createIndex({ genre: 1 }).catch(() => {});
    await tracksColl.createIndex({ artist: 1 }).catch(() => {});
    await tracksColl.createIndex({ albumId: 1 }).catch(() => {});
    await albumsColl.createIndex({ artist: 1, album: 1 }).catch(() => {});
    console.log("Done!");
    
  } catch (err) {
    console.error("MongoDB Error:", err);
  } finally {
    await client.close();
  }
}

async function main() {
  if (!MONGODB_URI) {
    console.error("Error: MONGODB_URI is not set. Add it to a .env file in the project root.");
    process.exit(1);
  }
  console.log("Scanning Z drive for music files...");
  console.log("Folders to scan:", SCAN_PATHS.join(", "));
  
  let allFiles = [];
  
  for (const scanPath of SCAN_PATHS) {
    if (fs.existsSync(scanPath)) {
      console.log(`\nScanning ${scanPath}...`);
      const files = scanDirectory(scanPath);
      console.log(`Found ${files.length} music files in ${scanPath}`);
      allFiles = allFiles.concat(files);
    } else {
      console.log(`Skipping ${scanPath} - path does not exist`);
    }
  }
  
  console.log(`\nTotal music files found: ${allFiles.length}`);
  
  if (allFiles.length === 0) {
    console.log("No music files found. Exiting.");
    return;
  }
  
  console.log("\nExtracting music information...");
  const musicData = allFiles.map((file, index) => {
    if (index % 5000 === 0) {
      console.log(`Processing ${index}/${allFiles.length}...`);
    }
    return extractMusicInfo(file);
  });
  
  console.log(`\nPrepared ${musicData.length} music entries for upload.`);
  
  await uploadToMongoDB(musicData);
}

main().catch(console.error);
