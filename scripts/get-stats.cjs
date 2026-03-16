require("dotenv").config({ path: "D:/CODE/Integration-Factor/.env" });
const { MongoClient } = require("mongodb");

async function getStats() {
  const MONGODB_URI = process.env.MONGODB_URI;
  const DATABASE_NAME = process.env.DATABASE_NAME || "integration-factor";
  const TRACKS_COLLECTION = process.env.TRACKS_COLLECTION || process.env.COLLECTION_NAME || "tracks";
  const ALBUMS_COLLECTION = process.env.ALBUMS_COLLECTION || "albums";

  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DATABASE_NAME);
    const tracksCount = await db.collection(TRACKS_COLLECTION).countDocuments();
    const albumsCount = await db.collection(ALBUMS_COLLECTION).countDocuments();
    
    console.log("Total Tracks:", tracksCount);
    console.log("Total Albums:", albumsCount);
    
    await client.close();
  } catch (err) {
    console.error('Error fetching stats:', err);
  }
}

getStats();
