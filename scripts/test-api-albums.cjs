const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3001,
  path: '/api/albums?page=1&limit=10',
  method: 'GET',
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      console.log('Total albums reported by API:', json.total);
      console.log('Number of albums in data:', json.data.length);
    } catch (e) {
      console.error('Failed to parse response:', data);
    }
  });
});

req.on('error', (e) => {
  console.error('Request error:', e);
});

req.end();
