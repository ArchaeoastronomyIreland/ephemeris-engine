import SwissEph from './swisseph.js';

let swe = null;

// 1. INITIALIZE & SET PATH
SwissEph({
    locateFile: (path) => path.includes('js/') ? path : `js/${path}`
}).then(module => {
    swe = module;
    // Force path to Root (/) immediately
    try { swe.ccall('swe_set_ephe_path', null, ['string'], ['/']); } catch(e){}
    updateStatus("Engine Online.");
    console.log("✅ Wasm Module Initialized");
});

// 2. API BRIDGE
const API = {
    julday: (y, m, d, h, f) => swe.ccall('swe_julday', 'number', ['number','number','number','number','number'], [y, m, d, h, f]),
    
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
    
    revjul: (jd, f) => {
         const yr=swe._malloc(4), mo=swe._malloc(4), dy=swe._malloc(4), ut=swe._malloc(8);
         try {
             swe.ccall('swe_revjul', null, ['number','number','number','number','number','number'], [jd, f, yr, mo, dy, ut]);
             return { year: swe.HEAP32[yr>>2], month: swe.HEAP32[mo>>2], day: swe.HEAP32[dy>>2] };
         } finally {
             swe._free(yr); swe._free(mo); swe._free(dy); swe._free(ut);
         }
    }
};

// 3. DATA MANAGER (STRICTLY NO UNDERSCORES)
async function ensureDataForYear(year, bodyId) {
    if (year >= -600) return; 

    // Constants
    const prefix = (bodyId === 1) ? 'semo' : 'sepl';
    const baseYear = Math.floor(year / 600) * 600;
    const century = Math.abs(baseYear / 100); 

    // TARGET NAME: semom36.se1 (No underscore, No .bin)
    // This is what the engine is asking for in your logs.
    const engineName = `${prefix}m${century}.se1`;
    
    // SERVER NAME: semom36.se1.bin (No underscore, Has .bin)
    // This is what you confirmed is on the server.
    const serverName = `${prefix}m${century}.se1.bin`;
    
    const url = `assets/ephe/${serverName}`;
    
    // Check if we already have it in Root
    let exists = false;
    try { swe.FS.stat(`/${engineName}`); exists = true; } catch(e){}

    if (!exists) {
        updateStatus(`Downloading ${serverName}...`);
        
        try {
            const resp = await fetch(`${url}?t=${Date.now()}`);
            if (!resp.ok) throw new Error(`404 Not Found: ${url}`);
            
            const buf = await resp.arrayBuffer();
            if (buf.byteLength < 5000) throw new Error("File too small.");

            // Write to Root (/) using the name the engine wants
            swe.FS.writeFile(`/${engineName}`, new Uint8Array(buf));
            console.log(`✅ Loaded ${url} -> /${engineName}`);
            
        } catch (err) {
            document.querySelector('#resultsTable tbody').innerHTML = 
                `<tr><td colspan="5" style="color:red; font-weight:bold;">FAILED: ${serverName}</td></tr>`;
            throw err;
        }
    }
}

// 4. MAIN QUERY
export async function runQuery() {
    if (!swe) { alert("Engine initializing..."); return; }

    const bodyId = parseInt(document.getElementById('bodySelect').value);
    const startY = parseInt(document.getElementById('startYear').value);
    const startM = parseInt(document.getElementById('startMonth').value);
    const startD = parseInt(document.getElementById('startDay').value);
    const count  = parseInt(document.getElementById('stepCount').value);
    const stepSz = parseFloat(document.getElementById('stepUnit').value);

    updateStatus("Computing...");
    let lastResults = [];

    try {
        await ensureDataForYear(startY, bodyId);
        
        // RE-FORCE PATH TO ROOT (Fixes the "Moon First" issue)
        try { swe.ccall('swe_set_ephe_path', null, ['string'], ['/']); } catch(e){}

        const rows = [];
        const CAL_MODE = startY < 1582 ? 0 : 1; 
        let currentJD = API.julday(startY, startM, startD, 12, CAL_MODE);
        const FLAGS = 2 | 256 | 2048; 

        for (let i = 0; i < count; i++) {
            const data = API.calc_ut(currentJD, bodyId, FLAGS);
            
            if (data.rc < 0) {
                console.error(`JD ${currentJD} Error:`, data.error);
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
        window.lastResults = lastResults;
        document.getElementById('dlBtn').disabled = false;
        updateStatus(`Done. Generated ${rows.length} steps.`);

    } catch (err) {
        console.error(err);
        updateStatus("Error: " + err.message);
    }
}

export function downloadCSV() {
    if (!window.lastResults || !window.lastResults.length) return;
    let csv = "Date,JD,RA,Dec,Dist\n" + window.lastResults.map(r => `${r.date},${r.jd},"${r.ra}","${r.dec}",${r.dist}`).join("\n");
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