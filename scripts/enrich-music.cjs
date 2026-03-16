const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { MongoClient } = require("mongodb");
const https = require("https");
const fs = require("fs");
const { isValidImageUrl: validateCoverUrl } = require("./validate-cover-url.cjs");
const { normalizeArtworkUrl } = require("./normalize-artwork-url.cjs");

// Configuration from env (no ESM config.js dependency)
const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || "integration-factor";
const TRACKS_COLLECTION = process.env.TRACKS_COLLECTION || process.env.COLLECTION_NAME || "tracks";
const ALBUMS_COLLECTION = process.env.ALBUMS_COLLECTION || "albums";
const DELETED_ARTWORK_COLLECTION = process.env.DELETED_ARTWORK_COLLECTION || "deletedArtwork";
const MIN_CONFIDENCE_THRESHOLD = parseInt(process.env.MIN_CONFIDENCE_THRESHOLD, 10) || 75;
const THEAUDIODB_API_KEY = process.env.THEAUDIODB_API_KEY || process.env.VITE_THEAUDIODB_API_KEY;
const DISCOGS_CONSUMER_KEY = process.env.DISCOGS_CONSUMER_KEY;
const DISCOGS_CONSUMER_SECRET = process.env.DISCOGS_CONSUMER_SECRET;

if (!MONGODB_URI) {
  console.error("ERROR: MONGODB_URI is not set in .env file.");
  process.exit(1);
}
const PROGRESS_FILE = path.join(__dirname, "enrich-progress.json");
const RATE_LIMIT_MS = 1100;
const CLASSICAL_ARTISTS = (() => {
  try {
    return require(path.join(__dirname, "classical-artists.json"));
  } catch {
    return { shortToFull: {}, full: [] };
  }
})();

// Set of known artist names (from your list) so we can detect "album" that is really the artist name
const KNOWN_ARTIST_NAMES = (() => {
  const set = new Set();
  const stf = CLASSICAL_ARTISTS.shortToFull || {};
  for (const k of Object.keys(stf)) set.add(k.trim().toLowerCase());
  for (const v of Object.values(stf)) set.add(String(v).trim().toLowerCase());
  const full = CLASSICAL_ARTISTS.full || [];
  for (const f of full) set.add(String(f).trim().toLowerCase());
  return set;
})();

// Sorted list of known artist names (longest first) to split "Artist - Suffix" -> artist + album part
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

/** If artist is "KnownArtist - Suffix" (known artist from list), return { artist: KnownArtist, suffix }. Else null. */
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

function isAlbumActuallyArtistName(album, artist) {
  if (!album || album === "Unknown Album") return false;
  const a = album.trim().toLowerCase();
  if (artist && artist.trim().toLowerCase() === a) return true;
  return KNOWN_ARTIST_NAMES.has(a);
}
const ARGV = process.argv.slice(2);
const SINGLE_ALBUM_ID = (() => {
  const i = ARGV.indexOf("--single");
  if (i === -1) return null;
  if (ARGV[i + 1] && !ARGV[i + 1].startsWith("--")) return ARGV[i + 1].trim();
  const eq = ARGV[i];
  if (eq.includes("=")) return eq.replace(/^--single=/, "").trim();
  return null;
})();
const TEST_LIMIT = SINGLE_ALBUM_ID ? 1 : (ARGV[0] ? parseInt(ARGV[0], 10) : 0);
// When --single <id> is used, ARGV[1] is the album ID; do not use it as START_INDEX
const START_INDEX = SINGLE_ALBUM_ID ? 0 : (ARGV[1] && !ARGV[1].startsWith("--") ? parseInt(ARGV[1], 10) : 0);
const USE_RANDOM = ARGV.includes("--random");

