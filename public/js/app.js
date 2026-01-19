import SwissEph from './swisseph.js';

let swe = null;
let lastResults = []; 

// 1. Initialize
SwissEph({
    locateFile: (path) => {
        if (path.includes('js/')) return path;
        return `js/${path}`;
    }
}).then(module => {
    swe = module;
    try { swe.FS.mkdir('/ephe'); } catch(e) {} 
    updateStatus("Engine Online. Ready.");
    console.log("✅ Wasm Module Initialized");
});

// 2. API Bridge
const API = {
    julday: (year, month, day, hour, calFlag) => {
        return swe.ccall('swe_julday', 'number', ['number', 'number', 'number', 'number', 'number'], [year, month, day, hour, calFlag]);
    },
    calc_ut: (jd, body, flags) => {
        const resPtr = swe._malloc(48);
        const errPtr = swe._malloc(256);
        try {
            const rc = swe.ccall('swe_calc_ut', 'number', ['number', 'number', 'number', 'number', 'number'], [jd, body, flags, resPtr, errPtr]);
            if (rc < 0) return { rc, error: swe.UTF8ToString(errPtr) };
            const data = [];
            for (let i = 0; i < 6; i++) { data.push(swe.HEAPF64[(resPtr >> 3) + i]); }
            return { rc, result: data };
        } finally {
            swe._free(resPtr); swe._free(errPtr);
        }
    },
    revjul: (jd, calFlag) => {
         const yrPtr = swe._malloc(4); const moPtr = swe._malloc(4);
         const dyPtr = swe._malloc(4); const utPtr = swe._malloc(8);
         try {
             swe.ccall('swe_revjul', null, ['number', 'number', 'number', 'number', 'number', 'number'], [jd, calFlag, yrPtr, moPtr, dyPtr, utPtr]);
             return { year: swe.HEAP32[yrPtr >> 2], month: swe.HEAP32[moPtr >> 2], day: swe.HEAP32[dyPtr >> 2], hour: swe.HEAPF64[utPtr >> 3] };
         } finally {
             swe._free(yrPtr); swe._free(moPtr); swe._free(dyPtr); swe._free(utPtr);
         }
    },
    set_ephe_path: (path) => {
        try { swe.ccall('swe_set_ephe_path', null, ['string'], [path]); } catch (e) { console.error(e); }
    }
};

// 3. Robust File Downloader
async function ensureDataForYear(year, bodyId) {
    if (year >= -600) return; 

    const prefix = (bodyId === 1) ? 'semo' : 'sepl';
    const baseYear = Math.floor(year / 600) * 600;
    const century = Math.abs(baseYear / 100); 
    
    // Strict Filename (No underscores, as per your repo)
    const filename = `${prefix}m${century}.se1.bin`; 
    const vfsPath = `/ephe/${prefix}m${century}.se1`;
    
    // Check if loaded
    let exists = false;
    try { swe.FS.stat(vfsPath); exists = true; } catch(e){}

    if (!exists) {
        // STRATEGY: Try Standard Path -> Then Try "public/" Path
        const pathsToTry = [
            `assets/ephe/${filename}`,        // Standard
            `public/assets/ephe/${filename}`  // GitHub Pages Raw Repo Structure
        ];

        let buffer = null;
        let usedUrl = "";

        updateStatus(`Downloading ${filename}...`);

        for (const url of pathsToTry) {
            try {
                // Time-stamp to bust cache
                const resp = await fetch(`${url}?t=${Date.now()}`);
                if (resp.ok) {
                    const tempBuf = await resp.arrayBuffer();
                    if (tempBuf.byteLength > 5000) {
                        buffer = tempBuf;
                        usedUrl = url;
                        break; // Success!
                    }
                }
            } catch (e) { console.warn(`Failed fetch: ${url}`); }
        }

        if (!buffer) {
            throw new Error(`404 Not Found. Checked: ${pathsToTry.join(' AND ')}`);
        }

        // Save to engine memory
        swe.FS.writeFile(vfsPath, new Uint8Array(buffer));
        console.log(`✅ Loaded from ${usedUrl}`);
    }
}

// 4. Main Query
export async function runQuery() {
    if (!swe) { alert("Engine still loading..."); return; }

    const bodyId = parseInt(document.getElementById('bodySelect').value);
    const startY = parseInt(document.getElementById('startYear').value);
    const startM = parseInt(document.getElementById('startMonth').value);
    const startD = parseInt(document.getElementById('startDay').value);
    const count  = parseInt(document.getElementById('stepCount').value);
    const stepSz = parseFloat(document.getElementById('stepUnit').value);

    updateStatus("Computing...");
    lastResults = [];

    try {
        await ensureDataForYear(startY, bodyId);
        API.set_ephe_path('/ephe');

        const rows = [];
        const CAL_MODE = startY < 1582 ? 0 : 1; 
        let currentJD = API.julday(startY, startM, startD, 12, CAL_MODE);
        const FLAGS = 2 | 256 | 2048; 

        for (let i = 0; i < count; i++) {
            const data = API.calc_ut(currentJD, bodyId, FLAGS);
            if (data.rc < 0) {
                rows.push({ date: "Error", jd: currentJD.toFixed(2), ra: data.error, dec: "", dist: "" });
            } else {
                const [ra, dec, dist] = data.result;
                const dateObj = API.revjul(currentJD, CAL_MODE);
                const dateStr = `${dateObj.year}-${pad(dateObj.month)}-${pad(dateObj.day)}`;
                const rowData = {
                    date: dateStr, jd: currentJD.toFixed(2),
                    ra: formatHMS(ra), dec: formatDMS(dec), dist: dist.toFixed(5),
                    rawRA: ra, rawDec: dec
                };
                rows.push(rowData);
                lastResults.push(rowData);
            }
            currentJD += stepSz;
        }

        renderTable(rows);
        document.getElementById('dlBtn').disabled = false;
        updateStatus(`Done. Generated ${rows.length} steps.`);

    } catch (err) {
        console.error(err);
        updateStatus("Error: " + err.message);
    }
}

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