# Enrichment Script — Analysis & Test Report

**Date:** March 2026  
**Script:** `scripts/enrich-music.cjs`  
**Test script:** `scripts/test-enrichment-and-artwork.cjs` (run with `node scripts/test-enrichment-and-artwork.cjs`)

---

## 1. Overview of the enrichment script

The script:

- Reads **artist + album** from MongoDB (grouped by unique artist/album).
- Queries **three** external sources: **MusicBrainz**, **Discogs**, **TheAudioDB**.
- Builds a list of **candidates** (one “best” result per source).
- Scores each candidate with **confidence** (source weight + Levenshtein match on artist/album).
- Picks the **highest‑scoring** candidate and, if score ≥ 75, updates all tracks for that artist/album with metadata + **artwork URLs**.
- Artwork is taken from: **Discogs** `cover_image`, **TheAudioDB** `strAlbumThumb` / `strArtistWideThumb`, or **MusicBrainz Cover Art Archive** (`front-250` / `front-500`).

---

## 2. Test results — three databases

Tested with three samples: **Pink Floyd / The Wall**, **Daft Punk / Random Access Memories**, **Unknown Artist / Some Obscure Album 1999**.

### 2.1 MusicBrainz

| Item | Result |
|------|--------|
| **HTTP** | 200 OK |
| **Response** | `releases[]` with `id`, `title`, `artist-credit`, `date`. MusicBrainz search returns a **relevance score** per release. |
| **Pink Floyd / The Wall** | First hit: *"Top Musicians Play Pink Floyd: The Wall"* (Various Artists) — **wrong** (tribute). |
| **Daft Punk / RAM** | First hit: *"Vitamin String Quartet Performs Daft Punk's Random Access Memories"* — **wrong** (cover). |
| **Unknown Artist / Obscure** | First hit: *"Artist Unknown"* (1999) — **false positive**. |

So: **MusicBrainz often returns a wrong “first” release** (tribute/cover/other). The script only uses the **first** result (after sorting by MusicBrainz score). The **unified algorithm** compensates by scoring artist/album with Levenshtein, so a better-matching candidate from another source (e.g. TheAudioDB) can win.

### 2.2 Discogs

| Item | Result |
|------|--------|
| **HTTP** | **403 Forbidden** (all three samples) |
| **Response** | No results; API blocks the request. |

So: **Discogs is currently unusable** in the test. Likely causes:

- Hardcoded key/secret in the script may be invalid, revoked, or not allowed for this app.
- Discogs may require a **user token** (OAuth) instead of or in addition to key/secret.
- Rate limiting or IP/User-Agent blocking.

**Recommendation:** Move Discogs credentials to `.env` and use official Discogs auth (e.g. token). Until 403 is resolved, the script effectively runs on **MusicBrainz + TheAudioDB** only.

### 2.3 TheAudioDB

| Item | Result |
|------|--------|
| **HTTP** | 200 OK (when API key is set) |
| **Response** | `album[]` with `idAlbum`, `strAlbum`, `strArtist`, `strAlbumThumb`, etc. |
| **Pink Floyd / The Wall** | Correct: *The Wall*, Pink Floyd, artwork URL present. |
| **Daft Punk / RAM** | Correct: *Random Access Memories*, Daft Punk, artwork URL present. |
| **Unknown Artist / Obscure** | No results (empty) — correct. |

So: **TheAudioDB** is returning **correct** artist/album and artwork for the two real samples and no false match for the obscure one.

---

## 3. Artwork URL validation

Artwork URLs produced by the script were checked with **HEAD** requests.

| Source | Sample URL | HEAD result | Valid in browser? |
|--------|------------|-------------|-------------------|
| **Cover Art Archive** (MusicBrainz) | `https://coverartarchive.org/release/<id>/front-500` | **307 Temporary Redirect** | **Yes** — browsers and `<img>` follow redirects; the final URL serves the image. HEAD does not follow redirects, so the test reports 307, not 200. |
| **TheAudioDB** | `https://r2.theaudiodb.com/images/media/album/thumb/...jpg` | **200 OK**, `content-type: image/jpeg` | **Yes** — direct image URL. |

Conclusion:

