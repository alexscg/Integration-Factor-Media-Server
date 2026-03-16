const https = require("https");

const API_KEY = "2"; // Public test key
const artist = "Queen";
const album = "Rock";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { "User-Agent": "Mozilla/5.0" }
    };
    const req = https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log("Redirecting to:", res.headers.location);
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      console.log("Status Code:", res.statusCode);
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        console.log("Raw response:", data);
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
  });
}

async function test() {
  // Try v1
  const url1 = `https://theaudiodb.com/api/v1/json/${API_KEY}/searchalbum.php?s=${encodeURIComponent(artist)}&a=${encodeURIComponent(album)}`;
  console.log("Testing v1:", url1);
  const res1 = await httpsGet(url1);
  console.log("v1 Result:", JSON.stringify(res1, null, 2));

  // Try v2 (TheAudioDB doesn't have a v2 endpoint in the URL structure, it's usually just v1)
  // But let's check if there's a different search endpoint
  const url2 = `https://theaudiodb.com/api/v1/json/${API_KEY}/search.php?s=${encodeURIComponent(artist)}`;
  console.log("\nTesting search.php (artist):", url2);
  const res2 = await httpsGet(url2);
  console.log("Search Result:", JSON.stringify(res2, null, 2));
}

test();
