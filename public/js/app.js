import SwissEph from './swisseph.js';

let swe = null;
let lastResults = []; // Store data for CSV download

// --- INITIALIZATION ---
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

// --- MANUAL API BRIDGE (The Fix for 'is not a function') ---
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
         // Helper to convert JD back to Date for table display
         // void swe_revjul(double jd, int gregflag, int *jyear, int *jmon, int *jday, double *jut);
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

// --- MAIN QUERY FUNCTION ---
export async function runQuery() {
    if (!swe) { alert("Engine loading..."); return; }

    // 1. Get Inputs
    const bodyId = parseInt(document.getElementById('bodySelect').value);
    const startY = parseInt(document.getElementById('startYear').value);
    const startM = parseInt(document.getElementById('startMonth').value);
    const startD = parseInt(document.getElementById('startDay').value);
    const count  = parseInt(document.getElementById('stepCount').value);
    const stepSz = parseFloat(document.getElementById('stepUnit').value); // In Days

    const tableBody = document.querySelector('#resultsTable tbody');
    tableBody.innerHTML = '<tr><td colspan="5">Calculating...</td></tr>';
    updateStatus("Computing...");

    lastResults = []; // Clear previous CSV data

    try {
        // 2. Hydrate Logic (Check if we need ancient files)
        // If query touches 3000 BC - 2400 BC range
        if (startY < -2400 && startY >= -3000) {
            await hydrateFile('sepl_m30.se1');
        }

        // 3. Calculation Loop
        const rows = [];
        const SE_JUL_CAL = 0; // Use Julian Calendar for simplicity in ancient times
        const SE_GREG_CAL = 1;
        const CAL_MODE = startY < 1582 ? SE_JUL_CAL : SE_GREG_CAL; // Auto-switch roughly

        // Calculate Start JD
        let currentJD = API.julday(startY, startM, startD, 12, CAL_MODE); // Noon

        const FLAGS = 2 | 256 | 2048; // SWIEPH | SPEED | EQUATORIAL

        for (let i = 0; i < count; i++) {
            // A. Compute
            const data = API.calc_ut(currentJD, bodyId, FLAGS);
            
            if (data.rc < 0) {
                console.error("Calc Error", data);
                continue;
            }

            // B. Format Data
            const [ra, dec, dist] = data.result;
            const dateObj = API.revjul(currentJD, CAL_MODE);
            
            const raStr = formatHMS(ra);
            const decStr = formatDMS(dec);
            
            // C. Store
            const rowData = {
                date: `${dateObj.year}-${pad(dateObj.month)}-${pad(dateObj.day)}`,
                jd: currentJD.toFixed(2),
                ra: raStr,
                dec: decStr,
                dist: dist.toFixed(5)
            };
            rows.push(rowData);
            lastResults.push(rowData);

            // D. Increment Time
            currentJD += stepSz;
        }

        // 4. Render Table
        renderTable(rows);
        document.getElementById('dlBtn').disabled = false;
        updateStatus(`Done. Generated ${rows.length} ephemeris steps.`);

    } catch (err) {
        console.error(err);
        updateStatus("Error: " + err.message);
        tableBody.innerHTML = `<tr><td colspan="5" style="color:red">Error: ${err.message}</td></tr>`;
    }
}

// --- HYDRATION HELPER ---
async function hydrateFile(filename) {
    const vfsPath = `/${filename}`;
    let exists = false;
    try { swe.FS.stat(vfsPath); exists = true; } catch(e){}
    
    if (!exists) {
        updateStatus(`Downloading high-precision file: ${filename}...`);
        const resp = await fetch(`assets/ephe/${filename}.bin`);
        if (!resp.ok) throw new Error("Could not fetch ephemeris file.");
        const buf = await resp.arrayBuffer();
        swe.FS.writeFile(vfsPath, new Uint8Array(buf));
        console.log(`Hydrated ${filename}`);
    }
}

// --- UTILS ---
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

export function downloadCSV() {
    if (!lastResults.length) return;
    let csv = "Date,JD,RA,Dec,Dist_AU\n";
    csv += lastResults.map(r => 
        `${r.date},${r.jd},"${r.ra}","${r.dec}",${r.dist}`
    ).join("\n");
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "ephemeris_output.csv";
    a.click();
}

function updateStatus(msg) {
    const el = document.getElementById('status');
    if(el) el.innerText = msg;
}

function pad(n) { return n < 10 ? '0'+n : n; }

// Convert Degrees to Hours:Minutes:Seconds
function formatHMS(deg) {
    const h = Math.floor(deg / 15);
    const m = Math.floor((deg / 15 - h) * 60);
    const s = ((deg / 15 - h - m/60) * 3600).toFixed(2);
    return `${pad(h)}h ${pad(m)}m ${pad(s)}s`;
}

// Convert Degrees to Degrees:Minutes:Seconds
function formatDMS(deg) {
    const sign = deg < 0 ? '-' : '+';
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const m = Math.floor((abs - d) * 60);
    const s = ((abs - d - m/60) * 3600).toFixed(2);
    return `${sign}${pad(d)}° ${pad(m)}' ${pad(s)}"`;
}