- **TheAudioDB** artwork links are **valid** and return 200.
- **Cover Art Archive** links are **valid for use in `<img>`**; they respond with 307 and require the client to follow redirects (which browsers do). Treating 3xx as “valid for images” in any validator is appropriate.

---

## 4. Algorithm evaluation

### 4.1 Flow

1. **Artist variations** — e.g. strip "The", add classical short names, last name — to improve match chances.
2. **Album cleaning** — strip "CD1", "Remaster", parentheticals, etc., then alphanumeric normalize.
3. **Per variation:** one query to each of MusicBrainz, Discogs, TheAudioDB; **first result only** from each is kept as a candidate.
4. **Scoring:**  
   - Base: MusicBrainz 100, Discogs 90, TheAudioDB 80.  
   - Artist match: Levenshtein(apiArtist, localArtist); if distance &lt; 5, add up to 50.  
   - Album match: Levenshtein(apiAlbum, localAlbum); if distance &lt; 5, add up to 50.  
5. **Winner:** max score; if ≥ 75, DB is updated with metadata + artwork (small/large).

### 4.2 Does it produce the desired results?

- **Desired:** Correct artist/album match and a working cover image when available.
- **Observed:**
  - When **TheAudioDB** has the correct release, it wins over a wrong MusicBrainz first hit (e.g. Pink Floyd, Daft Punk), because artist/album Levenshtein favours the correct match. So the **multi-source + confidence score** logic is doing its job.
  - When **Discogs** worked (not in this test due to 403), it would add a third candidate and more artwork options.
  - **MusicBrainz-only** wins when it’s the only candidate or when its first result actually matches; then Cover Art Archive URLs are used and are valid in the browser despite 307.

So the algorithm is **generally sound** for choosing the best of the three and for artwork selection. Main limitations:

- **First-result only** from each API: MusicBrainz in particular can put the “wrong” release first; the script does not scan other MusicBrainz results for a better artist/album match.
- **Discogs** is currently unusable (403); fixing auth is important if you want Discogs artwork and metadata.
- **Cover Art Archive** is only used when the **selected** candidate is MusicBrainz; when TheAudioDB or Discogs wins, their image URL is used (no fallback to MusicBrainz art for the same release).

### 4.3 Implemented improvements (post-report)

1. **MusicBrainz:** `searchFuzzy` now accepts optional `localData` and iterates through results until one passes the confidence threshold (avoids tribute/cover as first hit).
2. **Discogs:** Credentials moved to env (`DISCOGS_CONSUMER_KEY`, `DISCOGS_CONSUMER_SECRET`); same `USER_AGENT` as other requests; OAuth URLs documented in `.env.example` if token auth is needed.
3. **Config:** Script uses `process.env` and dotenv only (no ESM config.js); `MIN_CONFIDENCE_THRESHOLD`, `THEAUDIODB_API_KEY` from env.
4. **Paths:** All paths use `path.join(__dirname, "..")` or `path.join(__dirname, "enrich-progress.json")` for portability.
5. **Multiple artwork:** All candidates with score ≥ threshold are kept; artwork from each (deduped by URL) is stored. Primary: `coverArtSmall`, `coverArtLarge`. Additional: `coverArtworkExtra` array of `{ small, large, source }` for use in future multi-image UI.

---

## 5. Summary table

| Database     | HTTP status | Returns correct match?      | Artwork field / URL           | Artwork valid?        |
|-------------|-------------|-----------------------------|-------------------------------|------------------------|
| MusicBrainz | 200         | Often no (first hit wrong)  | Cover Art Archive (307)       | Yes (follow redirect)  |
| Discogs     | 403         | N/A (blocked)               | `cover_image`                 | N/A                    |
| TheAudioDB  | 200         | Yes (tested samples)        | `strAlbumThumb`, direct JPEG  | Yes (200 OK)           |

**Algorithm:** Multi-source + confidence scoring is appropriate; it corrects for bad MusicBrainz first hits when TheAudioDB (or Discogs) has a better match. Artwork links used by the script are valid in the browser; Cover Art Archive uses redirects (307), which is normal.

**Artwork links:** TheAudioDB URLs are directly valid (200). Cover Art Archive URLs are valid for use in `<img>` (307 then image); only a non-following HEAD check would report them as “fail”.
