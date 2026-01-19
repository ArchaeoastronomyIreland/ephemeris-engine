import SwissEph from './swisseph.js';

// GLOBAL STATE
let swe = null;
let lastResults = [];

/**
 * 1. INITIALIZATION
 * This loads the WASM module and sets the internal path ONCE.
 */
SwissEph({
    locateFile: (path) => path.includes('js/') ? path : `js/${path}`
}).then(module => {
    swe = module;
    
    // CRITICAL: Set the internal search path to the Virtual Root (/)
    // The engine will now ONLY look in the root of its virtual memory.
    // We do this once, on startup.
    try {
        swe.ccall('swe_set_ephe_path', null, ['string'], ['/']);
        console.log("✅ Engine Configured: Path set to Virtual Root (/)");
    } catch (e) {
        console.error("❌ Engine Path Config Failed:", e);
    }
    
    updateStatus("Engine Online. Ready.");
});

// 2. API BRIDGE (Direct mapping to C functions)
const API = {
    julday: (y, m, d, h, flag) => swe.ccall('swe_julday', 'number', ['number','number','number','number','number'], [y, m, d, h, flag]),
    
    calc_ut: (jd, body, flags) => {
        const resPtr = swe._malloc(48);
        const errPtr = swe._malloc(256);
        try {
            const rc = swe.ccall('swe_calc_ut', 'number', ['number','number','number','number','number'], [jd, body, flags, resPtr, errPtr]);
            if (rc < 0) return { rc, error: swe.UTF8ToString(errPtr) };
            const data = [];
            for (let i = 0; i < 6; i++) data.push(swe.HEAPF64[(resPtr >> 3) + i]);
            return { rc, result: data };
        } finally {
            swe._free(resPtr); swe._free(errPtr);
        }
    },
    
    revjul: (jd, flag) => {
         const yr=swe._malloc(4), mo=swe._malloc(4), dy=swe._malloc(4), ut=swe._malloc(8);
         try {
             swe.ccall('swe_revjul', null, ['number','number','number','number','number','number'], [jd, flag, yr, mo, dy, ut]);
             return { year: swe.HEAP32[yr>>2], month: swe.HEAP32[mo>>2], day: swe.HEAP32[dy>>2] };
         } finally {
             swe._free(yr); swe._free(mo); swe._free(dy); swe._free(ut);
         }
    }
};

/**
 * 3. DATA MANAGER
 * Handles the transfer from GitHub (Server) to WASM (Memory).
 */
async function ensureDataForYear(year, bodyId) {
    if (year >= -600) return; // Standard range doesn't need files

    // 1. Determine Century (e.g., -3500 -> 36)
    const baseYear = Math.floor(year / 600) * 600;
    const century = Math.abs(baseYear / 100); 

    // 2. Determine Filenames based on Body Type
    // Moon (id 1) = 'semo', Planets = 'sepl'
    const prefix = (bodyId === 1) ? 'semo' : 'sepl';
    
    // SERVER FILE: Your repo uses NO underscores and .bin extension
    // Example: seplm36.se1.bin
    const serverName = `${prefix}m${century}.se1.bin`;
    
    // ENGINE FILE: The engine expects standard name (NO .bin)
    // Example: seplm36.se1
    const engineName = `${prefix}m${century}.se1`;

    // 3. Check Virtual Memory
    // We look in the Root (/) because that is where we configured the engine to look.
    let exists = false;
    try { swe.FS.stat(`/${engineName}`); exists = true; } catch(e){}

    if (!exists) {
        // 4. Download from GitHub
        // Path is relative to index.html -> assets/ephe/
        const url = `assets/ephe/${serverName}`;
        updateStatus(`Downloading data: ${serverName}...`);
        
        try {
            const resp = await fetch(`${url}?t=${Date.now()}`); // timestamp prevents caching
            if (!resp.ok) throw new Error(`HTTP ${resp.status} - File not found: ${url}`);
            
            const buf = await resp.arrayBuffer();
            
            // Sanity Check: 404 pages are small (<5KB), valid binary files are large (~100KB+)
            if (buf.byteLength < 5000) throw new Error("File too small. Likely a 404 HTML page.");

            // 5. Write to Virtual Memory
            // We strip the .bin extension here so the engine sees what it expects
            swe.FS.writeFile(`/${engineName}`, new Uint8Array(buf));
            console.log(`✅ File Hydrated: ${url} -> /${engineName}`);
            
        } catch (err) {
            console.error(err);
            throw new Error(`Failed to load ${serverName}. Ensure it exists in 'public/assets/ephe/' on GitHub.`);
        }
    }
}

