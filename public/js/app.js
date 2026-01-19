import SwissEph from './swisseph.js';

let swe = null;
let lastResults = []; 

// 1. INITIALIZATION
SwissEph({
    locateFile: (path) => {
        if (path.includes('js/')) return path;
        return `js/${path}`;
    }
}).then(module => {
    swe = module;
    updateStatus("Engine Online. Ready.");
    console.log("✅ Wasm Module Initialized");
});

// 2. API BRIDGE (Direct C-Calls)
const API = {
    julday: (year, month, day, hour, calFlag) => {
        return swe.ccall('swe_julday', 'number', 
            ['number', 'number', 'number', 'number', 'number'], 
            [year, month, day, hour, calFlag]
        );
    },
    calc_ut: (jd, body, flags) => {
        const resPtr = swe._malloc(48); // 6 doubles
        const errPtr = swe._malloc(256); // Error string
        try {
            const rc = swe.ccall('swe_calc_ut', 'number',
                ['number', 'number', 'number', 'number', 'number'],
                [jd, body, flags, resPtr, errPtr]
            );
            if (rc < 0) {
                return { rc, error: swe.UTF8ToString(errPtr) };
            }
            const data = [];
            for (let i = 0; i < 6; i++) {
                data.push(swe.HEAPF64[(resPtr >> 3) + i]);
            }
            return { rc, result: data };
        } finally {
            swe._free(resPtr); swe._free(errPtr);
        }
    },
    revjul: (jd, calFlag) => {
         const yrPtr = swe._malloc(4); const moPtr = swe._malloc(4);
         const dyPtr = swe._malloc(4); const utPtr = swe._malloc(8);
         try {
             swe.ccall('swe_revjul', null, 
                ['number', 'number', 'number', 'number', 'number', 'number'],
                [jd, calFlag, yrPtr, moPtr, dyPtr, utPtr]
             );
             return {
                 year: swe.HEAP32[yrPtr >> 2],
                 month: swe.HEAP32[moPtr >> 2],
                 day: swe.HEAP32[dyPtr >> 2],
                 hour: swe.HEAPF64[utPtr >> 3]
             };
         } finally {
             swe._free(yrPtr); swe._free(moPtr); swe._free(dyPtr); swe._free(utPtr);
         }
    },
    // CRITICAL FIX: Set the internal path to Root (/)
    set_ephe_path: (path) => {
        try {
            swe.ccall('swe_set_ephe_path', null, ['string'], [path]);
            console.log(`✅ Path forced to: ${path}`);
        } catch (e) {
            console.warn("Could not set path:", e);
        }
    }
};

// 3. SMART FILE MANAGER
async function ensureDataForYear(year, bodyId) {
    if (year >= -600) return; 

    // Determine Prefix: 'semo' (Moon) vs 'sepl' (Planets)
    const prefix = (bodyId === 1) ? 'semo' : 'sepl';
    const baseYear = Math.floor(year / 600) * 600;
    const century = Math.abs(baseYear / 100); 
    
    // Server file: sepl_m36.se1.bin
    const serverFilename = `${prefix}_m${century}.se1.bin`;
    // Engine file: seplm36.se1 (No underscore)
    const engineFilename = `${prefix}m${century}.se1`; 
    
    // Check if file exists in Virtual FS
    let exists = false;
    try { swe.FS.stat(`/${engineFilename}`); exists = true; } catch(e){}

    if (!exists) {
        updateStatus(`Downloading ${serverFilename}...`);
        
        try {
            // Fetch with timestamp to prevent caching old 404s
            const resp = await fetch(`assets/ephe/${serverFilename}?t=${Date.now()}`); 
            
            if (!resp.ok) {
                throw new Error(`HTTP Error ${resp.status} fetching ${serverFilename}`);
            }
            
            const buf = await resp.arrayBuffer();
            
            // SANITY CHECK: If file is tiny (<5KB), it's likely an HTML 404 page
            if (buf.byteLength < 5000) {
                throw new Error(`File is too small (${buf.byteLength} bytes). This is likely a 404 error page, not the binary file.`);
            }

            const data = new Uint8Array(buf);
            
            // Write to Root using the Engine's preferred name (No Underscore)
            swe.FS.writeFile(`/${engineFilename}`, data);
            
            console.log(`✅ Hydrated /${engineFilename} (${data.length} bytes)`);
            
        } catch (err) {
            throw new Error(`Download failed: ${err.message}`);
        }
    }
}