// Single-album: log to stderr so output is visible when run as child process (avoids stdout buffering)
function singleLog(...args) {
  if (!SINGLE_ALBUM_ID) return;
  process.stderr.write(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ") + "\n");
}

// Discogs requires a unique User-Agent (https://www.discogs.com/developers#page:home,header:home-general-information)
const USER_AGENT = "IntegrationFactorMusicApp/1.0 (https://integrationfactor.com; contact@integrationfactor.com)";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function isValidImageUrl(url) {
  return validateCoverUrl(url, { userAgent: USER_AGENT });
}

async function httpsGet(url, retries = 3, initialDelay = RATE_LIMIT_MS, headers = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const options = {
          headers: { "User-Agent": USER_AGENT, "Accept": "application/json", ...headers }
        };
        
        https.get(url, options, (res) => {
          // Handle redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return httpsGet(res.headers.location, retries, initialDelay, headers).then(resolve).catch(reject);
          }
          
          if (res.statusCode === 404) {
            resolve(null);
            return;
          }
          if (res.statusCode === 503 || res.statusCode === 429 || res.statusCode === 502) {
            reject(new Error(`Rate limited/Server error: ${res.statusCode}`));
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          
          let data = "";
          res.on("data", chunk => data += chunk);
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              resolve(null);
            }
          });
        }).on("error", reject);
      });
    } catch (err) {
      if (err.message.includes("Rate limited") && i < retries - 1) {
        const delay = initialDelay * Math.pow(2, i);
        console.log(`  Rate limited, retrying in ${delay}ms...`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}

async function theAudioDBGet(endpoint) {
  if (!THEAUDIODB_API_KEY) return null;
  const url = `https://theaudiodb.com/api/v1/json/${THEAUDIODB_API_KEY}/${endpoint}`;
  if (SINGLE_ALBUM_ID) {
    singleLog("[TheAudioDB] GET", url);
    const match = endpoint.match(/s=([^&]+)&a=([^&]+)/);
    singleLog("[TheAudioDB] payload:", match
      ? { artist: decodeURIComponent(match[1]), album: decodeURIComponent(match[2]) }
      : { endpoint });
  }
  return await httpsGet(url);
}

async function discogsGet(endpoint) {
  if (!DISCOGS_CONSUMER_KEY || !DISCOGS_CONSUMER_SECRET) return null;
  const url = `https://api.discogs.com/${endpoint}`;
  if (SINGLE_ALBUM_ID) {
    singleLog("[Discogs] GET", url);
    const artistMatch = endpoint.match(/artist=([^&]+)/);
    const titleMatch = endpoint.match(/release_title=([^&]+)/);
    const qMatch = endpoint.match(/[?&]q=([^&]+)/);
    const payload = artistMatch || titleMatch || qMatch
      ? { ...(artistMatch && { artist: decodeURIComponent(artistMatch[1]) }), ...(titleMatch && { release_title: decodeURIComponent(titleMatch[1]) }), ...(qMatch && { q: decodeURIComponent(qMatch[1]) }) }
      : { endpoint };
    singleLog("[Discogs] payload:", payload);
  }
  const headers = {
    "User-Agent": USER_AGENT,
    "Authorization": `Discogs key=${DISCOGS_CONSUMER_KEY}, secret=${DISCOGS_CONSUMER_SECRET}`
  };
  return await httpsGet(url, 3, RATE_LIMIT_MS, headers);
}

function getArtistVariations(artist) {
  if (!artist || artist === "Unknown Artist") return [];
  const variations = [artist];
  const trimmed = artist.trim();
  // When folder has short form (e.g. "Beethoven"), try full name first for better API matches
  const shortToFull = CLASSICAL_ARTISTS.shortToFull || {};
  const lowerTrimmed = trimmed.toLowerCase();
  for (const [short, full] of Object.entries(shortToFull)) {
    if (short.toLowerCase() === lowerTrimmed) {
      variations.unshift(full);
      break;
    }
  }
  if (artist.toLowerCase().startsWith("the ")) variations.push(artist.substring(4));
  const classicalFullToShort = {
    "ludwig van beethoven": "Beethoven",
    "wolfgang amadeus mozart": "Mozart",
    "johann sebastian bach": "Bach",
    "pyotr ilyich tchaikovsky": "Tchaikovsky",
    "antonio vivaldi": "Vivaldi",
    "franz joseph haydn": "Haydn",
    "frederic chopin": "Chopin",
    "franz schubert": "Schubert",
    "george frideric handel": "Handel",
    "johannes brahms": "Brahms",
    "antonin dvorak": "Dvorak",
    "richard wagner": "Wagner",
    "claude debussy": "Debussy",
    "sergei rachmaninoff": "Rachmaninoff",
    "sergei rachmaninov": "Rachmaninov",
    "giuseppe verdi": "Verdi",
    "johann strauss": "Strauss",
    "franz liszt": "Liszt"
  };
  const lowerArtist = artist.toLowerCase();
  if (classicalFullToShort[lowerArtist]) variations.push(classicalFullToShort[lowerArtist]);
  const parts = artist.split(/\s+/);
  if (parts.length > 1 && parts[parts.length - 1].length > 3) variations.push(parts[parts.length - 1]);
  return [...new Set(variations)];
}

function alphanumericalize(str) {
  if (!str) return "";
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// "CDImage", "CD", "CDx" (x = number) are not real metadata – only multi-CD context (e.g. "Album (CD 2/3)") is meaningful
function isCdPlaceholder(value) {
  if (value == null || typeof value !== "string") return true;
  const s = value.trim();
  if (!s) return true;
  if (/^CDImage$/i.test(s)) return true;
  if (/^CD$/i.test(s)) return true;
  if (/^CD\s*\d+$/i.test(s)) return true; // CD1, CD 2, CD 3, etc. – not a name by itself
  return false;
}

function cleanAlbumName(album) {
  if (!album) return "";
  // Keep classical opus/catalog numbers (Op. 67, No. 1); strip other parenthetical content
  const stripNonOpusParens = (str) =>
    str.replace(/\s*\(([^)]*)\)/g, (_, inner) =>
      /^(Op\.?\s*\d+|No\.?\s*\d+)$/i.test(inner.trim()) ? ` (${inner.trim()})` : ""
    );
  return stripNonOpusParens(
    album
      .replace(/\s*[-_]\s*CD\s*\d+/gi, "")
      .replace(/\s*CD\s*\d+/gi, "")
      .replace(/\s*Dis[ck]\s*\d+/gi, "")
      .replace(/\s*Vol\.?\s*\d+/gi, "")
      .replace(/\s*\(\d{4}[-–]\d{4}\)/g, "")
      .replace(/\s*Discography.*$/gi, "")
      .replace(/\s*Complete.*Edition/gi, "")
      .replace(/\s*Remaster(ed)?/gi, "")
      .replace(/\s*\[.*?\]/g, "")
  )
    .replace(/\s*\(?\d+cd\)?/gi, "")
    .replace(/\s*\(?mp3\)?/gi, "")
    .replace(/\s*\(?radio\s*mix\)?/gi, "")
    .replace(/^\d+\s*[-_.]\s*/, "")
    .replace(/\s*-\s*$/, "")
    .trim();
}

function levenshtein(a, b) {
  const tmp = [];
  for (let i = 0; i <= a.length; i++) tmp[i] = [i];
  for (let j = 0; j <= b.length; j++) tmp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      tmp[i][j] = Math.min(tmp[i - 1][j] + 1, tmp[i][j - 1] + 1, tmp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return tmp[a.length][b.length];
}

function calculateConfidenceScore(source, apiResult, localData) {
  let score = 0;

  // Base score per source
  if (source === "MusicBrainz") score += 100;
  if (source === "Discogs") score += 90;
  if (source === "TheAudioDB") score += 80;

  // Prefer candidates that have cover art (MB art is unknown until we try CAA)
  if (source === "Discogs" && apiResult.cover_image) score += 12;
  if (source === "TheAudioDB" && (apiResult.strAlbumThumb || apiResult.strArtistWideThumb)) score += 12;

  // Normalize data for comparison
  const apiArtist = (apiResult.strArtist || apiResult["artist-credit"]?.[0]?.artist?.name || "").toLowerCase();
  const apiAlbum = (apiResult.strAlbum || apiResult.title || "").toLowerCase();
  const localArtist = localData.artist.toLowerCase();
  const localAlbum = localData.album.toLowerCase();

  // Artist match
  const artistDist = levenshtein(apiArtist, localArtist);
  if (artistDist < 5) score += Math.max(0, 50 - artistDist * 10);

  // Album match
  const albumDist = levenshtein(apiAlbum, localAlbum);
  if (albumDist < 5) score += Math.max(0, 50 - albumDist * 10);

  return score;
}

// localData: optional { artist, album } to pick first result that passes confidence threshold (avoids wrong first hit)
async function searchFuzzy(type, query, minScore = 75, localData = null) {
  if (!query || query.length < 3) return null;
  const encoded = encodeURIComponent(query);
  const url = `https://musicbrainz.org/ws/2/${type}/?query=${encoded}&fmt=json&limit=10`;
  if (SINGLE_ALBUM_ID) {
    singleLog("[MusicBrainz] GET", url);
    singleLog("[MusicBrainz] payload:", { type, query });
  }
  try {
    const data = await httpsGet(url);
    if (data) {
      const results = data[type + "s"] || data.releases || data.recordings;
      if (results && results.length > 0) {
        results.sort((a, b) => b.score - a.score);
        const minAcceptable = minScore - 20;
        if (localData) {
          for (const r of results) {
            if (r.score < minAcceptable) continue;
            const score = calculateConfidenceScore("MusicBrainz", r, localData);
            if (score >= minScore) return { type, data: r };
          }
        }
        if (results[0].score >= minAcceptable) return { type, data: results[0] };
      }
    }
  } catch (err) {
    if (err.message.includes("Rate limited")) {
      await sleep(5000);
      return searchFuzzy(type, query, minScore, localData);
    }
  }
  return null;
}

// Get artwork for a candidate. releaseId only needed when candidate is MusicBrainz (use candidate.data.id).
function getCoverArt(candidate) {
  if (!candidate || !candidate.data) return null;
  if (candidate.source === "Discogs" && candidate.data.cover_image) {
    return { small: candidate.data.cover_image, large: candidate.data.cover_image, source: "Discogs" };
  }
  if (candidate.source === "TheAudioDB") {
    const thumb = candidate.data.strAlbumThumb || candidate.data.strArtistWideThumb;
    if (thumb) return { small: thumb, large: thumb, source: "TheAudioDB" };
  }
  if (candidate.source === "MusicBrainz" && candidate.data.id) {
    const base = `https://coverartarchive.org/release/${candidate.data.id}`;
    return { small: `${base}/front-250`, large: `${base}/front-500`, source: "MusicBrainz" };
  }
  return null;
}

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
  } catch (e) {}
  return { processedAlbums: {}, stats: { found: 0, notFound: 0, withArt: 0, byMethod: {} } };
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

const MIN_TRACKS_FOR_FALLBACK = 2;
const MAX_CANDIDATES_TRACK_FETCH = 8;
const MIN_TRACK_OVERLAP_RATIO = 0.3;

function normalizeTrackTitle(str) {
  if (str == null || typeof str !== "string") return "";
  return str
    .replace(/\s*[(\[].*?[)\]]\s*$/g, "")
    .replace(/\s*[-–—]\s*.*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function getLocalTrackNames(tracksColl, albumOid) {
  const tracks = await tracksColl.find({ albumId: albumOid }, { projection: { name: 1 } }).toArray();
  const names = tracks.map((t) => t.name).filter((n) => n && String(n).trim().length > 0);
  return names;
}

function computeTrackOverlapScore(localNames, releaseTitles) {
  if (localNames.length === 0) return 0;
  const localSet = new Set(localNames.map(normalizeTrackTitle).filter((s) => s.length > 0));
  if (localSet.size === 0) return 0;
  const releaseSet = new Set(releaseTitles.map(normalizeTrackTitle).filter((s) => s.length > 0));
  let matched = 0;
  for (const local of localSet) {
    if (releaseSet.has(local)) {
      matched++;
      continue;
    }
    for (const release of releaseSet) {
      if (local.includes(release) || release.includes(local)) {
        matched++;
        break;
      }
    }
  }
  return matched / localSet.size;
}

async function getMusicBrainzReleaseTrackList(mbReleaseId) {
  const url = `https://musicbrainz.org/ws/2/release/${mbReleaseId}?inc=recordings&fmt=json`;
  if (SINGLE_ALBUM_ID) {
    singleLog("[MusicBrainz] GET (release track list)", url);
    singleLog("[MusicBrainz] payload:", { mbReleaseId });
  }
  try {
    const data = await httpsGet(url);
    if (!data || !data.media) return [];
    const titles = [];
    for (const medium of data.media) {
      const tracks = medium.tracks || medium["track-list"] || [];
      for (const t of tracks) {
        const rec = t.recording || t;
        const title = rec.title || t.title;
        if (title) titles.push(title);
      }
    }
    return titles;
  } catch {
    return [];
  }
}

async function getDiscogsReleaseTrackList(releaseId) {
  try {
    const data = await discogsGet(`releases/${releaseId}`);
    if (!data || !data.tracklist) return [];
    return data.tracklist.map((t) => t.title || t).filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchMusicBrainzReleaseTitle(mbReleaseId) {
  if (!mbReleaseId) return null;
  const url = `https://musicbrainz.org/ws/2/release/${mbReleaseId}?fmt=json`;
  if (SINGLE_ALBUM_ID) {
    singleLog("[MusicBrainz] GET (release title)", url);
    singleLog("[MusicBrainz] payload:", { mbReleaseId });
  }
  try {
    await sleep(RATE_LIMIT_MS);
    const data = await httpsGet(url);
    return data?.title || null;
  } catch {
    return null;
  }
}

async function findMatchByTracks(artist, album, trackNames, tracksColl) {
  if (!trackNames || trackNames.length < MIN_TRACKS_FOR_FALLBACK) return null;
  const artistVariations = getArtistVariations(artist);
  const cleanedAlbum = cleanAlbumName(album);
  const seen = new Set();
  const candidates = [];

  for (const artistVar of artistVariations) {
    await sleep(RATE_LIMIT_MS);
    const encoded = encodeURIComponent(`${artistVar} ${cleanedAlbum}`);
    const mbUrl = `https://musicbrainz.org/ws/2/release/?query=${encoded}&fmt=json&limit=15`;
    if (SINGLE_ALBUM_ID) {
      singleLog("[MusicBrainz] GET (track fallback)", mbUrl);
      singleLog("[MusicBrainz] payload:", { query: `${artistVar} ${cleanedAlbum}` });
    }
    const mbData = await httpsGet(mbUrl).catch(() => null);
    if (mbData && mbData.releases) {
      for (const r of mbData.releases) {
        const key = `mb:${r.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push({ source: "MusicBrainz", type: "release", data: r });
        }
      }
    }
    await sleep(RATE_LIMIT_MS);
    const discogsQuery = `database/search?type=release&artist=${encodeURIComponent(artistVar)}&release_title=${encodeURIComponent(cleanedAlbum)}`;
    const discogs = await discogsGet(discogsQuery).catch(() => null);
    if (discogs && discogs.results) {
      for (const r of discogs.results) {
        const key = `dg:${r.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push({ source: "Discogs", type: "release", data: r });
        }
      }
    }
  }

  const toFetch = candidates.slice(0, MAX_CANDIDATES_TRACK_FETCH);
  let best = null;
  let bestScore = MIN_TRACK_OVERLAP_RATIO;

  for (const c of toFetch) {
    await sleep(RATE_LIMIT_MS);
    let titles = [];
    if (c.source === "MusicBrainz" && c.data.id) {
      titles = await getMusicBrainzReleaseTrackList(c.data.id);
    } else if (c.source === "Discogs" && c.data.id) {
      titles = await getDiscogsReleaseTrackList(c.data.id);
    }
    const score = computeTrackOverlapScore(trackNames, titles);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  if (best) {
    console.log(`  Track-based fallback: selected ${best.source} (overlap: ${(bestScore * 100).toFixed(0)}%)`);
    return { result: best, candidatesAboveThreshold: [best], method: `track-match (${best.source})` };
  }
  return null;
}

async function findMatch(artist, album) {
  const artistVariations = getArtistVariations(artist);
  const cleanedAlbum = cleanAlbumName(album);
  const alphaAlbum = alphanumericalize(cleanedAlbum);
  let candidates = [];

  // Try each database once per artist variation
  for (const artistVar of artistVariations) {
    const alphaArtistVar = alphanumericalize(artistVar);
    
    // MusicBrainz: pass localData so we pick first result that passes confidence (avoids tribute/cover as first hit)
    await sleep(RATE_LIMIT_MS);
    const mb = await searchFuzzy("release", `${alphaArtistVar} ${alphaAlbum}`, 60, { artist: artistVar, album: cleanedAlbum });
    if (mb) candidates.push({ source: "MusicBrainz", weight: 1.2, ...mb });

    // Discogs: artist + release_title (primary)
    await sleep(RATE_LIMIT_MS);
    const discogsQuery = `database/search?type=release&artist=${encodeURIComponent(artistVar)}&release_title=${encodeURIComponent(cleanedAlbum)}`;
    const discogs = await discogsGet(discogsQuery);
    if (discogs && discogs.results && discogs.results.length > 0) {
      candidates.push({ source: "Discogs", weight: 1.1, type: "release", data: discogs.results[0] });
    }
    // Discogs single-query fallback (matches site search "title artist") when title is long/descriptive
    if (cleanedAlbum.length > 25) {
      await sleep(RATE_LIMIT_MS);
      const q = `${cleanedAlbum} ${artistVar}`.trim();
      const discogsQ = await discogsGet(`database/search?type=release&q=${encodeURIComponent(q)}`);
      if (discogsQ && discogsQ.results && discogsQ.results.length > 0) {
        const first = discogsQ.results[0];
        const already = candidates.some((c) => c.source === "Discogs" && c.data.id === first.id);
        if (!already) {
          candidates.push({ source: "Discogs", weight: 1.1, type: "release", data: first });
        }
      }
    }

    // TheAudioDB
    await sleep(RATE_LIMIT_MS);
    const tdbQuery = `searchalbum.php?s=${encodeURIComponent(artistVar)}&a=${encodeURIComponent(cleanedAlbum)}`;
    const tdb = await theAudioDBGet(tdbQuery);
    if (tdb && tdb.album && tdb.album.length > 0) {
      candidates.push({ source: "TheAudioDB", weight: 1.0, type: "album", data: tdb.album[0] });
    }
  }

  if (candidates.length === 0) return { result: null, candidatesAboveThreshold: [], method: "not-found" };

  const localData = { artist, album };
  candidates.forEach(c => {
    c.finalScore = calculateConfidenceScore(c.source, c.data, localData);
  });
  candidates.sort((a, b) => b.finalScore - a.finalScore);

  const candidatesAboveThreshold = candidates.filter(c => c.finalScore >= MIN_CONFIDENCE_THRESHOLD);
  if (SINGLE_ALBUM_ID) {
    singleLog(`--- Search Results for: ${artist} - ${album} ---`);
    candidates.forEach(c => {
      singleLog(`Source: ${c.source} | Score: ${c.finalScore} | Data: ${JSON.stringify(c.data).substring(0, 100)}...`);
    });
    singleLog(`Selected: ${candidates[0]?.source || "None"} | Above threshold: ${candidatesAboveThreshold.length}`);
  } else {
    console.log(`\n--- Search Results for: ${artist} - ${album} ---`);
    candidates.forEach(c => {
      console.log(`Source: ${c.source} | Score: ${c.finalScore} | Data: ${JSON.stringify(c.data).substring(0, 100)}...`);
    });
    console.log(`Selected: ${candidates[0]?.source || "None"} | Above threshold: ${candidatesAboveThreshold.length}\n`);
  }

  return {
    result: candidates[0],
    candidatesAboveThreshold,
    method: `unified-search (${candidates[0].source})`
  };
}

async function verifyMatch(artist, album, mbResult) {
  let details = { sources: 0 };
  if (THEAUDIODB_API_KEY) {
    const tdbData = await theAudioDBGet(`searchalbum.php?s=${encodeURIComponent(artist)}&a=${encodeURIComponent(album)}`);
    if (tdbData && tdbData.album && tdbData.album.length > 0) {
      const tdbAlbum = tdbData.album[0];
      if (tdbAlbum.intYearReleased) { details.releaseYear = tdbAlbum.intYearReleased; details.sources++; }
      if (tdbAlbum.strGenre) details.genre = tdbAlbum.strGenre;
    }
  }
  if (DISCOGS_CONSUMER_KEY && DISCOGS_CONSUMER_SECRET && DISCOGS_CONSUMER_KEY.length > 0) {
    const discogsData = await discogsGet(`database/search?type=release&artist=${encodeURIComponent(artist)}&release_title=${encodeURIComponent(album)}`);
    if (discogsData && discogsData.results && discogsData.results.length > 0) {
      const dAlbum = discogsData.results[0];
      if (dAlbum.year) { details.releaseYear = dAlbum.year; details.sources++; }
      if (dAlbum.label && dAlbum.label.length > 0) details.label = dAlbum.label[0];
      if (dAlbum.catno) details.catalogNumber = dAlbum.catno;
    }
  }
  return { verified: details.sources > 0, details };
}

function extractData(matchResult, verificationDetails = {}, confidenceScore = 0) {
  const updateData = { ...verificationDetails, confidenceScore };
  const { result, method } = matchResult;
  if (!result || !result.data) return updateData;
  const data = result.data;
  if (result.type === "release") {
    if (data["text-representation"]?.language) updateData.audioLanguage = data["text-representation"].language;
    if (data.date && !updateData.releaseYear) updateData.releaseYear = data.date.substring(0, 4);
    if (data.year != null && !updateData.releaseYear) updateData.releaseYear = String(data.year).substring(0, 4);
    updateData.mbReleaseId = data.id;
  }
  updateData.mbMatchMethod = method;
  return updateData;
}

// Build primary + extra artwork from all candidates above threshold; dedupe by small URL
function collectArtwork(candidatesAboveThreshold) {
  const seen = new Set();
  const primary = candidatesAboveThreshold[0] ? getCoverArt(candidatesAboveThreshold[0]) : null;
  const extra = [];
  for (const c of candidatesAboveThreshold) {
    const art = getCoverArt(c);
    if (!art || !art.small) continue;
    if (seen.has(art.small)) continue;
    seen.add(art.small);
    if (primary && art.small === primary.small) continue;
    extra.push({ small: art.small, large: art.large, source: art.source || c.source });
  }
  return { primary, extra };
}

async function main() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DATABASE_NAME);
    const tracksColl = db.collection(TRACKS_COLLECTION);
    const albumsColl = db.collection(ALBUMS_COLLECTION);
    const deletedArtworkColl = db.collection(DELETED_ARTWORK_COLLECTION);
    const isArtworkDeletedForAlbum = async (albumOid, artworkUrl) => {
      if (!artworkUrl) return false;
      const norm = normalizeArtworkUrl(artworkUrl);
      const doc = await deletedArtworkColl.findOne({ albumId: albumOid, artworkUrl: norm });
      return !!doc;
    };
    let progress = loadProgress();
    if (TEST_LIMIT > 0) {
      progress.processedAlbums = {};
      progress.stats = { found: 0, notFound: 0, withArt: 0, byMethod: {} };
    }
    let albumList;
    if (SINGLE_ALBUM_ID) {
      const { ObjectId } = require("mongodb");
      let albumDoc = null;
      try {
        if (ObjectId.isValid(SINGLE_ALBUM_ID) && String(new ObjectId(SINGLE_ALBUM_ID)) === String(SINGLE_ALBUM_ID)) {
          albumDoc = await albumsColl.findOne({ _id: new ObjectId(SINGLE_ALBUM_ID) });
        }
      } catch (_) {}
      if (!albumDoc) albumDoc = await albumsColl.findOne({ $or: [ { mbReleaseId: SINGLE_ALBUM_ID }, { albumId: SINGLE_ALBUM_ID } ] });
      if (!albumDoc) {
        console.error(`No album found with _id/albumId/mbReleaseId: ${SINGLE_ALBUM_ID}`);
        process.exit(1);
      }
      albumList = [{ _id: albumDoc._id, artist: albumDoc.artist, album: albumDoc.album }];
      singleLog(`Single album enrichment: ${albumDoc.artist} – ${albumDoc.album}`);
      const mbOn = true;
      const discogsOn = !!(DISCOGS_CONSUMER_KEY && DISCOGS_CONSUMER_SECRET && DISCOGS_CONSUMER_KEY.length > 0);
      const tdbOn = !!(THEAUDIODB_API_KEY && THEAUDIODB_API_KEY.length > 0 && THEAUDIODB_API_KEY !== "123");
      singleLog(`APIs: MusicBrainz=${mbOn ? "on" : "off"}, Discogs=${discogsOn ? "on" : "off"}, TheAudioDB=${tdbOn ? "on" : "off"}`);
    } else {
      albumList = await albumsColl.find({}, { projection: { artist: 1, album: 1 } }).toArray();
    }
    if (USE_RANDOM && TEST_LIMIT > 0 && albumList.length > 0) {
      for (let i = albumList.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [albumList[i], albumList[j]] = [albumList[j], albumList[i]];
      }
      console.log("Random sample: " + Math.min(TEST_LIMIT, albumList.length) + " of " + albumList.length + " albums\n");
    }
    const totalToProcess = TEST_LIMIT > 0 ? Math.min(TEST_LIMIT, albumList.length) : albumList.length;
    let processed = 0;
    for (let i = 0; i < albumList.length; i++) {
      if (i < START_INDEX) continue;
      if (TEST_LIMIT > 0 && processed >= TEST_LIMIT) break;
      const albumDoc = albumList[i];
      let artist = albumDoc.artist;
      let album = albumDoc.album;
      const albumOid = albumDoc._id;
      // Normalize CD placeholders on both albums and tracks
      if (isCdPlaceholder(artist)) {
        const was = artist;
        artist = "Unknown Artist";
        if (was) {
          await albumsColl.updateOne({ _id: albumOid }, { $set: { artist } });
          await tracksColl.updateMany({ albumId: albumOid }, { $set: { artist } });
        }
      }
      if (isCdPlaceholder(album)) {
        const was = album;
        album = "Unknown Album";
        if (was) {
          await albumsColl.updateOne({ _id: albumOid }, { $set: { album } });
          await tracksColl.updateMany({ albumId: albumOid }, { $set: { album } });
        }
      }
      if ((!artist || artist === "Unknown Artist") && album && album !== "Unknown Album") {
        artist = album;
        await albumsColl.updateOne({ _id: albumOid }, { $set: { artist } });
        await tracksColl.updateMany({ albumId: albumOid }, { $set: { artist } });
      }
      const split = splitArtistSuffix(artist);
      if (split) {
        const prevArtist = artist;
        artist = split.artist;
        album = split.suffix + (album ? ` - ${album}` : "");
        await albumsColl.updateOne({ _id: albumOid }, { $set: { artist, album } });
        await tracksColl.updateMany({ albumId: albumOid }, { $set: { artist, album } });
        console.log(`  Fixed artist suffix: "${prevArtist}" → artist: ${artist}, album: ${album}`);
      }
      const albumKey = `${artist}|||${album}`;
      if (!SINGLE_ALBUM_ID && progress.processedAlbums[albumKey]) {
        if (isAlbumActuallyArtistName(album, artist)) {
          const fullDoc = await albumsColl.findOne({ _id: albumOid }, { projection: { mbReleaseId: 1 } });
          const mbId = fullDoc?.mbReleaseId;
          const isMbUuid = typeof mbId === "string" && /^[a-f0-9-]{36}$/i.test(mbId);
          if (isMbUuid) {
            const matchedTitle = await fetchMusicBrainzReleaseTitle(mbId);
            if (matchedTitle) {
              await albumsColl.updateOne({ _id: albumOid }, { $set: { album: matchedTitle } });
              await tracksColl.updateMany({ albumId: albumOid }, { $set: { album: matchedTitle } });
              console.log(`  Fixed artist-named album: "${album}" → "${matchedTitle}"`);
            }
          }
        }
        processed++;
        continue;
      }
      if ((!artist || artist === "Unknown Artist") && (!album || album === "Unknown Album")) {
        if (SINGLE_ALBUM_ID) singleLog("  Skipped: artist and album are unknown; nothing to search for.");
        if (!SINGLE_ALBUM_ID) progress.processedAlbums[albumKey] = true;
        processed++;
        continue;
      }
      processed++;
      if (SINGLE_ALBUM_ID) singleLog(`[${processed}/${totalToProcess}] Processing: ${artist} - ${album}`);
      else console.log(`\n[${processed}/${totalToProcess}] Processing: ${artist} - ${album}`);
      const trackNames = await getLocalTrackNames(tracksColl, albumOid);
      let matchResult = await findMatch(artist, album);
      let useTrackFallback = false;
      if (matchResult.result) {
        const initialScore = calculateConfidenceScore(matchResult.result.source, matchResult.result.data, { artist, album });
        if (initialScore < MIN_CONFIDENCE_THRESHOLD) useTrackFallback = true;
      } else {
        useTrackFallback = true;
      }
      if (useTrackFallback && trackNames.length >= MIN_TRACKS_FOR_FALLBACK) {
        const fallback = await findMatchByTracks(artist, album, trackNames, tracksColl);
        if (fallback) matchResult = fallback;
      }
      if (matchResult.result) {
        const verification = await verifyMatch(artist, album, matchResult.result);
        const confidenceScore = calculateConfidenceScore(matchResult.result.source, matchResult.result.data, { artist, album });
        if (confidenceScore >= MIN_CONFIDENCE_THRESHOLD) {
          progress.stats.found++;
          const updateData = extractData(matchResult, verification.details, confidenceScore);
          const candidatesAbove = matchResult.candidatesAboveThreshold || [matchResult.result];
          const { primary, extra } = collectArtwork(candidatesAbove);
          if (primary) {
            const smallDeleted = await isArtworkDeletedForAlbum(albumOid, primary.small);
            const largeDeleted = primary.large && primary.large !== primary.small ? await isArtworkDeletedForAlbum(albumOid, primary.large) : smallDeleted;
            if (smallDeleted && largeDeleted) {
              if (SINGLE_ALBUM_ID) singleLog("  Cover skipped: primary artwork was previously deleted for this album");
            } else if (!smallDeleted) {
              await sleep(RATE_LIMIT_MS);
              const primarySmallValid = await isValidImageUrl(primary.small);
              let primaryLargeValid = primarySmallValid;
              if (primary.large && primary.large !== primary.small && !largeDeleted) {
                await sleep(RATE_LIMIT_MS);
                primaryLargeValid = await isValidImageUrl(primary.large);
              }
              if (primarySmallValid) {
                updateData.coverArtSmall = primary.small;
                updateData.coverArtLarge = primaryLargeValid && primary.large && !largeDeleted ? primary.large : primary.small;
                progress.stats.withArt++;
              } else if (SINGLE_ALBUM_ID) {
                singleLog("  Cover skipped: primary URL did not return a valid image");
              }
            }
          }
          const validExtra = [];
          for (const e of extra) {
            const urlToCheck = e.small || e.large;
            if (!urlToCheck) continue;
            if (await isArtworkDeletedForAlbum(albumOid, urlToCheck)) continue;
            await sleep(RATE_LIMIT_MS);
            if (await isValidImageUrl(urlToCheck)) validExtra.push(e);
          }
          if (validExtra.length > 0) updateData.coverArtworkExtra = validExtra;
          updateData.mbReleaseId = updateData.mbReleaseId || matchResult.result.data.id;
          const data = matchResult.result.data;
          const matchedTitle = data.title || data.strAlbum || null;
          if (isAlbumActuallyArtistName(album, artist) && matchedTitle) {
            updateData.album = matchedTitle;
            await tracksColl.updateMany({ albumId: albumOid }, { $set: { album: matchedTitle } });
          } else {
            updateData.album = album;
          }

          await albumsColl.updateOne({ _id: albumOid }, { $set: updateData });
          const artNote = extra.length > 0 ? ` +${extra.length} extra` : "";
          if (SINGLE_ALBUM_ID) singleLog(`  ✓ Found: ${matchResult.method} (Score: ${confidenceScore}) | mbReleaseId: ${updateData.mbReleaseId}${artNote}`);
          else console.log(`  ✓ Found: ${matchResult.method} (Score: ${confidenceScore}) | mbReleaseId: ${updateData.mbReleaseId}${artNote}`);
        } else {
          progress.stats.notFound++;
          if (SINGLE_ALBUM_ID) {
            singleLog(`  ✗ Skipped (Confidence ${confidenceScore} < ${MIN_CONFIDENCE_THRESHOLD})`);
            singleLog(`  → Hint: best match scored ${confidenceScore}; threshold is ${MIN_CONFIDENCE_THRESHOLD}. Try MIN_CONFIDENCE_THRESHOLD=60 in .env to accept weaker matches.`);
          } else {
            console.log(`  ✗ Skipped (Confidence ${confidenceScore} < ${MIN_CONFIDENCE_THRESHOLD})`);
          }
        }
      } else {
        progress.stats.notFound++;
        if (SINGLE_ALBUM_ID) {
          singleLog("  ✗ Not found");
          const variations = getArtistVariations(artist);
          if (variations.length === 0) {
            singleLog("  → Hint: artist is empty or \"Unknown Artist\"; no search queries were run.");
          } else {
            singleLog("  → Hint: no candidates from any API. Check artist/album spelling, or add THEAUDIODB_API_KEY / Discogs keys in .env.");
          }
        } else {
          console.log("  ✗ Not found");
        }
      }
      if (!SINGLE_ALBUM_ID) progress.processedAlbums[albumKey] = true;
      if (!SINGLE_ALBUM_ID && processed % 10 === 0) saveProgress(progress);
    }
    if (!SINGLE_ALBUM_ID) saveProgress(progress);
  } catch (err) { console.error(err); } finally { await client.close(); }
}
main().catch(console.error);