// 4. MAIN QUERY LOGIC
export async function runQuery() {
    if (!swe) { alert("Engine initializing..."); return; }

    // Inputs
    const bodyId = parseInt(document.getElementById('bodySelect').value);
    const startY = parseInt(document.getElementById('startYear').value);
    const startM = parseInt(document.getElementById('startMonth').value);
    const startD = parseInt(document.getElementById('startDay').value);
    const count  = parseInt(document.getElementById('stepCount').value);
    const stepSz = parseFloat(document.getElementById('stepUnit').value);

    updateStatus("Computing...");
    lastResults = [];

    try {
        // Step A: Ensure file is in memory
        await ensureDataForYear(startY, bodyId);
        
        // Step B: Calculation Loop
        const rows = [];
        const CAL_MODE = startY < 1582 ? 0 : 1; // Julian vs Gregorian
        let currentJD = API.julday(startY, startM, startD, 12, CAL_MODE);
        const FLAGS = 2 | 256 | 2048; // SwissEph | Speed | Equator

        for (let i = 0; i < count; i++) {
            const data = API.calc_ut(currentJD, bodyId, FLAGS);
            
            if (data.rc < 0) {
                console.error(`Calculation Error at JD ${currentJD}: ${data.error}`);
                rows.push({ date: "Error", jd: currentJD.toFixed(2), ra: data.error, dec: "", dist: "" });
            } else {
                const [ra, dec, dist] = data.result;
                const dateObj = API.revjul(currentJD, CAL_MODE);
                const dateStr = `${dateObj.year}-${pad(dateObj.month)}-${pad(dateObj.day)}`;
                
                const rowData = {
                    date: dateStr, 
                    jd: currentJD.toFixed(2),
                    ra: formatHMS(ra), 
                    dec: formatDMS(dec), 
                    dist: dist.toFixed(5),
                    rawRA: ra, rawDec: dec
                };
                rows.push(rowData);
                lastResults.push(rowData);
            }
            currentJD += stepSz;
        }

        renderTable(rows);
        document.getElementById('dlBtn').disabled = false;
        updateStatus(`Success. Generated ${rows.length} steps.`);

    } catch (err) {
        document.querySelector('#resultsTable tbody').innerHTML = 
            `<tr><td colspan="5" style="color:red; text-align:center;">
                <strong>System Error:</strong> ${err.message}
            </td></tr>`;
        updateStatus("Error.");
    }
}

// UTILITIES
export function downloadCSV() {
    if (!lastResults.length) return;
    let csv = "Date,JD,RA,Dec,Dist\n" + lastResults.map(r => `${r.date},${r.jd},"${r.ra}","${r.dec}",${r.dist}`).join("\n");
    const a = document.createElement('a');
    a.href = window.URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = "ephemeris.csv";
    a.click();
}
function renderTable(rows) {
    document.querySelector('#resultsTable tbody').innerHTML = rows.map(r => `<tr><td>${r.date}</td><td>${r.jd}</td><td>${r.ra}</td><td>${r.dec}</td><td>${r.dist}</td></tr>`).join('');
}
function updateStatus(msg) { const el = document.getElementById('status'); if(el) el.innerText = msg; }
function pad(n) { return n < 10 ? '0'+n : n; }
function formatHMS(deg) { const h=Math.floor(deg/15), m=Math.floor((deg/15-h)*60), s=((deg/15-h-m/60)*3600).toFixed(2); return `${pad(h)}h ${pad(m)}m ${pad(s)}s`; }
function formatDMS(deg) { const a=Math.abs(deg), d=Math.floor(a), m=Math.floor((a-d)*60), s=((a-d-m/60)*3600).toFixed(2); return `${deg<0?'-':'+'}${pad(d)}° ${pad(m)}' ${pad(s)}"`; }