// 4. MAIN QUERY EXPORT
export async function runQuery() {
    if (!swe) { alert("Engine still loading..."); return; }

    const bodyId = parseInt(document.getElementById('bodySelect').value);
    const startY = parseInt(document.getElementById('startYear').value);
    const startM = parseInt(document.getElementById('startMonth').value);
    const startD = parseInt(document.getElementById('startDay').value);
    const count  = parseInt(document.getElementById('stepCount').value);
    const stepSz = parseFloat(document.getElementById('stepUnit').value);

    const tableBody = document.querySelector('#resultsTable tbody');
    tableBody.innerHTML = '<tr><td colspan="5">Calculating...</td></tr>';
    updateStatus("Computing...");
    lastResults = [];

    try {
        // A. Ensure File is Loaded
        await ensureDataForYear(startY, bodyId);
        
        // B. FORCE PATH TO ROOT (Fixes the "Path not found" error)
        API.set_ephe_path('/');

        // C. Loop
        const rows = [];
        const CAL_MODE = startY < 1582 ? 0 : 1; 
        let currentJD = API.julday(startY, startM, startD, 12, CAL_MODE);
        const FLAGS = 2 | 256 | 2048; 

        for (let i = 0; i < count; i++) {
            const data = API.calc_ut(currentJD, bodyId, FLAGS);
            
            if (data.rc < 0) {
                console.error(`JD ${currentJD} Error:`, data.error);
                rows.push({ 
                    date: "Error", jd: currentJD.toFixed(2), 
                    ra: data.error, dec: "", dist: "" 
                });
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
        const dlBtn = document.getElementById('dlBtn');
        if (dlBtn) dlBtn.disabled = false;
        updateStatus(`Done. Generated ${rows.length} steps.`);

    } catch (err) {
        console.error(err);
        updateStatus("Error: " + err.message);
        tableBody.innerHTML = `<tr><td colspan="5" style="color:red;text-align:center;">${err.message}</td></tr>`;
    }
}

// 5. CSV EXPORT
export function downloadCSV() {
    if (!lastResults.length) return;
    let csv = "Date,JD,RA_deg,Dec_deg,Dist_AU,RA_hms,Dec_dms\n";
    csv += lastResults.map(r => {
        if (r.date === "Error") return "";
        return `${r.date},${r.jd},${r.rawRA},${r.rawDec},${r.dist},"${r.ra}","${r.dec}"`;
    }).join("\n");
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "ephemeris_output.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// UTILS
function renderTable(rows) {
    const tbody = document.querySelector('#resultsTable tbody');
    tbody.innerHTML = rows.map(r => `
        <tr><td>${r.date}</td><td>${r.jd}</td><td>${r.ra}</td><td>${r.dec}</td><td>${r.dist}</td></tr>
    `).join('');
}
function updateStatus(msg) { const el = document.getElementById('status'); if(el) el.innerText = msg; }
function pad(n) { return n < 10 ? '0'+n : n; }
function formatHMS(deg) {
    const h = Math.floor(deg / 15);
    const m = Math.floor((deg / 15 - h) * 60);
    const s = ((deg / 15 - h - m/60) * 3600).toFixed(2);
    return `${pad(h)}h ${pad(m)}m ${pad(s)}s`;
}
function formatDMS(deg) {
    const sign = deg < 0 ? '-' : '+';
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const m = Math.floor((abs - d) * 60);
    const s = ((abs - d - m/60) * 3600).toFixed(2);
    return `${sign}${pad(d)}° ${pad(m)}' ${pad(s)}"`;
}