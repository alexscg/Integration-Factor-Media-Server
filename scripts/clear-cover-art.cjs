require("dotenv").config({ path: "D:/CODE/Integration-Factor-UI/.env" });
const { MongoClient } = require("mongodb");

const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || "integration-factor";
const ALBUMS_COLLECTION = process.env.ALBUMS_COLLECTION || "albums";

async function main() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DATABASE_NAME);
    const albumsColl = db.collection(ALBUMS_COLLECTION);

    console.log("Removing all cover art fields from albums...");
    
    const result = await albumsColl.updateMany(
      {
        $or: [
          { coverArtSmall: { $exists: true } },
          { coverArtLarge: { $exists: true } }
        ]
      },
      {
        $unset: { coverArtSmall: "", coverArtLarge: "", coverArtworkExtra: "" },
        $set: { confidenceScore: 0 }
      }
    );

    console.log(`Finished. Removed cover art and reset confidence for ${result.modifiedCount} albums.`);
  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
}

main();
