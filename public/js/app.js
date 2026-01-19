import SwissEph from './swisseph.js';

let swe = null;
let lastResults = []; // Store data for CSV download

// --- INITIALIZATION ---
SwissEph({
    locateFile: (path) => {
        // Ensure wasm is found in js/ folder
        if (path.includes('js/')) return path;
        return `js/${path}`;
    }
}).then(module => {
    swe = module;
    updateStatus("Engine Online. Ready.");
    console.log("✅ Wasm Module Initialized");
});

// --- MANUAL API BRIDGE (Raw C-Call Wrappers) ---
const API = {
    julday: (year, month, day, hour, calFlag) => {
        return swe.ccall('swe_julday', 'number', 
            ['number', 'number', 'number', 'number', 'number'], 
            [year, month, day, hour, calFlag]
        );
    },
    calc_ut: (jd, body, flags) => {
        const resPtr = swe._malloc(48); // 6 doubles (8 bytes each)
        const errPtr = swe._malloc(256); // Error string buffer
        try {
            const rc = swe.ccall('swe_calc_ut', 'number',
                ['number', 'number', 'number', 'number', 'number'],
                [jd, body, flags, resPtr, errPtr]
            );
            
            // Handle Errors
            if (rc < 0) {
                const errorMsg = swe.UTF8ToString(errPtr);
                return { rc, error: errorMsg };
            }

            // Extract Results
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
         // Convert JD back to Calendar Date
         const yrPtr = swe._malloc(4);
         const moPtr = swe._malloc(4);
         const dyPtr = swe._malloc(4);
         const utPtr = swe._malloc(8);
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

// --- SMART FILE MANAGER ---
async function ensureDataForYear(year) {
    // Only needed for ancient dates (before -600)
    if (year >= -600) return;

    // Calculate start century of the required file (e.g., -3500 -> sepl_m36)
    // Formula: Floor(Year/600)*600.  Ex: -3500 -> -3600 -> m36
    const baseYear = Math.floor(year / 600) * 600;
    const century = Math.abs(baseYear / 100); 
    const filename = `sepl_m${century}.se1`; 
    
    // Check if file exists in Virtual File System (Root)
    const vfsPath = `/${filename}`;
    let exists = false;
    try { swe.FS.stat(vfsPath); exists = true; } catch(e){}

    if (!exists) {
        updateStatus(`Downloading data file: ${filename}...`);
        
        try {
            // Note: Ensure your server has .bin extensions for these files
            const resp = await fetch(`assets/ephe/${filename}.bin`); 
            if (!resp.ok) {
                throw new Error(`Server missing file: assets/ephe/${filename}.bin`);
            }
            const buf = await resp.arrayBuffer();
            swe.FS.writeFile(vfsPath, new Uint8Array(buf));
            console.log(`✅ Hydrated ${filename} to ${vfsPath}`);
        } catch (err) {
            throw new Error(`Data download failed: ${err.message}`);
        }
    }
}

// --- MAIN QUERY EXPORT ---
export async function runQuery() {
    if (!swe) { alert("Engine still loading..."); return; }

    // 1. Get Inputs
    const bodyId = parseInt(document.getElementById('bodySelect').value);
    const startY = parseInt(document.getElementById('startYear').value);
    const startM = parseInt(document.getElementById('startMonth').value);
    const startD = parseInt(document.getElementById('startDay').value);
    const count  = parseInt(document.getElementById('stepCount').value);
    const stepSz = parseFloat(document.getElementById('stepUnit').value);

    const tableBody = document.querySelector('#resultsTable tbody');
    tableBody.innerHTML = '<tr><td colspan="5">Calculating...</td></tr>';
    updateStatus("Computing...");

    lastResults = []; // Clear for CSV

    try {
        // 2. Load Ancient Data if needed
        await ensureDataForYear(startY);

        // 3. Calculation Loop
        const rows = [];
        const SE_JUL_CAL = 0; 
        const SE_GREG_CAL = 1;
        // Simple calendar switch (Gregorian reform 1582)
        const CAL_MODE = startY < 1582 ? SE_JUL_CAL : SE_GREG_CAL; 

        // Initial Julian Day
        let currentJD = API.julday(startY, startM, startD, 12, CAL_MODE);

        // Flags: SwissEph + Speed + Equatorial + Topocentric (optional)
        const FLAGS = 2 | 256 | 2048; 

        for (let i = 0; i < count; i++) {
            // Calculate
            const data = API.calc_ut(currentJD, bodyId, FLAGS);
            
            if (data.rc < 0) {
                console.error(`Calc Error at JD ${currentJD}:`, data.error);
                // Append error row but keep going
                rows.push({
                    date: "Error", jd: currentJD.toFixed(2), 
                    ra: data.error, dec: "", dist: "" 
                });
                continue;
            }

            // Format
            const [ra, dec, dist] = data.result;
            const dateObj = API.revjul(currentJD, CAL_MODE);
            
            const raStr = formatHMS(ra);
            const decStr = formatDMS(dec);
            const dateStr = `${dateObj.year}-${pad(dateObj.month)}-${pad(dateObj.day)}`;

            // Store
            const rowData = {
                date: dateStr,
                jd: currentJD.toFixed(2),
                ra: raStr,
                dec: decStr,
                dist: dist.toFixed(5),
                // Raw values for CSV
                rawRA: ra, rawDec: dec
            };
            rows.push(rowData);
            lastResults.push(rowData);

            // Next Step
            currentJD += stepSz;
        }

        // 4. Render
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

// --- CSV EXPORT ---
export function downloadCSV() {
    if (!lastResults.length) return;
    
    let csv = "Date,JD,RA_(deg),Dec_(deg),Dist_(AU),RA_(hms),Dec_(dms)\n";
    
    csv += lastResults.map(r => {
        if (r.date === "Error") return "";
        return `${r.date},${r.jd},${r.rawRA},${r.rawDec},${r.dist},"${r.ra}","${r.dec}"`;
    }).join("\n");
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "ephemeris_output.csv";
    document.body.appendChild(a); // Required for Firefox
    a.click();
    document.body.removeChild(a);
}

// --- UTILITIES ---
function renderTable(rows) {
    const tbody = document.querySelector('#resultsTable tbody');
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${r.date}</td>
            <td>${r.jd}</td>
            <td>${r.ra}</td>
            <td>${r.dec}</td>
            <td>${r.dist}</td>
        </tr>
    `).join('');
}

function updateStatus(msg) {
    const el = document.getElementById('status');
    if(el) el.innerText = msg;
}

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