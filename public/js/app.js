// 1. Import the library directly (Must use ./ to indicate current folder)
import SwissEph from './swisseph.js';

let swe = null;

// 2. Initialize the WebAssembly Engine
SwissEph({
    // This tells the browser where to find 'swisseph.wasm'
    // Since index.html is in root, we look inside the 'js/' folder
    locateFile: (path) => `js/${path}`,
}).then(module => {
    swe = module;
    // Update UI to show we are ready
    const status = document.getElementById('status');
    if (status) status.innerText = "Engine Ready. Waiting for input.";
    console.log("Wasm Module Initialized");
});

// 3. EXPORT the function so index.html can import it
export async function runCalculation() {
    if (!swe) {
        alert("Engine still loading...");
        return;
    }

    const yearInput = document.getElementById('yearInput');
    const output = document.getElementById('output');
    const status = document.getElementById('status');
    
    // Default to -2500 if input is empty
    const year = parseInt(yearInput.value) || -2500;

    try {
        status.innerText = "⏳ Processing...";

        // --- PART A: DATA HYDRATION (The "Archaeo" Logic) ---
        // If year is between -3000 and -2400, we need the ancient file
        if (year < -2400 && year >= -3000) {
            const filename = 'sepl_m30.se1';
            const vfsPath = `/ephe/${filename}`; // Virtual path inside Wasm
            
            // Check if file is already loaded in memory
            let fileExists = false;
            try { 
                swe.FS.stat(vfsPath); 
                fileExists = true; 
            } catch(e) { /* File missing, need to download */ }

            if (!fileExists) {
                status.innerText = `⏳ Downloading ${filename}...`;
                
                // Fetch the .bin version from your server (GitHub Pages workaround)
                const resp = await fetch(`assets/ephe/${filename}.bin`);
                
                if (!resp.ok) {
                    throw new Error(`Ephemeris file not found: assets/ephe/${filename}.bin`);
                }
                
                const buffer = await resp.arrayBuffer();
                
                // Create virtual directory if it doesn't exist
                try { swe.FS.mkdir('/ephe'); } catch(e) {}
                
                // Write the binary data to the Wasm Virtual File System
                swe.FS.writeFile(vfsPath, new Uint8Array(buffer));
                console.log(`Hydrated ${filename}`);
            }
            
            // Tell the engine to look in the virtual /ephe folder
            swe.swe_set_ephe_path('/ephe');
        }
        // -----------------------------------------------------

        // --- PART B: CALCULATION ---
        
        // 1. Calculate Julian Day (UT)
        // Note: For 2500 BC, we assume Julian Calendar. 
        // 12.0 = Noon
        const julianDay = swe.swe_julday(year, 1, 1, 12, swe.SE_JUL_CAL);
        
        // 2. Set Flags
        // SEFLG_SWIEPH: Use high-precision binary files
        // SEFLG_EQUATORIAL: Return RA/Dec (Standard for Astronomy)
        // SEFLG_SPEED: Calculate velocity
        const flags = swe.SEFLG_SWIEPH | swe.SEFLG_EQUATORIAL | swe.SEFLG_SPEED;
        
        // 3. Calculate Mars (Body ID: 4)
        // returns { rc: number, result: [long/RA, lat/Dec, dist, speed...] }
        const data = swe.swe_calc_ut(julianDay, swe.SE_MARS, flags);
        
        // --- PART C: OUTPUT ---
        if (data.rc < 0) {
            output.innerText = `Error: ${data.error}`;
            status.innerText = "Calculation Failed";
        } else {
            const ra = data.result[0];   // Right Ascension (Degrees)
            const dec = data.result[1];  // Declination (Degrees)
            const dist = data.result[2]; // Distance (AU)
            
            // Format RA to Hours (RA / 15)
            const raHours = Math.floor(ra / 15);
            const raMin = Math.floor((ra / 15 - raHours) * 60);
            
            output.innerText = `
            Target: Mars
            Year: ${year} (Jan 1)
            Mode: ${year < -2400 ? "High Precision (JPL DE431)" : "Standard (Moshier)"}
            ------------------------------------
            Right Ascension: ${raHours}h ${raMin}m (${(ra/15).toFixed(4)} h)
            Declination:     ${dec.toFixed(4)}°
            Distance:        ${dist.toFixed(4)} AU
            `;
            
            status.innerText = "Calculation Complete";
        }

    } catch (err) {
        console.error(err);
        output.innerText = "System Error: " + err.message;
        status.innerText = "Error";
    }
}