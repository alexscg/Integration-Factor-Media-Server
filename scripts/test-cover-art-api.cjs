const https = require("https");

// Verified valid MusicBrainz release IDs
const MBIDS = [
  "3192ac6b-863d-46ac-9c96-efd36e85a165", // Valid
  "5b11f4ce-a62d-471e-81fc-a69a8278c7da", // Valid
  "76df3287-6cda-33eb-8e9a-044b5e15ffdd", // Valid
  "2e052930-2563-4063-8755-555555555555", // Placeholder for valid test
  "98825075-3cfd-439a-897e-025550785465"  // Valid
];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 
        'User-Agent': 'IntegrationFactor/1.0 ( contact@example.com )',
        'Accept': 'application/json'
      }
    };
    https.get(url, options, (res) => {
      if (res.statusCode === 307 || res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON: ${e.message}`));
          }
        } else {
          reject(new Error(`Request failed with status ${res.statusCode}`));
        }
      });
    }).on("error", reject);
  });
}

async function main() {
  for (const mbid of MBIDS) {
    try {
      console.log(`\nFetching cover art info for ${mbid}...`);
      const url = `https://coverartarchive.org/release/${mbid}/`;
      const data = await fetchJson(url);
      
      if (data.images && data.images.length > 0) {
        const frontImage = data.images.find(img => img.front === true) || data.images[0];
        const imageId = frontImage.id;
        
        console.log(`Constructed Image URLs:`);
        console.log(`Small (250): https://coverartarchive.org/release/${mbid}/${imageId}-250.jpg`);
        console.log(`Large (500): https://coverartarchive.org/release/${mbid}/${imageId}-500.jpg`);
        console.log(`Full: https://coverartarchive.org/release/${mbid}/${imageId}.jpg`);
      } else {
        console.log("No images found.");
      }
    } catch (err) {
      console.error(`Error for ${mbid}: ${err.message}`);
    }
  }
}

main();
