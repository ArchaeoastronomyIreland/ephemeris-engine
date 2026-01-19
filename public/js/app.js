import SwissEph from './swisseph.js';

let swe = null;
let lastResults = []; // Store results for CSV export

// --- 1. INITIALIZATION ---
SwissEph({
    locateFile: (path) => {
        // Ensure Wasm is loaded from the correct folder
        if (path.includes('js/')) return path;
        return `js/${path}`;
    }
}).then(module => {
    swe = module;
    updateStatus("Engine Online. Ready.");
    console.log("✅ Wasm Module Initialized");
});

// --- 2. MANUAL API BRIDGE (The Fix for 'is not a function') ---
// This talks directly to the C-code in memory
const API = {
    julday: (year, month, day, hour, calFlag) => {
        return swe.ccall('swe_julday', 'number', 
            ['number', 'number', 'number', 'number', 'number'], 
            [year, month, day, hour, calFlag]
        );
    },
    calc_ut: (jd, body, flags) => {
        const resPtr = swe._malloc(48); // Allocate 6 doubles
        const errPtr = swe._malloc(256); // Allocate error string
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
            swe._free(resPtr);
            swe._free(errPtr);
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
    }
};

// --- 3. SMART FILE MANAGER (Fixes the "seplm36" vs "sepl_m36" crash) ---
async function ensureDataForYear(year) {
    if (year >= -600) return; // Standard data covers modern era

    // Calculate filename century (e.g. -3500 -> "m36")
    const baseYear = Math.floor(year / 600) * 600;
    const century = Math.abs(baseYear / 100); 
    
    // Server file must be named: sepl_m36.se1.bin
    const serverFilename = `sepl_m${century}.se1.bin`;
    
    // Engine might look for underscore OR no underscore. We fix both.
    const vfsName1 = `sepl_m${century}.se1`;
    const vfsName2 = `seplm${century}.se1`; 
    
    let exists = false;
    try { swe.FS.stat(`/${vfsName1}`); exists = true; } catch(e){}
    try { swe.FS.stat(`/${vfsName2}`); exists = true; } catch(e){}

    if (!exists) {
        updateStatus(`Downloading ancient data: ${serverFilename}...`);
        
        try {
            const resp = await fetch(`assets/ephe/${serverFilename}`); 
            if (!resp.ok) {
                throw new Error(`Server missing file: assets/ephe/${serverFilename}`);
            }
            const buf = await resp.arrayBuffer();
            const data = new Uint8Array(buf);
            
            // DOUBLE SAVE FIX: Write to both possible filenames
            swe.FS.writeFile(`/${vfsName1}`, data);
            swe.FS.writeFile(`/${vfsName2}`, data);
            
            console.log(`✅ Hydrated VFS: /${vfsName1} and /${vfsName2}`);
        } catch (err) {
            throw new Error(`Data fetch failed: ${err.message}`);
        }
    }
}

// --- 4. EXPORT: Run Query ---
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
        await ensureDataForYear(startY);

        const rows = [];
        const CAL_MODE = startY < 1582 ? 0 : 1; // Julian vs Gregorian switch
        
        let currentJD = API.julday(startY, startM, startD, 12, CAL_MODE);
        const FLAGS = 2 | 256 | 2048; // SwissEph | Speed | Equatorial

        for (let i = 0; i < count; i++) {
            const data = API.calc_ut(currentJD, bodyId, FLAGS);
            
            if (data.rc < 0) {
                console.error(`Error at JD ${currentJD}:`, data.error);
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
        
        // Enable CSV button
        const dlBtn = document.getElementById('dlBtn');
        if (dlBtn) dlBtn.disabled = false;
        
        updateStatus(`Done. Generated ${rows.length} steps.`);

    } catch (err) {
        console.error(err);
        updateStatus("Error: " + err.message);
        tableBody.innerHTML = `<tr><td colspan="5" style="color:red;text-align:center;">${err.message}</td></tr>`;
    }
}

// --- 5. EXPORT: Download CSV ---
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

// --- Utils ---
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