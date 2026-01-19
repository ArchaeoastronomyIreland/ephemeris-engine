// --- MANUAL API BRIDGE ---
const API = {
    julday: (year, month, day, hour, calFlag) => {
        return swe.ccall('swe_julday', 'number', 
            ['number', 'number', 'number', 'number', 'number'], 
            [year, month, day, hour, calFlag]
        );
    },
    calc_ut: (jd, body, flags) => {
        const resPtr = swe._malloc(48); // 6 doubles for result
        const errPtr = swe._malloc(256); // 256 bytes for error string
        try {
            const rc = swe.ccall('swe_calc_ut', 'number',
                ['number', 'number', 'number', 'number', 'number'],
                [jd, body, flags, resPtr, errPtr]
            );
            
            // If Error (rc < 0), read the error string from memory
            if (rc < 0) {
                const errorMsg = swe.UTF8ToString(errPtr);
                return { rc, error: errorMsg };
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
    // ... (keep revjul as it was) ...
    revjul: (jd, calFlag) => {
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