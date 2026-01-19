const fs = require('fs');
const path = require('path');
const https = require('https');

// --- CONFIGURATION ---
const DIRS = [
    'src',
    'public',
    'public/css',
    'public/js',
    'public/assets',
    'public/assets/ephe' 
];

// UPDATED: Now pointing to the official Astrodienst FTP server
const EPH_FILE = {
    url: 'https://www.astro.com/ftp/swisseph/ephe/sepl_m30.se1',
    name: 'sepl_m30.se1',
    saveAs: 'sepl_m30.se1.bin' 
};

// --- MAIN EXECUTION ---
async function initProject() {
    console.log("🚀 Initializing Ephemeris Engine Structure...");

    // 1. Create Directory Tree
    DIRS.forEach(dir => {
        const fullPath = path.join(__dirname, dir);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
            console.log(`✅ Created: ${dir}/`);
        }
    });

    // 2. Create Manifest
    const manifestPath = path.join(__dirname, 'public/assets/ephe/ephemeris.manifest.json');
    if (!fs.existsSync(manifestPath)) {
        const manifestContent = {
            "description": "Hydration Manifest for Archaeoastronomy",
            "files": [
                {
                    "file": "sepl_m30.se1",
                    "range": "-3000 to -2400",
                    "url": "public/assets/ephe/sepl_m30.se1.bin"
                }
            ]
        };
        fs.writeFileSync(manifestPath, JSON.stringify(manifestContent, null, 2));
        console.log(`✅ Created: Hydration Manifest`);
    }

    // 3. Download Data
    const destPath = path.join(__dirname, 'public/assets/ephe', EPH_FILE.saveAs);
    if (!fs.existsSync(destPath)) {
        console.log(`⬇️  Downloading Archaeo Data from Astro.com...`);
        try {
            await downloadFile(EPH_FILE.url, destPath);
        } catch (err) {
            console.error("❌ Download Failed:", err.message);
        }
    } else {
        console.log(`ℹ️  Data File already exists: ${EPH_FILE.saveAs}`);
    }

    console.log("\n✨ Setup Complete.");
}

// --- HELPER: DOWNLOAD WITH REDIRECT SUPPORT ---
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        
        const request = https.get(url, (response) => {
            // Handle Redirects (301, 302)
            if (response.statusCode === 301 || response.statusCode === 302) {
                console.log(`   ...Redirecting to ${response.headers.location}`);
                file.close(); // Close the file stream for the redirect
                downloadFile(response.headers.location, dest) // Recursive call
                    .then(resolve)
                    .catch(reject);
                return;
            }

            // Handle Errors
            if (response.statusCode !== 200) {
                file.close();
                fs.unlink(dest, () => {}); 
                reject(new Error(`Server responded with ${response.statusCode}`));
                return;
            }

            // Pipe Data
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
                console.log(`✅ Downloaded: ${path.basename(dest)}`);
            });
        });

        request.on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

initProject();