const { MongoClient } = require("mongodb");
const https = require("https");
const http = require("http");
const fs = require("fs");

require("dotenv").config();

// Configuration
const NAS_HOST = process.env.NAS_HOST;
const NAS_PORT = process.env.NAS_PORT;
const NAS_USER = process.env.NAS_USER;
const NAS_PASS = process.env.NAS_PASS;

const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME;
const TRACKS_COLLECTION = process.env.TRACKS_COLLECTION || process.env.COLLECTION_NAME || "tracks";
const ALBUMS_COLLECTION = process.env.ALBUMS_COLLECTION || "albums";

const PROGRESS_FILE = "./scripts/nas-sync-progress.json";
const MUSIC_EXTENSIONS = [".mp3", ".flac", ".m4a", ".wav", ".ogg", ".wma", ".aac"];

// Optional: sync only a specific folder under /Music. Pass folder name as first argument (in quotes).
// Examples:  node nas-sync.cjs "Rock"   OR   node nas-sync.cjs "Rock/Heavy Metal Music From The Motion Picture (1981) [FLAC]"
// With --replace-scope: when a folder is specified, remove from DB any track whose path is NOT under that folder (DB then contains only that subtree).
const ARGV = process.argv.slice(2);
const FOLDER_ARG = (() => {
  const a = ARGV.find((x) => x && !x.startsWith("--"));
  return a ? String(a).trim().replace(/^\/+|\/+$/g, "") : null;
})();
const REPLACE_SCOPE = ARGV.includes("--replace-scope");

const CLASSICAL_ARTISTS = (() => {
  try {
    const path = require("path");
    return require(path.join(__dirname, "classical-artists.json"));
  } catch {
    return { shortToFull: {}, full: [] };
  }
})();

const KNOWN_ARTIST_NAMES_SORTED = (() => {
  const list = [];
  const stf = CLASSICAL_ARTISTS.shortToFull || {};
  for (const v of Object.values(stf)) list.push(String(v).trim());
  const full = CLASSICAL_ARTISTS.full || [];
  for (const f of full) list.push(String(f).trim());
  return [...new Set(list)].sort((a, b) => b.length - a.length);
})();

function normalizeArtistForSplit(s) {
  return s
    .replace(/\s+/g, " ")
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .trim();
}

function splitArtistSuffix(artist) {
  if (!artist || typeof artist !== "string") return null;
  const normalized = normalizeArtistForSplit(artist);
  const lower = normalized.toLowerCase();
  for (const known of KNOWN_ARTIST_NAMES_SORTED) {
    if (normalized === known) return null;
    const prefixLiteral = known + " - ";
    const prefixLower = prefixLiteral.toLowerCase();
    if (lower.startsWith(prefixLower)) {
      const suffix = normalized.slice(prefixLiteral.length).trim();
      if (suffix) return { artist: known, suffix };
    }
  }
  return null;
}

