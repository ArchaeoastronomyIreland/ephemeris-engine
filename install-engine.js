// install-engine.js (FIXED VERSION)
const fs = require('fs');
const https = require('https');
const path = require('path');

// Using 'unpkg' as it is often more direct for file browsing than jsdelivr
const BASE_URL = 'https://unpkg.com/swisseph-wasm@2.0.2/dist/';
const FILES = ['swisseph.js', 'swisseph.wasm'];
const TARGET_DIR = path.join(__dirname, 'public/js');

if (!fs.existsSync(TARGET_DIR)) fs.mkdirSync(TARGET_DIR, { recursive: true });

function download(url, dest) {
    const file = fs.createWriteStream(dest);
    https.get(url, function(response) {
        // Handle Redirects (302/301)
        if (response.statusCode === 301 || response.statusCode === 302) {
            console.log(`redirecting...`);
            download(response.headers.location, dest);
            return;
        }
        
        // Handle 404s
        if (response.statusCode !== 200) {
            console.error(`❌ Failed to download ${path.basename(dest)} (Status: ${response.statusCode})`);
            file.close();
            fs.unlinkSync(dest); // Delete the bad file
            return;
        }

        response.pipe(file);
        file.on('finish', () => {
            file.close();
            console.log(`✅ Installed: ${path.basename(dest)}`);
        });
    }).on('error', (err) => {
        fs.unlink(dest, () => {});
        console.error(err.message);
    });
}

console.log("⬇️  Downloading Engine Files...");
FILES.forEach(fileName => {
    download(BASE_URL + fileName, path.join(TARGET_DIR, fileName));
});