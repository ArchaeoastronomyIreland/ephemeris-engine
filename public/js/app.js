// --- SMART FILE MANAGER (Fixed for Filename Mismatch) ---
async function ensureDataForYear(year) {
    if (year >= -600) return;

    // 1. Calculate the Century ID
    // e.g. -3500 -> -3600 -> "m36"
    const baseYear = Math.floor(year / 600) * 600;
    const century = Math.abs(baseYear / 100); 
    
    // 2. Define filenames
    // The server has the file as 'sepl_m36.se1.bin'
    const serverFilename = `sepl_m${century}.se1.bin`;
    
    // The Engine might want 'sepl_m36.se1' OR 'seplm36.se1' (No underscore)
    // We will save it as BOTH to be 100% safe.
    const vfsName1 = `sepl_m${century}.se1`;
    const vfsName2 = `seplm${century}.se1`; 
    
    // Check if either exists in VFS
    let exists = false;
    try { swe.FS.stat(`/${vfsName1}`); exists = true; } catch(e){}
    try { swe.FS.stat(`/${vfsName2}`); exists = true; } catch(e){}

    if (!exists) {
        updateStatus(`Downloading ancient data: ${serverFilename}...`);
        
        try {
            // Fetch from your GitHub
            const resp = await fetch(`assets/ephe/${serverFilename}`); 
            if (!resp.ok) {
                throw new Error(`Server missing file: assets/ephe/${serverFilename}`);
            }
            
            const buf = await resp.arrayBuffer();
            const data = new Uint8Array(buf);
            
            // --- THE FIX: DOUBLE SAVE ---
            // Write it to Root with underscore
            swe.FS.writeFile(`/${vfsName1}`, data);
            
            // Write it to Root WITHOUT underscore (This fixes your error)
            swe.FS.writeFile(`/${vfsName2}`, data);
            
            console.log(`✅ Hydrated VFS: /${vfsName1} AND /${vfsName2}`);
            
        } catch (err) {
            throw new Error(`Data fetch failed: ${err.message}`);
        }
    }
}