let sessionId = null;

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const url = `http://${NAS_HOST}:${NAS_PORT}${path}`;
    
    http.get(url, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        const trimmed = (data || "").trim();
        if (trimmed.startsWith("<") && (trimmed.startsWith("<!") || trimmed.toLowerCase().startsWith("<html"))) {
          reject(new Error(`NAS returned an HTML page (e.g. 404) instead of JSON. Status: ${res.statusCode}. Check API URL and path.`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data.slice(0, 200)}${data.length > 200 ? "..." : ""}`));
        }
      });
    }).on("error", reject);
  });
}

async function authenticate() {
  console.log("Authenticating with NAS...");
  const path = `/webapi/entry.cgi?api=SYNO.API.Auth&version=7&method=login&account=${NAS_USER}&passwd=${encodeURIComponent(NAS_PASS)}&session=FileStation&format=sid`;
  
  const result = await httpGet(path);
  if (!result.success) {
    throw new Error(`Authentication failed: ${JSON.stringify(result.error)}`);
  }
  
  sessionId = result.data.sid;
  console.log("Authenticated successfully");
  return sessionId;
}

async function logout() {
  if (sessionId) {
    const path = `/webapi/entry.cgi?api=SYNO.API.Auth&version=7&method=logout&session=FileStation&_sid=${sessionId}`;
    await httpGet(path);
    console.log("Logged out from NAS");
  }
}

async function listFolder(folderPath, offset = 0, limit = 1000) {
  const encodedPath = encodeURIComponent(folderPath);
  const path = `/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list&folder_path=${encodedPath}&offset=${offset}&limit=${limit}&additional=size,type&_sid=${sessionId}`;

  const result = await httpGet(path);
  if (!result.success) {
    console.error(`Failed to list ${folderPath}: ${JSON.stringify(result.error)}`);
    return { files: [], total: 0 };
  }

  return result.data;
}

// Parse 4-digit year (19xx/20xx) from folder name and return clean album title. Handles:
// "ARTIST - YYYY - Album", "YYYY - Album", "ARTIST - (YYYY) - Album", "ARTIST - Album (YYYY)", "Album - YYYY", etc.
function parseYearAndAlbum(folderStr) {
  if (!folderStr || typeof folderStr !== "string") return { year: "", album: folderStr || "" };
  const s = folderStr.trim();
  let year = "";
  let album = s;

  // Year at end in parentheses: "Album (1981)" or "Artist - Album (1981)"
  let m = s.match(/\s*\(((19|20)\d{2})\)\s*$/);
  if (m) {
    year = m[1];
    album = s.substring(0, s.length - m[0].length).trim();
    return { year, album };
  }
  // Year in middle with " - " around it: "X - 1981 - Y" or "X - (1981) - Y" -> album = Y
  m = s.match(/\s+-\s+\(?((19|20)\d{2})\)?\s+-\s+(.+)$/);
  if (m) {
    year = m[1];
    album = m[3].trim();
    return { year, album };
  }
  // Year at start: "1981 - Album"
  m = s.match(/^((19|20)\d{2})\s+-\s+(.+)$/);
  if (m) {
    year = m[1];
    album = m[3].trim();
    return { year, album };
  }
  // Year at end after " - ": "Album - 1981"
  m = s.match(/^(.+?)\s+-\s+((19|20)\d{2})\s*$/);
  if (m) {
    year = m[2];
    album = m[1].trim();
    return { year, album };
  }
  // Single (YYYY) anywhere: remove it and use as year
  m = s.match(/\(((19|20)\d{2})\)/);
  if (m) {
    year = m[1];
    album = s.replace(/\s*\(((19|20)\d{2})\)\s*/, " ").replace(/\s+/g, " ").trim();
    return { year, album };
  }
  return { year: "", album: s };
}

function parseMetadataFromPath(filePath, fileName) {
  // Normalize backslashes (e.g. \Classical\Artist\Album)
  const normalizedPath = filePath.replace(/\\/g, "/");
  // Examples:
  // /Music/Classical/Ludwig van Beethoven/Complete Beethoven Edition Vol. 1 - Symphonies/file.mp3  (Genre/Artist/Album)
  // /Rock/Accept - Discography/ACCEPT - 1981 - Breaker or 1981 - Breaker or Album (1981) etc.
  const partList = normalizedPath.split("/");

  let genre = "";
  let artist = "Unknown Artist";
  let album = "";
  let year = "";
  let discNumber = 1;
  let name = fileName.replace(/\.[^.]+$/, ""); // Remove extension

  const hasMusicRoot = partList.length > 1 && partList[1] === "Music";
  const genreIndex = hasMusicRoot ? 2 : 1;
  const artistAlbumFolderIndex = hasMusicRoot ? 3 : 2;
  // Three-folder layout: .../Genre/Artist/Album/file -> need 6 parts with Music, 5 without
  const minPartsForThreeFolders = hasMusicRoot ? 6 : 5;

  function isDiscSubfolder(name) {
    if (!name || typeof name !== "string") return false;
    const t = name.trim();
    return /^(CD|Disc)\s*\d+$/i.test(t) || /^CD\s*\d+$/i.test(t);
  }

  // Genre/AlbumFolder/DiscSubfolder (e.g. Rock/Heavy Metal... (1981) [FLAC]/CD 1/file) -> one album, disc from subfolder
  if (partList.length >= minPartsForThreeFolders) {
    const subFolder = partList[artistAlbumFolderIndex + 1] || "";
    const normalizeFolder = (s) => (s || "").replace(/\s+/g, " ").replace(/[\u2013\u2014\u2212]/g, "-").trim();
    if (isDiscSubfolder(subFolder)) {
      genre = partList[genreIndex] || "";
      artist = "Unknown Artist";
      const albumFolder = normalizeFolder(partList[artistAlbumFolderIndex]);
      const parsed = parseYearAndAlbum(albumFolder);
      year = parsed.year;
      album = parsed.album;
      const discNumMatch = subFolder.match(/\d+/);
      discNumber = discNumMatch ? parseInt(discNumMatch[0], 10) : 1;
    } else {
      genre = partList[genreIndex] || "";
      artist = normalizeFolder(partList[artistAlbumFolderIndex] || "Unknown Artist")
        .replace(/\s*-\s*Discography\s*$/i, "")
        .trim();
      const albumFolder = normalizeFolder(partList[artistAlbumFolderIndex + 1]);
      const parsed = parseYearAndAlbum(albumFolder);
      year = parsed.year;
      album = parsed.album;
    }
  }
  // Genre/Artist - Album (two folders: Genre, "Artist - Album" folder)
  else if (partList.length >= 4) {
    genre = partList[genreIndex] || "";
    const rawFolder = partList[artistAlbumFolderIndex] || "";
    const albumFolder = rawFolder.replace(/\s+/g, " ").replace(/[\u2013\u2014\u2212]/g, "-").trim();
    const delimiterIndex = albumFolder.indexOf(" - ");
    if (delimiterIndex > 0) {
      artist = albumFolder.substring(0, delimiterIndex).trim();
      const after = albumFolder.substring(delimiterIndex + 3).trim();
      const parsed = parseYearAndAlbum(after);
      year = parsed.year;
      album = parsed.album;
    } else {
      const parsed = parseYearAndAlbum(albumFolder);
      year = parsed.year;
      album = parsed.album;
    }
  }

  const artistSplit = splitArtistSuffix(artist);
  if (artistSplit) {
    artist = artistSplit.artist;
    album = artistSplit.suffix + (album ? ` - ${album}` : "");
  }

  // Clean up the song name - remove track numbers and artist prefixes
  name = name
    .replace(/^\d+[-_.\s]+/, "")  // Remove leading track numbers
    .replace(/^[a-z0-9]+[-_]/, "")  // Remove scene prefixes like "101-"
    .replace(/_/g, " ")  // Replace underscores with spaces
    .replace(/\s+/g, " ")  // Normalize spaces
    .trim();
  
  // If song name contains "artist - song" (with spaces around dash), extract it
  const songArtistMatch = name.match(/^(.+?)\s+-\s+(.+)$/);
  if (songArtistMatch && songArtistMatch[1].toLowerCase() !== artist.toLowerCase()) {
    // Keep the full name but use parsed artist if album artist is unknown
    if (artist === "Unknown Artist") {
      artist = songArtistMatch[1].trim();
    }
    name = songArtistMatch[2].trim();
  }
  
  // Multi-disc: strip " (CD 1)", " (Disc 2)", " CD1" etc. for grouping; keep full album for display
  let albumBase = album;
  const discMatch = album.match(/\s*[\(\-\s]*(?:CD|Disc)\s*(\d+)\s*\)?\s*$/i) || album.match(/\s+CD\s*(\d+)\s*$/i);
  if (discMatch) {
    discNumber = parseInt(discMatch[1], 10) || 1;
    albumBase = album.replace(/\s*[\(\-\s]*(?:CD|Disc)\s*\d+\s*\)?\s*$/i, "").replace(/\s+CD\s*\d+\s*$/i, "").trim();
  }
  // Normalize albumBase for grouping: strip trailing " [FLAC]", " {with ...}" etc. so folder name variants become one album
  albumBase = (albumBase || album)
    .replace(/\s*\[\s*FLAC\s*\]\s*$/i, "")
    .replace(/\s*\{\s*[^}]*\}\s*$/, "")
    .replace(/\s+$/, "")
    .trim() || albumBase || album;

  // Relative path from Music root (e.g. "Classical/Artist/Album/song.mp3" or "Pop/Artist - Album/song.mp3")
  const relativePath = normalizedPath.replace(/^\/Music\/?/, "").replace(/^\//, "") || fileName;

  // Directory containing this file (normalized). Used to group tracks into one album per folder when artist/album parse varies.
  const directoryPath = partList.length > 1 ? partList.slice(0, -1).join("/") : normalizedPath;

  return {
    name: name || fileName,
    artist,
    album,
    albumBase: albumBase || album,
    discNumber,
    genre,
    year,
    path: filePath,
    relativePath,
    directoryPath,
    fileName
  };
}

function isMusicFile(fileName) {
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf("."));
  return MUSIC_EXTENSIONS.includes(ext);
}

async function scanFolder(folderPath, stats) {
  const songs = [];
  let offset = 0;
  const limit = 500;
  
  while (true) {
    const data = await listFolder(folderPath, offset, limit);
    
    for (const item of data.files) {
      if (item.isdir) {
        // Skip recycle bins
        if (item.name.startsWith("#") || item.name.startsWith("@")) continue;
        
        // Recursively scan subdirectories
        const subSongs = await scanFolder(item.path, stats);
        songs.push(...subSongs);
      } else {
        if (isMusicFile(item.name)) {
          const metadata = parseMetadataFromPath(item.path, item.name);
          metadata.fileSize = item.additional?.size || 0;
          songs.push(metadata);
          stats.scanned++;
          
          if (stats.scanned % 500 === 0) {
            console.log(`  Scanned ${stats.scanned} files...`);
          }
        }
      }
    }
    
    if (offset + data.files.length >= data.total) break;
    offset += limit;
  }
  
  return songs;
}

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    }
  } catch (e) {}
  return { status: "idle", scanned: 0, synced: 0, total: 0, lastTotal: 0, startTime: null, endTime: null };
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

async function main() {
  const previous = loadProgress();
  const progress = {
    status: "running",
    scanned: 0,
    synced: 0,
    total: 0,
    lastTotal: previous.total > 0 ? previous.total : 0,
    startTime: new Date().toISOString(),
    endTime: null,
    error: null
  };

  saveProgress(progress);
  
  let client;
  
  try {
    // Authenticate with NAS
    await authenticate();
    
    // Connect to MongoDB
    console.log("Connecting to MongoDB...");
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DATABASE_NAME);
    const tracksColl = db.collection(TRACKS_COLLECTION);
    const albumsColl = db.collection(ALBUMS_COLLECTION);
    
    const existingCount = await tracksColl.countDocuments();
    console.log(`Existing tracks in database: ${existingCount}`);
    
    // Scan music folders (optionally only the folder passed as first argument, e.g. "Rock" or "Rock/Heavy Metal...")
    const stats = { scanned: 0 };
    const allSongs = [];

    if (FOLDER_ARG) {
      const startPath = "/Music/" + FOLDER_ARG;
      console.log(`Scanning NAS folder only: ${startPath}`);
      const songs = await scanFolder(startPath, stats);
      allSongs.push(...songs);
      progress.scanned = stats.scanned;
      saveProgress(progress);
    } else {
      console.log("Scanning NAS music folders...");
      const musicRoot = await listFolder("/Music");
      for (const folder of musicRoot.files) {
        if (!folder.isdir || folder.name.startsWith("#") || folder.name.startsWith("@")) continue;
        console.log(`Scanning genre folder: ${folder.name}`);
        const songs = await scanFolder(folder.path, stats);
        allSongs.push(...songs);
        progress.scanned = stats.scanned;
        saveProgress(progress);
      }
    }

    console.log(`\nTotal files scanned: ${allSongs.length}`);
    progress.total = allSongs.length;
    saveProgress(progress);
    
    // Sync to MongoDB
    console.log("Syncing to MongoDB (using upsert)...");
    
    if (allSongs.length > 0) {
      const batchSize = 1000;
      for (let i = 0; i < allSongs.length; i += batchSize) {
        const batch = allSongs.slice(i, i + batchSize);
        
        // Prepare bulk operations
        const ops = batch.map(song => ({
          updateOne: {
            filter: { path: song.path },
            update: { $set: song },
            upsert: true
          }
        }));
        
        await tracksColl.bulkWrite(ops);
        
        progress.synced = Math.min(i + batchSize, allSongs.length);
        saveProgress(progress);
        console.log(`  Processed ${progress.synced}/${allSongs.length} songs`);
      }

      // Optional: remove songs no longer on NAS (full sync only, currently commented out)
      // const allPaths = allSongs.map(s => s.path);
      // await tracksColl.deleteMany({ path: { $nin: allPaths } });
    }

    // When syncing a specific folder with --replace-scope: remove from DB any track outside that folder (so DB is not polluted)
    if (FOLDER_ARG && REPLACE_SCOPE) {
      const folderNorm = FOLDER_ARG.replace(/\/+$/, "");
      const prefixWithSlash = "/Music/" + folderNorm + "/";
      const prefixNoSlash = "Music/" + folderNorm + "/";
      const escapeForRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const inScopeWith = "^" + escapeForRegex(prefixWithSlash);
      const inScopeNo = "^" + escapeForRegex(prefixNoSlash);
      const outside = await tracksColl
        .find({
          $or: [
            { path: { $exists: false } },
            { path: null },
            { path: "" },
            { $and: [ { path: { $not: { $regex: inScopeWith } } }, { path: { $not: { $regex: inScopeNo } } } ] }
          ]
        })
        .project({ _id: 1, path: 1 })
        .toArray();
      if (outside.length > 0) {
        await tracksColl.deleteMany({ _id: { $in: outside.map((t) => t._id) } });
        console.log(`  [--replace-scope] Removed ${outside.length} track(s) outside /Music/${folderNorm}/`);
      }
    }

    // Rebuild albums: group by directory path so all tracks in the same folder form one album (avoids split when artist/album parse varies).
    // Reclassified albums do not remain; songs are never orphaned.
    console.log("Rebuilding albums from tracks...");
    // Build directory path from path (strip filename). $slice third arg must be positive, so use size-1.
    const pathSplit = { $split: [ { $ifNull: ["$path", ""] }, "/" ] };
    const dirPathFromPath = {
      $reduce: {
        input: {
          $slice: [
            pathSplit,
            0,
            { $max: [ 0, { $subtract: [ { $size: pathSplit }, 1 ] } ] }
          ]
        },
        initialValue: "",
        in: { $cond: [ { $eq: ["$$value", ""] }, "$$this", { $concat: ["$$value", "/", "$$this"] } ] }
      }
    };
    const pipeline = [
      { $addFields: { albumBase: { $ifNull: ["$albumBase", "$album"] }, discNum: { $ifNull: ["$discNumber", 1] }, directoryPath: { $ifNull: ["$directoryPath", dirPathFromPath] } } },
      { $match: { path: { $exists: true, $nin: [null, ""] }, directoryPath: { $exists: true, $nin: [null, ""] } } },
      { $addFields: { directoryPathNorm: { $ltrim: { input: "$directoryPath", chars: "/" } } } },
      { $group: { _id: "$directoryPathNorm", tracks: { $push: { _id: "$_id", discNum: "$discNum", name: "$name" } }, doc: { $first: "$$ROOT" } } }
    ];
    const groupsRaw = await tracksColl.aggregate(pipeline).toArray();
    const groups = groupsRaw.map((g) => {
      g.tracks.sort((a, b) => (a.discNum !== b.discNum ? a.discNum - b.discNum : (a.name || "").localeCompare(b.name || "")));
      return { _id: g._id, trackIds: g.tracks.map((t) => t._id), doc: g.doc };
    });
    const keptAlbumIds = new Set();
    for (const g of groups) {
      const first = g.doc;
      const artist = first.artist || "Unknown Artist";
      const album = first.albumBase || first.album || first.directoryPath || "Unknown Album";
      const albumMeta = {
        artist,
        album,
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
        { artist, album },
        { $set: albumMeta },
        { upsert: true, returnDocument: "after" }
      );
      keptAlbumIds.add(albumDoc._id.toString());
      await tracksColl.updateMany({ _id: { $in: g.trackIds } }, { $set: { albumId: albumDoc._id } }); // back-reference to parent album
    }
    const ungrouped = await tracksColl.updateMany(
      { _id: { $nin: groups.flatMap((g) => g.trackIds) } },
      { $set: { albumId: null } }
    );
    if (ungrouped.modifiedCount > 0) {
      console.log(`  ${ungrouped.modifiedCount} track(s) not part of an album (albumId left null).`);
    }
    // Albums with no tracks cannot exist: remove any album not in the set we just built
    const allAlbumIds = await albumsColl.find({}).project({ _id: 1 }).toArray();
    const toDelete = allAlbumIds.filter((a) => !keptAlbumIds.has(a._id.toString())).map((a) => a._id);
    if (toDelete.length > 0) {
      await albumsColl.deleteMany({ _id: { $in: toDelete } });
      console.log(`  Removed ${toDelete.length} album(s) with no tracks.`);
    }
    console.log(`  Updated ${groups.length} albums.`);

    // Create indexes
    console.log("Creating indexes...");
    try {
      const indexes = await tracksColl.indexes();
      for (const idx of indexes) {
        if (idx.textIndexVersion) {
          await tracksColl.dropIndex(idx.name);
        }
      }
      await tracksColl.createIndex({ name: "text", artist: "text", album: "text" });
    } catch (e) {
      console.log("Text index already exists or error:", e.message);
    }
    await tracksColl.createIndex({ genre: 1 });
    await tracksColl.createIndex({ artist: 1 });
    await tracksColl.createIndex({ album: 1 });
    await tracksColl.createIndex({ albumId: 1 }).catch(() => {});
    await albumsColl.createIndex({ artist: 1, album: 1 }).catch(() => {});
    
    progress.status = "completed";
    progress.endTime = new Date().toISOString();
    saveProgress(progress);
    
    console.log("\n========== SYNC COMPLETE ==========");
    console.log(`Total songs synced: ${allSongs.length}`);
    console.log(`Duration: ${((new Date(progress.endTime) - new Date(progress.startTime)) / 1000).toFixed(1)}s`);
    
  } catch (err) {
    console.error("Error:", err);
    progress.status = "error";
    progress.error = err.message;
    progress.endTime = new Date().toISOString();
    saveProgress(progress);
  } finally {
    await logout();
    if (client) await client.close();
  }
}

// Export for API use
module.exports = { main };

// Run directly if called from command line
if (require.main === module) {
  main().catch(console.error);
}
