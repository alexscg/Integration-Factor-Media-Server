require("dotenv").config({ path: "D:/CODE/Integration-Factor-UI/.env" });
const https = require("https");

// TheAudioDB API Key (using the free test key '123' as per user)
const API_KEY = "123";
const BASE_URL = `https://theaudiodb.com/api/v1/json/${API_KEY}`;

async function testAudioDB() {
  const artist = "Madonna";
  const url = `${BASE_URL}/search.php?s=${encodeURIComponent(artist)}`;
  
  console.log(`Testing TheAudioDB API with: ${artist}`);
  
  https.get(url, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302) {
      console.log(`Redirected to: ${res.headers.location}`);
      https.get(res.headers.location, (res2) => {
        let data = "";
        res2.on("data", chunk => data += chunk);
        res2.on("end", () => {
          console.log(`Status Code: ${res2.statusCode}`);
          try {
            const json = JSON.parse(data);
            console.log(`Response: ${JSON.stringify(json, null, 2)}`);
          } catch (e) {
            console.log(`Response (raw): ${data}`);
          }
        });
      });
      return;
    }
    let data = "";
    res.on("data", chunk => data += chunk);
    res.on("end", () => {
      console.log(`Status Code: ${res.statusCode}`);
      try {
        const json = JSON.parse(data);
        console.log(`Response: ${JSON.stringify(json, null, 2)}`);
      } catch (e) {
        console.log(`Response (raw): ${data}`);
      }
    });
  }).on("error", (err) => {
    console.error(`Error: ${err.message}`);
  });
}

testAudioDB();
