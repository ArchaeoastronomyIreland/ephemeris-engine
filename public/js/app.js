import SwissEph from './swisseph.js';

let swe = null;

// 1. INITIALIZE
SwissEph({
    locateFile: (path) => path.includes('js/') ? path : `js/${path}`
}).then(module => {
    swe = module;
    // Set internal path to Root (/) immediately
    try { swe.ccall('swe_set_ephe_path', null, ['string'], ['/']); } catch(e){}
    updateStatus("Engine Online.");
    console.log("✅ Wasm Module Initialized");
});

// 2. API BRIDGE (Extended for Topocentric & Horizon)
const API = {
    julday: (y, m, d, h, f) => swe.ccall('swe_julday', 'number', ['number','number','number','number','number'], [y, m, d, h, f]),
    
    // Standard calc (we will use this to get the base position)
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

    // Set Observer Location (Long, Lat, HeightMeters)
    set_topo: (lon, lat, alt) => {
        swe.ccall('swe_set_topo', null, ['number','number','number'], [lon, lat, alt]);
    },

    // Transform to Azimuth/Altitude with Refraction
    azalt: (jd, calc_flag, geopos, atpress, attemp, xin) => {
        // Pointers for input/output arrays
        const geoPtr = swe._malloc(24); // 3 doubles (lon, lat, height)
        const xinPtr = swe._malloc(24); // 3 doubles (RA, Dec, Dist) OR (Lon, Lat, Dist)
        const xoutPtr = swe._malloc(24); // 3 doubles output (Az, TrueAlt, AppAlt)

        try {
            // Fill Observer Array
            swe.HEAPF64[(geoPtr >> 3) + 0] = geopos[0];
            swe.HEAPF64[(geoPtr >> 3) + 1] = geopos[1];
            swe.HEAPF64[(geoPtr >> 3) + 2] = geopos[2];

            // Fill Object Position Array (From calc_ut)
            swe.HEAPF64[(xinPtr >> 3) + 0] = xin[0]; // RA
            swe.HEAPF64[(xinPtr >> 3) + 1] = xin[1]; // Dec
            swe.HEAPF64[(xinPtr >> 3) + 2] = xin[2]; // Dist

            // Call C Function
            // void swe_azalt(double tjd_ut, int32 calc_flag, double *geopos, double atpress, double attemp, double *xin, double *xout)
            swe.ccall('swe_azalt', null, 
                ['number', 'number', 'number', 'number', 'number', 'number', 'number'], 
                [jd, calc_flag, geoPtr, atpress, attemp, xinPtr, xoutPtr]
            );

            // Read Output
            return {
                azimuth: swe.HEAPF64[(xoutPtr >> 3) + 0],
                trueAlt: swe.HEAPF64[(xoutPtr >> 3) + 1],
                appAlt:  swe.HEAPF64[(xoutPtr >> 3) + 2]
            };

        } finally {
            swe._free(geoPtr); swe._free(xinPtr); swe._free(xoutPtr);
        }
    },

    revjul: (jd, f) => {
         const yr=swe._malloc(4), mo=swe._malloc(4), dy=swe._malloc(4), ut=swe._malloc(8);
         try {
             swe.ccall('swe_revjul', null, ['number','number','number','number','number','number'], [jd, f, yr, mo, dy, ut]);
             return { year: swe.HEAP32[yr>>2], month: swe.HEAP32[mo>>2], day: swe.HEAP32[dy>>2], hour: swe.HEAPF64[ut>>3] };
         } finally {
             swe._free(yr); swe._free(mo); swe._free(dy); swe._free(ut);
         }
    }
};

// 3. FILE MANAGER (Master List Logic)
async function ensureDataForYear(year) {
    let suffix = "";
    if (year < 0) {
        let startYear = Math.floor((year) / 600) * 600; 
        let century = Math.abs(startYear) / 100;
        let cStr = century < 10 ? `0${century}` : `${century}`;
        suffix = `m${cStr}`;
    } else {
        let startYear = Math.floor(year / 600) * 600;
        let century = startYear / 100;
        let cStr = century < 10 ? `0${century}` : `${century}`;
        suffix = `_${cStr}`;
    }

    const requiredFiles = [
        { name: `sepl${suffix}.se1`, label: "Planets" },
        { name: `semo${suffix}.se1`, label: "Moon" }
    ];

    for (const file of requiredFiles) {
        const engineName = file.name;
        const serverName = `${file.name}.bin`;
        const url = `assets/ephe/${serverName}`;
        let exists = false;
        try { swe.FS.stat(`/${engineName}`); exists = true; } catch(e){}

        if (!exists) {
            updateStatus(`Downloading ${file.label} (${suffix})...`);
            try {
                const resp = await fetch(`${url}?t=${Date.now()}`);
                if (!resp.ok) throw new Error(`404 Missing: ${serverName}`);
                const buf = await resp.arrayBuffer();
                if (buf.byteLength < 5000) throw new Error("File too small.");
                swe.FS.writeFile(`/${engineName}`, new Uint8Array(buf));
                console.log(`✅ Loaded ${file.label}: ${url}`);
            } catch (err) {
                document.querySelector('#resultsTable tbody').innerHTML = `<tr><td colspan="5" style="color:red;">MISSING FILE: ${serverName}</td></tr>`;
                throw new Error(`Critical: ${serverName}`);
            }
        }
    }
}

