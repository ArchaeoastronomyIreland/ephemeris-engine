// install-engine.js
const fs = require('fs');
const https = require('https');
const path = require('path');

// We use the 'prolaxu' build from a CDN
const BASE_URL = 'https://cdn.jsdelivr.net/npm/swisseph-wasm@2.0.2/dist/';
const FILES = ['swisseph.js', 'swisseph.wasm'];
const TARGET_DIR = path.join(__dirname, 'public/js');

if (!fs.existsSync(TARGET_DIR)) fs.mkdirSync(TARGET_DIR, { recursive: true });

FILES.forEach(file => {
    const dest = path.join(TARGET_DIR, file);
    const fileStream = fs.createWriteStream(dest);
    console.log(`Downloading ${file}...`);
    https.get(BASE_URL + file, response => {
        response.pipe(fileStream);
        fileStream.on('finish', () => {
            fileStream.close();
            console.log(`✅ Installed: ${file}`);
        });
    });
});