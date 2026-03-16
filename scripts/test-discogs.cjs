const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const https = require("https");

const DISCOGS_CONSUMER_KEY = process.env.DISCOGS_CONSUMER_KEY;
const DISCOGS_CONSUMER_SECRET = process.env.DISCOGS_CONSUMER_SECRET;
const USER_AGENT = "IntegrationFactorMusicApp/1.0 (https://integrationfactor.com; contact@integrationfactor.com)";

async function testDiscogs() {
  const artist = "Madonna";
  const album = "Vogue";
  const url = `https://api.discogs.com/database/search?type=release&artist=${encodeURIComponent(artist)}&release_title=${encodeURIComponent(album)}`;
  
  const options = {
    headers: { 
      "User-Agent": USER_AGENT, 
      "Accept": "application/json",
      "Authorization": `Discogs key=${DISCOGS_CONSUMER_KEY}, secret=${DISCOGS_CONSUMER_SECRET}`
    }
  };
  
  if (!DISCOGS_CONSUMER_KEY || !DISCOGS_CONSUMER_SECRET) {
    console.error("Set DISCOGS_CONSUMER_KEY and DISCOGS_CONSUMER_SECRET in .env");
    process.exit(1);
  }
  console.log(`Testing Discogs API with: ${artist} - ${album}`);
  console.log(`User-Agent: ${USER_AGENT}\n`);

  https.get(url, options, (res) => {
    let data = "";
    res.on("data", chunk => data += chunk);
    res.on("end", () => {
      console.log(`Status Code: ${res.statusCode}`);
      console.log(`Response: ${data}`);
    });
  }).on("error", (err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}

testDiscogs();