// 4. MAIN LOGIC (Topocentric + Refraction)
export async function runQuery() {
    if (!swe) { alert("Engine initializing..."); return; }

    // -- INPUTS --
    const bodyId = parseInt(document.getElementById('bodySelect').value);
    const startY = parseInt(document.getElementById('startYear').value);
    const startM = parseInt(document.getElementById('startMonth').value);
    const startD = parseInt(document.getElementById('startDay').value);
    const count  = parseInt(document.getElementById('stepCount').value);
    const stepSz = parseFloat(document.getElementById('stepUnit').value);

    // Observer
    const obsLat = parseFloat(document.getElementById('obsLat').value);
    const obsLon = parseFloat(document.getElementById('obsLon').value);
    const obsAlt = parseFloat(document.getElementById('obsAlt').value);

    // Atmosphere
    const atTemp = parseFloat(document.getElementById('atTemp').value);
    const atPress = parseFloat(document.getElementById('atPress').value);

    updateStatus("Computing...");
    let lastResults = [];

    try {
        await ensureDataForYear(startY);
        
        // 1. Force Path
        try { swe.ccall('swe_set_ephe_path', null, ['string'], ['/']); } catch(e){}

        // 2. Set Topocentric Location (GeoLon, GeoLat, Height)
        API.set_topo(obsLon, obsLat, obsAlt);

        const rows = [];
        const CAL_MODE = startY < 1582 ? 0 : 1; 
        let currentJD = API.julday(startY, startM, startD, 12, CAL_MODE); // Start at Noon UT
        
        // FLAGS: SwissEph + Speed + Equatorial + Topocentric
        const FLAGS = 2 | 256 | 2048 | (32 * 1024); 
        
        // AZALT FLAG: 1 = Equatorial input (RA/Dec)
        const AZ_FLAG = 1; 

        for (let i = 0; i < count; i++) {
            // A. Get Topocentric RA/Dec
            const data = API.calc_ut(currentJD, bodyId, FLAGS);
            
            if (data.rc < 0) {
                rows.push({ date: "Error", az: data.error, alt: "", appAlt: "", dist: "" });
            } else {
                // Result array: [RA, Dec, Dist, SpeedRA, SpeedDec, SpeedDist]
                const celestialPos = [data.result[0], data.result[1], data.result[2]];

                // B. Transform to Azimuth/Altitude (With Refraction)
                const horizon = API.azalt(
                    currentJD, 
                    AZ_FLAG, 
                    [obsLon, obsLat, obsAlt], 
                    atPress, 
                    atTemp, 
                    celestialPos
                );

                const dateObj = API.revjul(currentJD, CAL_MODE);
                const dateStr = `${dateObj.year}-${pad(dateObj.month)}-${pad(dateObj.day)} ${formatTime(dateObj.hour)}`;
                
                // C. Normalize Azimuth to 0-360
                let az = horizon.azimuth; 
                if (az < 0) az += 360; 

                const rowData = {
                    date: dateStr, 
                    jd: currentJD.toFixed(4),
                    az: az.toFixed(4), 
                    trueAlt: horizon.trueAlt.toFixed(4), 
                    appAlt: horizon.appAlt.toFixed(4), // With Refraction
                    dist: celestialPos[2].toFixed(5)
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
    let csv = "Date,JD,Azimuth,TrueAlt,ApparentAlt,Dist\n" + window.lastResults.map(r => `${r.date},${r.jd},${r.az},${r.trueAlt},${r.appAlt},${r.dist}`).join("\n");
    const a = document.createElement('a');
    a.href = window.URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = "horizon_data.csv";
    a.click();
}

function renderTable(rows) {
    document.querySelector('#resultsTable tbody').innerHTML = rows.map(r => `<tr><td>${r.date}</td><td>${r.az}°</td><td>${r.trueAlt}°</td><td><b>${r.appAlt}°</b></td><td>${r.dist}</td></tr>`).join('');
}
function updateStatus(msg) { const el = document.getElementById('status'); if(el) el.innerText = msg; }
function pad(n) { return n < 10 ? '0'+n : n; }
function formatTime(h) {
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    const ss = Math.round(((h - hh) * 60 - mm) * 60);
    return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}