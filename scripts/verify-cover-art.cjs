require("dotenv").config({ path: "D:/CODE/Integration-Factor/.env" });
const { MongoClient } = require("mongodb");
const https = require("https");

const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || "integration-factor";
const ALBUMS_COLLECTION = process.env.ALBUMS_COLLECTION || "albums";

async function checkUrl(url) {
  return new Promise((resolve) => {
    if (!url || typeof url !== 'string') return resolve(false);
    https.get(url, (res) => {
      resolve(res.statusCode === 200);
    }).on("error", () => resolve(false));
  });
}

async function main() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DATABASE_NAME);
    const albumsColl = db.collection(ALBUMS_COLLECTION);

    console.log("Finding albums with cover art...");
    const cursor = albumsColl.find({ 
      $or: [
        { coverArtSmall: { $exists: true, $ne: null } },
        { coverArtLarge: { $exists: true, $ne: null } }
      ]
    });

    let count = 0;
    let removed = 0;

    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      let needsUpdate = false;
      const update = { $unset: {}, $set: {} };

      if (doc.coverArtSmall && !(await checkUrl(doc.coverArtSmall))) {
        console.log(`Invalid small art: ${doc.coverArtSmall} for ${doc.artist} - ${doc.album}`);
        update.$unset.coverArtSmall = "";
        needsUpdate = true;
      }
      
      if (doc.coverArtLarge && !(await checkUrl(doc.coverArtLarge))) {
        console.log(`Invalid large art: ${doc.coverArtLarge} for ${doc.artist} - ${doc.album}`);
        update.$unset.coverArtLarge = "";
        needsUpdate = true;
      }

      if (needsUpdate) {
        update.$set.confidenceScore = 0;
        await albumsColl.updateOne({ _id: doc._id }, update);
        removed++;
      }
      count++;
      if (count % 100 === 0) console.log(`Processed ${count} albums...`);
    }

    console.log(`Finished. Processed ${count} albums, removed invalid art for ${removed}.`);
  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
}

main();
