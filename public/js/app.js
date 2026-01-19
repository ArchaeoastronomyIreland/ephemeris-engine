// public/js/app.js
let swe = null;

// 1. Initialize the Engine
SwissEph({
    // Tell it where the .wasm file is (in the same folder as this script)
    locateFile: (path) => `js/${path}`,
}).then(module => {
    swe = module;
    document.getElementById('status').innerText = "Engine Ready. Waiting for input.";
    console.log("Wasm Module Initialized");
});

async function runCalculation() {
    if (!swe) return;
    
    const year = parseInt(document.getElementById('yearInput').value);
    const output = document.getElementById('output');
    const status = document.getElementById('status');
    
    try {
        status.innerText = "⏳ Hydrating Data...";
        
        // 2. THE HYDRATION STEP
        // If year is between -3000 and -2400, we need sepl_m30.se1
        if (year < -2400 && year >= -3000) {
            const filename = 'sepl_m30.se1';
            const vfsPath = `/ephe/${filename}`;
            
            // Check if file is already in VFS (Virtual File System)
            let fileExists = false;
            try { swe.FS.stat(vfsPath); fileExists = true; } catch(e) {}

            if (!fileExists) {
                // Not found? Download it!
                output.innerText += `\n[System] Fetching ${filename} from server...`;
                // Note: We fetch the .bin version for GitHub compatibility
                const resp = await fetch(`assets/ephe/${filename}.bin`);
                if (!resp.ok) throw new Error("Could not download ephemeris file");
                
                const buffer = await resp.arrayBuffer();
                
                // Create directory if missing
                try { swe.FS.mkdir('/ephe'); } catch(e) {}
                
                // Write to Wasm Memory (using the original name without .bin)
                swe.FS.writeFile(vfsPath, new Uint8Array(buffer));
                output.innerText += `\n[System] Data Injected.`;
            }
            
            // Tell Engine to look here
            swe.swe_set_ephe_path('/ephe');
        }

        // 3. CALCULATE (Mars)
        // Convert Date to Julian Day (Simplified for demo)
        // Archaeo-dates require careful calendar conversion, assuming Jan 1 here
        const julianDay = swe.swe_julday(year, 1, 1, 12, swe.SE_GREG_CAL);
        
        // Flags: High Precision + Equatorial (RA/Dec) + Speed
        const flags = swe.SEFLG_SWIEPH | swe.SEFLG_EQUATORIAL | swe.SEFLG_SPEED;
        
        // Execute Calculation (Planet 4 = Mars)
        const result = swe.swe_calc_ut(julianDay, swe.SE_MARS, flags);
        
        // 4. DISPLAY
        if (result.rc < 0) {
            output.innerText = `Error: ${result.error}`;
        } else {
            const [ra, dec, dist] = result.result;
            output.innerText = `
            Target: Mars
            Date: Jan 1, ${year}
            Ephemeris: ${year < -2400 ? "High Precision (JPL DE431)" : "Standard/Moshier"}
            ------------------------
            Right Ascension: ${(ra/15).toFixed(4)} hours
            Declination:     ${dec.toFixed(4)} degrees
            Distance:        ${dist.toFixed(4)} AU
            `;
            status.innerText = "Calculation Complete.";
        }

    } catch (err) {
        console.error(err);
        output.innerText = "Error: " + err.message;
        status.innerText = "Failed.";
    }
}