// public/js/app.js

import SwissEph from './swisseph.js';

let swe = null;

// Initialize the Engine
SwissEph({
    locateFile: (path) => {
        if (path.includes('js/')) return path;
        return `js/${path}`;
    }
}).then(module => {
    swe = module;
    const status = document.getElementById('status');
    if (status) status.innerText = "Engine Ready. Waiting for input.";
    
    // DEBUG: Print all available functions to console so we stop guessing
    console.log("✅ Wasm Loaded. Available functions:", Object.keys(swe).filter(k => typeof swe[k] === 'function'));
});

export async function runCalculation() {
    if (!swe) {
        alert("Engine is still initializing... please wait 2 seconds and try again.");
        return;
    }

    const yearInput = document.getElementById('yearInput');
    const output = document.getElementById('output');
    const status = document.getElementById('status');
    
    const year = parseInt(yearInput.value) || -2500;

    try {
        status.innerText = "⏳ Processing...";
        output.innerText = "Starting calculation...";

        // --- 1. DYNAMIC FUNCTION FINDER ---
        // This block stops the "is not a function" errors by finding the real name
        const fnJulDay = swe.swe_julday || swe.julday;
        const fnCalc   = swe.swe_calc_ut || swe.calc_ut; // Try calc_ut or swe_calc_ut
        
        if (!fnJulDay || !fnCalc) {
            console.error("Engine Dump:", swe);
            throw new Error("Could not find calculation functions. Open Console (F12) to see available names.");
        }

        // --- 2. DATA HYDRATION (Archaeo Logic) ---
        if (year < -2400 && year >= -3000) {
            const filename = 'sepl_m30.se1';
            const vfsPath = `/${filename}`; // Write to Root
            
            let fileExists = false;
            try { swe.FS.stat(vfsPath); fileExists = true; } catch(e) {}

            if (!fileExists) {
                status.innerText = `⏳ Downloading ${filename}...`;
                const resp = await fetch(`assets/ephe/${filename}.bin`);
                if (!resp.ok) throw new Error(`Ephemeris file not found: assets/ephe/${filename}.bin`);
                const buffer = await resp.arrayBuffer();
                swe.FS.writeFile(vfsPath, new Uint8Array(buffer));
                console.log(`✅ Hydrated ${filename}`);
            }
        }

        // --- 3. CALCULATION ---
        
        // Calculate Julian Day
        // using the function we found earlier (fnJulDay)
        const julianDay = fnJulDay(year, 1, 1, 12, swe.SE_JUL_CAL);
        
        // Flags
        const flags = swe.SEFLG_SWIEPH | swe.SEFLG_EQUATORIAL | swe.SEFLG_SPEED;
        
        // Calculate Mars
        // using the function we found earlier (fnCalc)
        const data = fnCalc(julianDay, swe.SE_MARS, flags);
        
        // --- 4. OUTPUT ---
        if (data.rc < 0) {
            output.innerText = `Error: ${data.error}`;
            status.innerText = "Failed";
        } else {
            const [ra, dec, dist] = data.result;
            const raHours = Math.floor(ra / 15);
            const raMin = Math.floor((ra / 15 - raHours) * 60);
            
            output.innerText = `
            Target: Mars
            Year: ${year} (Jan 1)
            Mode: ${year < -2400 ? "High Precision (JPL)" : "Standard"}
            ------------------------------------
            Right Ascension: ${raHours}h ${raMin}m (${(ra/15).toFixed(4)} h)
            Declination:     ${dec.toFixed(4)}°
            Distance:        ${dist.toFixed(4)} AU
            `;
            status.innerText = "Success";
        }

    } catch (err) {
        console.error(err);
        output.innerText = "System Error: " + err.message;
        status.innerText = "Error";
    }
}