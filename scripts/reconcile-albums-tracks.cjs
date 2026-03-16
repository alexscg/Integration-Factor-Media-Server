/**
 * Reconcile albums and tracks: ensure tracks that belong to an album have a valid albumId,
 * every album's trackIds are valid and consistent, and delete albums with no tracks.
 * Tracks with no album (albumId null) are allowed and left as-is.
 *
 * Usage:
 *   node scripts/reconcile-albums-tracks.cjs --dry-run   # report only
 *   node scripts/reconcile-albums-tracks.cjs --apply     # fix DB
 *   node scripts/reconcile-albums-tracks.cjs --apply --limit 50  # limit tracks processed (for testing)
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { MongoClient, ObjectId } = require("mongodb");

const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || "integration-factor";
const TRACKS_COLLECTION = process.env.TRACKS_COLLECTION || process.env.COLLECTION_NAME || "tracks";
const ALBUMS_COLLECTION = process.env.ALBUMS_COLLECTION || "albums";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const apply = args.includes("--apply");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : null;

if (!apply && !dryRun) {
  console.log("Use --dry-run (report only) or --apply (fix DB).");
  process.exit(1);
}

async function main() {
  if (!MONGODB_URI) {
    console.error("MONGODB_URI is required.");
    process.exit(1);
  }
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DATABASE_NAME);
    const tracksColl = db.collection(TRACKS_COLLECTION);
    const albumsColl = db.collection(ALBUMS_COLLECTION);

    const stats = {
      tracksChecked: 0,
      tracksMissingAlbumId: 0,
      tracksWrongAlbum: 0,
      tracksFixed: 0,
      albumsEmpty: 0,
      albumsDeleted: 0,
      albumTrackIdsFixed: 0,
      albumsCreated: 0
    };

    // Load all albums by _id for lookup
    const albumsById = new Map();
    const albumsByArtistAlbum = new Map();
    const albums = await albumsColl.find({}).toArray();
    for (const a of albums) {
      albumsById.set(a._id.toString(), a);
      const key = `${a.artist}|||${a.album}`;
      albumsByArtistAlbum.set(key, a);
    }

    // Track ids that each album currently lists
    const trackIdsByAlbumId = new Map();
    for (const a of albums) {
      trackIdsByAlbumId.set(a._id.toString(), new Set((a.trackIds || []).map((id) => id.toString())));
    }

    const trackCursor = tracksColl.find({});
    let processed = 0;
    const tracksToFix = []; // { track, action: 'set_album' | 'add_to_album', albumDoc }
    const albumTrackIdsToUpdate = new Map(); // albumId -> Set of trackIds (to set on album)
    const albumsToCreate = new Map(); // key "artist|||album" -> [ tracks ]

    while (await trackCursor.hasNext()) {
      if (limit != null && processed >= limit) break;
      const track = await trackCursor.next();
      processed++;
      stats.tracksChecked++;

      const tid = track._id.toString();
      const albumId = track.albumId ? track.albumId.toString() : null;

      if (!albumId) {
        stats.tracksMissingAlbumId++;
        const albumBase = track.albumBase || track.album;
        const hasValidAlbum = albumBase && albumBase !== "Unknown Album";
        if (!hasValidAlbum) {
          continue;
        }
        const key = `${track.artist}|||${albumBase}`;
        const albumDoc = albumsByArtistAlbum.get(key);
        if (!albumDoc) {
          if (!albumsToCreate.has(key)) albumsToCreate.set(key, []);
          albumsToCreate.get(key).push(track);
        } else {
          tracksToFix.push({ track, action: "set_album", albumDoc });
          if (!albumTrackIdsToUpdate.has(albumDoc._id.toString())) {
            albumTrackIdsToUpdate.set(albumDoc._id.toString(), new Set(trackIdsByAlbumId.get(albumDoc._id.toString()) || []));
          }
          albumTrackIdsToUpdate.get(albumDoc._id.toString()).add(tid);
        }
        continue;
      }

      const albumDoc = albumsById.get(albumId);
      if (!albumDoc) {
        stats.tracksWrongAlbum++;
        const key = `${track.artist}|||${track.album}`;
        const correct = albumsByArtistAlbum.get(key);
        if (!correct) {
          if (!albumsToCreate.has(key)) albumsToCreate.set(key, []);
          albumsToCreate.get(key).push(track);
        } else {
          tracksToFix.push({ track, action: "set_album", albumDoc: correct });
          if (!albumTrackIdsToUpdate.has(correct._id.toString())) {
            albumTrackIdsToUpdate.set(correct._id.toString(), new Set(trackIdsByAlbumId.get(correct._id.toString()) || []));
          }
          albumTrackIdsToUpdate.get(correct._id.toString()).add(tid);
        }
        continue;
      }

      const trackIdSet = trackIdsByAlbumId.get(albumId);
      if (!trackIdSet || !trackIdSet.has(tid)) {
        stats.tracksWrongAlbum++;
        if (!albumTrackIdsToUpdate.has(albumId)) {
          albumTrackIdsToUpdate.set(albumId, new Set(trackIdSet || []));
        }
        albumTrackIdsToUpdate.get(albumId).add(tid);
        tracksToFix.push({ track, action: "add_to_album", albumDoc });
      }
    }

    // Albums: remove trackIds that don't exist or point to wrong album
    const trackIdsToRemoveByAlbumId = new Map();
    for (const a of albums) {
      const aid = a._id.toString();
      const ids = a.trackIds || [];
      const valid = [];
      for (const id of ids) {
        const track = await tracksColl.findOne({ _id: id });
        if (!track) {
          if (!trackIdsToRemoveByAlbumId.has(aid)) trackIdsToRemoveByAlbumId.set(aid, []);
          trackIdsToRemoveByAlbumId.get(aid).push(id);
          continue;
        }
        const trackAlbumId = track.albumId ? track.albumId.toString() : null;
        if (trackAlbumId !== aid) {
          if (!trackIdsToRemoveByAlbumId.has(aid)) trackIdsToRemoveByAlbumId.set(aid, []);
          trackIdsToRemoveByAlbumId.get(aid).push(id);
          continue;
        }
        valid.push(id);
      }
      if (valid.length === 0) {
        stats.albumsEmpty++;
      }
    }

    // Report
    console.log("--- Reconcile report ---");
    console.log("Tracks checked:", stats.tracksChecked);
    console.log("Tracks missing albumId:", stats.tracksMissingAlbumId);
    console.log("Tracks wrong / not in album trackIds:", stats.tracksWrongAlbum);
    console.log("Albums that would have empty trackIds:", stats.albumsEmpty);
    console.log("Tracks to fix (assign to correct album):", tracksToFix.length);
    console.log("Albums needing trackIds update:", albumTrackIdsToUpdate.size);
    console.log("New albums to create (orphan groups):", albumsToCreate.size);

    if (dryRun) {
      console.log("\n[--dry-run] No changes applied. Use --apply to fix.");
      return;
    }

    // Apply: create missing albums for orphan groups (one album per artist||album, all tracks in that group)
    for (const [key, tracks] of albumsToCreate) {
      if (albumsByArtistAlbum.has(key)) continue;
      const first = tracks[0];
      const artist = first.artist;
      const album = first.album;
      const trackIds = tracks.map((t) => t._id);
      const newAlbum = {
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
        trackIds
      };
      const res = await albumsColl.insertOne(newAlbum);
      const newId = res.insertedId;
      albumsById.set(newId.toString(), { _id: newId, ...newAlbum });
      albumsByArtistAlbum.set(key, { _id: newId, ...newAlbum });
      albumTrackIdsToUpdate.set(newId.toString(), new Set(trackIds.map((id) => id.toString())));
      await tracksColl.updateMany({ _id: { $in: trackIds } }, { $set: { albumId: newId } });
      stats.tracksFixed += tracks.length;
      stats.albumsCreated++;
    }

    // Apply: update album trackIds (add missing, then remove invalid)
    for (const [aid, idSet] of albumTrackIdsToUpdate) {
      const oid = new ObjectId(aid);
      const arr = Array.from(idSet).map((s) => new ObjectId(s));
      await albumsColl.updateOne({ _id: oid }, { $set: { trackIds: arr } });
      stats.albumTrackIdsFixed++;
    }

    // Apply: set albumId on tracks that were missing or wrong
    for (const { track, albumDoc } of tracksToFix) {
      await tracksColl.updateOne({ _id: track._id }, { $set: { albumId: albumDoc._id } });
      stats.tracksFixed++;
    }

    // Apply: remove invalid trackIds from albums (tracks that don't exist or point elsewhere)
    for (const [aid, idsToRemove] of trackIdsToRemoveByAlbumId) {
      const oid = new ObjectId(aid);
      const album = await albumsColl.findOne({ _id: oid });
      if (!album || !album.trackIds) continue;
      const current = new Set(album.trackIds.map((x) => x.toString()));
      for (const id of idsToRemove) {
        current.delete(id.toString());
      }
      const newTrackIds = Array.from(current).map((s) => new ObjectId(s));
      await albumsColl.updateOne({ _id: oid }, { $set: { trackIds: newTrackIds } });
    }

    // Apply: delete albums with no tracks
    const albumsAfter = await albumsColl.find({}).toArray();
    for (const a of albumsAfter) {
      const trackIds = a.trackIds || [];
      if (trackIds.length === 0) {
        await albumsColl.deleteOne({ _id: a._id });
        stats.albumsDeleted++;
      }
    }

    console.log("\n--- Applied ---");
    console.log("Tracks fixed:", stats.tracksFixed);
    console.log("Albums created:", stats.albumsCreated);
    console.log("Album trackIds updated:", stats.albumTrackIdsFixed);
    console.log("Albums deleted (no tracks):", stats.albumsDeleted);
  } catch (err) {
    console.error("Reconcile failed:", err);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
