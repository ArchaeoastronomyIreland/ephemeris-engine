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
    if (status) status.innerText = "Engine Online (Raw Mode).";
    console.log("✅ Wasm Module Initialized");
});

// --- HELPER: The "Bridge" functions ---
// These manually talk to the raw C-functions you found in the logs
const API = {
    // Wraps _swe_julday (Index 46 in your log)
    julday: (year, month, day, hour, calendarFlag) => {
        // ccall invokes the C function safely
        return swe.ccall('swe_julday', 'number', 
            ['number', 'number', 'number', 'number', 'number'], 
            [year, month, day, hour, calendarFlag]
        );
    },

    // Wraps _swe_calc_ut (Index 23 in your log)
    // This is complex because C expects Pointers (*xx, *serr), not arrays
    calc_ut: (julianDay, planetId, flags) => {
        // 1. Allocate Memory in Wasm Heap
        // We need 6 doubles (6 * 8 bytes = 48 bytes) for coordinates
        const resultPtr = swe._malloc(48); 
        // We need 256 bytes for possible error strings
        const errorPtr = swe._malloc(256);

        try {
            // 2. Call the C function
            // int swe_calc_ut(double tjd, int ipl, int iflag, double *xx, char *serr);
            const returnCode = swe.ccall('swe_calc_ut', 'number',
                ['number', 'number', 'number', 'number', 'number'],
                [julianDay, planetId, flags, resultPtr, errorPtr]
            );

            // 3. Read Results back from Heap
            // HEAPF64 is the view of memory as Doubles
            // We divide pointer by 8 because it's a byte-offset
            const data = [];
            for (let i = 0; i < 6; i++) {
                data.push(swe.HEAPF64[(resultPtr >> 3) + i]);
            }
            
            // (Optional: Read error string from errorPtr if returnCode < 0)

            return { rc: returnCode, result: data };

        } finally {
            // 4. ALWAYS Free memory to prevent leaks
            swe._free(resultPtr);
            swe._free(errorPtr);
        }
    }
};

export async function runCalculation() {
    if (!swe) {
        alert("Engine still loading...");
        return;
    }

    const yearInput = document.getElementById('yearInput');
    const output = document.getElementById('output');
    const status = document.getElementById('status');
    const year = parseInt(yearInput.value) || -2500;

    try {
        status.innerText = "⏳ Processing...";
        output.innerText = "Hydrating & Calculating...";

        // --- 1. DATA HYDRATION ---
        if (year < -2400 && year >= -3000) {
            const filename = 'sepl_m30.se1';
            const vfsPath = `/${filename}`; // Root path
            
            // Check existence
            let fileExists = false;
            try { swe.FS.stat(vfsPath); fileExists = true; } catch(e) {}

            if (!fileExists) {
                status.innerText = `⏳ Downloading ${filename}...`;
                const resp = await fetch(`assets/ephe/${filename}.bin`);
                if (!resp.ok) throw new Error("File not found on server");
                const buffer = await resp.arrayBuffer();
                
                // Write to Virtual File System
                swe.FS.writeFile(vfsPath, new Uint8Array(buffer));
                console.log(`✅ Hydrated ${filename}`);
            }
        }

        // --- 2. CALCULATION (Using our Manual Bridge) ---
        
        // Define Constants (Hardcoded from C header)
        const SE_JUL_CAL = 0;
        const SE_MARS = 4;
        const SEFLG_SWIEPH = 2;
        const SEFLG_SPEED = 256;
        const SEFLG_EQUATORIAL = 2048; 

        // A. Calculate Julian Day
        const jd = API.julday(year, 1, 1, 12, SE_JUL_CAL);
        
        // B. Calculate Position
        const flags = SEFLG_SWIEPH | SEFLG_EQUATORIAL | SEFLG_SPEED;
        const data = API.calc_ut(jd, SE_MARS, flags);

        // --- 3. OUTPUT ---
        if (data.rc < 0) {
            output.innerText = `Calculation Error (Code ${data.rc})`;
        } else {
            const [ra, dec, dist] = data.result;
            
            // Simple Formatting
            const raH = Math.floor(ra / 15);
            const raM = Math.floor((ra / 15 - raH) * 60);

            output.innerText = `
            Target: Mars
            Year: ${year}
            JD: ${jd}
            --------------------
            RA:  ${raH}h ${raM}m (${(ra/15).toFixed(5)})
            Dec: ${dec.toFixed(5)}°
            Dist: ${dist.toFixed(5)} AU
            `;
            status.innerText = "Success.";
        }

    } catch (err) {
        console.error(err);
        output.innerText = "Error: " + err.message;
    }
}