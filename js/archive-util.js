/**
 * Archive helpers for CBZ (ZIP) and CBR (RAR).
 *
 * Strategy: lazy extraction to temp directory.
 *  - On first access, list all entries (opens archive once).
 *  - Extract images on-demand in a window around the requested index (±PRELOAD_AHEAD).
 *  - Purge extracted files beyond ±PURGE_DISTANCE to save disk space.
 *  - Return file paths (not buffers) so the renderer can use file:// URLs.
 *  - Provide image dimensions via image-size for virtual scroll height calculation.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const PLUGIN_ROOT = path.join(__dirname, '..');
const requireYauzl = () => require(path.join(PLUGIN_ROOT, 'node_modules', 'yauzl'));
const requireUnrar = () => require(path.join(PLUGIN_ROOT, 'node_modules', 'node-unrar-js'));
const requireImageSize = () => require(path.join(PLUGIN_ROOT, 'node_modules', 'image-size'));
const requireYazl = () => require(path.join(PLUGIN_ROOT, 'node_modules', 'yazl'));

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'];
const IMAGE_EXT_SET = new Set(IMAGE_EXT.map(e => e.toLowerCase()));

/** How many images ahead/behind to extract around the current page */
const PRELOAD_AHEAD = 7;
/** Purge extracted files further than this from the current page (keep plenty to avoid re-extract on back/forward) */
const PURGE_DISTANCE = 80;
/** Only run purge when center has moved at least this many pages from last purge (reduces unlink spam) */
const PURGE_STEP = 25;

// ── Helpers ──────────────────────────────────────────────────────────────

function isImageFileName(name) {
    const ext = path.extname(name).toLowerCase();
    return IMAGE_EXT_SET.has(ext) && !name.includes('__MACOSX');
}

function naturalSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function isCBZ(fp) { return path.extname(fp).toLowerCase() === '.cbz'; }
function isCBR(fp) { return path.extname(fp).toLowerCase() === '.cbr'; }

function safeName(entryName) {
    // Flatten any directory structure into a single filename to avoid path issues
    return entryName.replace(/[/\\]/g, '__');
}

// ── Per-Archive Session ──────────────────────────────────────────────────

/**
 * Cache of open archive sessions:  archivePath → ArchiveSession
 * Each session holds the temp dir, sorted entry list, and extraction state.
 */
const sessions = new Map();

class ArchiveSession {
    constructor(archivePath, tmpDir, imageEntries) {
        this.archivePath = archivePath;
        this.tmpDir = tmpDir;
        /** Sorted list of entry names (inside-archive paths) */
        this.imageEntries = imageEntries;
        /** Map<index, absoluteFilePath> – tracks which pages are extracted */
        this.extracted = new Map();
        /** Map<index, {width, height}> – dimension cache */
        this.dimensions = new Map();
        /** Serializes extraction calls so concurrent requests wait properly */
        this._extractionChain = Promise.resolve();
        /** Last center index we purged for – only purge again when center moved by PURGE_STEP */
        this._lastPurgeCenter = null;
    }

    get pageCount() { return this.imageEntries.length; }

    /** Absolute path for a page's extracted file */
    pathForIndex(index) {
        return this.extracted.get(index) || null;
    }

    /** Purge extracted files far from `centerIndex`. Throttled so we don't purge on every getImagePath. */
    purge(centerIndex) {
        if (this._lastPurgeCenter != null && Math.abs(centerIndex - this._lastPurgeCenter) < PURGE_STEP) {
            return;
        }
        this._lastPurgeCenter = centerIndex;
        for (const [idx, filePath] of this.extracted) {
            if (Math.abs(idx - centerIndex) > PURGE_DISTANCE) {
                try { fs.unlinkSync(filePath); } catch (_) { }
                this.extracted.delete(idx);
            }
        }
    }

    /** Remove the entire temp directory */
    destroy() {
        try { fs.rmSync(this.tmpDir, { recursive: true, force: true }); } catch (_) { }
        sessions.delete(this.archivePath);
    }
}

// ── CBZ: list entries ────────────────────────────────────────────────────

function listEntriesCBZ(src) {
    return new Promise((resolve, reject) => {
        const yauzl = requireYauzl();
        const entries = []; // {fileName, offset (for fast seek)}
        yauzl.open(src, { lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(err);
            zipfile.readEntry();
            zipfile.on('entry', entry => {
                if (!/\/$/.test(entry.fileName) && isImageFileName(entry.fileName)) {
                    entries.push(entry.fileName);
                }
                zipfile.readEntry();
            });
            zipfile.on('end', () => {
                zipfile.close();
                entries.sort(naturalSort);
                resolve(entries);
            });
            zipfile.on('error', reject);
        });
    });
}

// ── CBZ: extract a batch of entries to temp dir ──────────────────────────

function extractBatchCBZ(src, tmpDir, targetNames) {
    return new Promise((resolve, reject) => {
        const yauzl = requireYauzl();
        const targetSet = new Set(targetNames);
        const results = new Map(); // entryName → filePath
        let remaining = targetSet.size;
        if (remaining === 0) return resolve(results);

        yauzl.open(src, { lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(err);
            zipfile.readEntry();
            zipfile.on('entry', entry => {
                if (targetSet.has(entry.fileName)) {
                    zipfile.openReadStream(entry, (errS, stream) => {
                        if (errS) return reject(errS);
                        const outPath = path.join(tmpDir, safeName(entry.fileName));
                        const ws = fs.createWriteStream(outPath);
                        stream.pipe(ws);
                        ws.on('finish', () => {
                            results.set(entry.fileName, outPath);
                            remaining--;
                            if (remaining === 0) {
                                zipfile.close();
                                resolve(results);
                            } else {
                                zipfile.readEntry();
                            }
                        });
                        ws.on('error', reject);
                    });
                } else {
                    zipfile.readEntry();
                }
            });
            zipfile.on('end', () => {
                zipfile.close();
                // If we reach end without finding all targets, resolve with what we have
                resolve(results);
            });
            zipfile.on('error', reject);
        });
    });
}

// ── CBR: list entries ────────────────────────────────────────────────────

async function listEntriesCBR(src) {
    const unrar = requireUnrar();
    const ext = await unrar.createExtractorFromFile({ filepath: src });
    const list = ext.getFileList();
    const headers = [...list.fileHeaders];
    const names = headers
        .filter(h => !h.flags.directory && isImageFileName(h.name))
        .map(h => h.name);
    names.sort(naturalSort);
    return names;
}

// ── CBR: extract a batch to temp dir ─────────────────────────────────────

async function extractBatchCBR(src, tmpDir, targetNames) {
    const unrar = requireUnrar();
    const ext = await unrar.createExtractorFromFile({
        filepath: src,
        targetPath: tmpDir,
    });
    const extracted = ext.extract({ files: targetNames });
    const files = [...extracted.files]; // force iteration

    const results = new Map();
    for (const name of targetNames) {
        const normalized = name.replace(/\\/g, path.sep);
        const fullPath = path.join(tmpDir, normalized);
        const altPath = path.join(tmpDir, path.basename(name));
        const safePath = path.join(tmpDir, safeName(name));

        // node-unrar-js preserves directory structure; find the file
        let readPath = null;
        if (fs.existsSync(fullPath)) readPath = fullPath;
        else if (fs.existsSync(altPath)) readPath = altPath;
        else if (fs.existsSync(safePath)) readPath = safePath;

        if (readPath) {
            // Move to flat safe name if needed
            if (readPath !== safePath) {
                try {
                    fs.renameSync(readPath, safePath);
                    readPath = safePath;
                } catch (_) { }
            }
            results.set(name, readPath);
        }
    }
    return results;
}

// ── Session management ───────────────────────────────────────────────────

/**
 * Get or create a session for the given archive.
 * On first call, lists all entries (opens archive once).
 */
async function getSession(archivePath) {
    const normPath = path.normalize(archivePath);
    if (sessions.has(normPath)) return sessions.get(normPath);

    const tmpDir = path.join(os.tmpdir(), `eagle-cbr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    let entries;
    if (isCBZ(normPath)) {
        entries = await listEntriesCBZ(normPath);
    } else if (isCBR(normPath)) {
        entries = await listEntriesCBR(normPath);
    } else {
        throw new Error('Unsupported format');
    }

    const session = new ArchiveSession(normPath, tmpDir, entries);
    sessions.set(normPath, session);
    return session;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * List image names in archive (sorted).
 */
async function listImages(filePath) {
    const session = await getSession(filePath);
    return session.imageEntries;
}

/**
 * Ensure pages in [centerIndex - PRELOAD_AHEAD, centerIndex + PRELOAD_AHEAD]
 * are extracted to temp. Purges far-away files. Returns the path for centerIndex.
 */
async function ensureExtracted(filePath, centerIndex, abortToken) {
    const session = await getSession(filePath);

    // Chain extraction requests: if a previous extraction is in-flight,
    // wait for it to finish before starting a new batch.
    const extractionWork = session._extractionChain.then(async () => {
        if (abortToken && abortToken.aborted) return; // Drop stale request

        const total = session.pageCount;
        const lo = Math.max(0, centerIndex - PRELOAD_AHEAD);
        const hi = Math.min(total - 1, centerIndex + PRELOAD_AHEAD);

        // Find which indices need extraction (check again after await)
        const needed = [];
        const neededNames = [];
        for (let i = lo; i <= hi; i++) {
            if (!session.extracted.has(i)) {
                needed.push(i);
                neededNames.push(session.imageEntries[i]);
            }
        }

        if (neededNames.length > 0) {
            const normPath = path.normalize(filePath);
            let results;
            if (isCBZ(normPath)) {
                results = await extractBatchCBZ(normPath, session.tmpDir, neededNames);
            } else {
                results = await extractBatchCBR(normPath, session.tmpDir, neededNames);
            }

            for (const idx of needed) {
                const entryName = session.imageEntries[idx];
                const extractedPath = results.get(entryName);
                if (extractedPath) {
                    session.extracted.set(idx, extractedPath);
                }
            }
        }

        if (!abortToken || !abortToken.aborted) {
            session.purge(centerIndex);
        }
    });

    // Update chain (swallow errors to not block future extractions)
    session._extractionChain = extractionWork.catch(() => { });

    await extractionWork;
    return session.pathForIndex(centerIndex);
}

/**
 * Get the file path for a specific page.
 * Triggers lazy extraction of surrounding pages.
 */
async function getImagePath(filePath, index, abortToken) {
    return ensureExtracted(filePath, index, abortToken);
}

/**
 * Extract a range of pages in one batch and return paths for all.
 * Use for preload so the whole window is ready at once instead of one-by-one.
 * @param {string} filePath - archive path
 * @param {number[]} indices - 0-based image indices to extract
 * @param {object} abortToken - object with .aborted boolean
 * @returns {Promise<Map<number, string>>} index -> absolute file path
 */
async function getImagePathsInRange(filePath, indices, abortToken) {
    const session = await getSession(filePath);
    const unique = [...new Set(indices)].filter(i => i >= 0 && i < session.pageCount);
    if (unique.length === 0) return new Map();

    const centerForPurge = Math.floor(unique.reduce((a, b) => a + b, 0) / unique.length);

    const extractionWork = session._extractionChain.then(async () => {
        if (abortToken && abortToken.aborted) return; // Drop stale request

        const needed = [];
        const neededNames = [];
        for (const i of unique) {
            if (!session.extracted.has(i)) {
                needed.push(i);
                neededNames.push(session.imageEntries[i]);
            }
        }

        if (neededNames.length > 0) {
            const normPath = path.normalize(filePath);
            let results;
            if (isCBZ(normPath)) {
                results = await extractBatchCBZ(normPath, session.tmpDir, neededNames);
            } else {
                results = await extractBatchCBR(normPath, session.tmpDir, neededNames);
            }

            for (const idx of needed) {
                const entryName = session.imageEntries[idx];
                const extractedPath = results.get(entryName);
                if (extractedPath) {
                    session.extracted.set(idx, extractedPath);
                }
            }
        }

        if (!abortToken || !abortToken.aborted) {
            session.purge(centerForPurge);
        }
    });

    session._extractionChain = extractionWork.catch(() => { });

    await extractionWork;

    const out = new Map();
    for (const i of unique) {
        const p = session.pathForIndex(i);
        if (p) out.set(i, p);
    }
    return out;
}

/**
 * Get the buffer for a specific page (backwards compat, used by thumbnail).
 */
async function getImageBufferByIndex(filePath, index) {
    const imgPath = await getImagePath(filePath, index);
    if (!imgPath) throw new Error('Failed to extract page ' + index);
    return fs.readFileSync(imgPath);
}

/**
 * Get the first image buffer (for thumbnail generation).
 */
async function getFirstImageBuffer(filePath) {
    const names = await listImages(filePath);
    if (names.length === 0) throw new Error('No images found in archive');
    return getImageBufferByIndex(filePath, 0);
}

/**
 * Get dimensions for a range of pages.
 * Returns array of {width, height} (or null if not yet extracted).
 * Reads dimensions from already-extracted files.
 */
function getImageDimensions(filePath, indices) {
    const normPath = path.normalize(filePath);
    const session = sessions.get(normPath);
    if (!session) return indices.map(() => null);

    const imageSize = requireImageSize();
    return indices.map(idx => {
        if (session.dimensions.has(idx)) return session.dimensions.get(idx);
        const fp = session.extracted.get(idx);
        if (!fp) return null;
        try {
            const dim = imageSize(fp);
            const result = { width: dim.width || 0, height: dim.height || 0 };
            session.dimensions.set(idx, result);
            return result;
        } catch (_) {
            return null;
        }
    });
}

/**
 * Get all known dimensions (for pages already extracted).
 */
async function getAllDimensions(filePath) {
    const session = await getSession(filePath);
    const total = session.pageCount;
    const indices = [];
    for (let i = 0; i < total; i++) indices.push(i);
    return getImageDimensions(filePath, indices);
}

/**
 * Render an image at a higher scale using Sharp (for zoom).
 * Capped at original image dimensions (no upscaling beyond native).
 * Cached in temp dir as `page_NNN_sX.X.webp`.
 * @param {string} filePath - archive path
 * @param {number} index - 0-based page index
 * @param {number} targetScale - desired render scale (e.g. 2.0 for 2× DPR)
 * @returns {Promise<string|null>} path to scaled image, or null if not applicable
 */
async function renderAtScale(filePath, index, targetScale) {
    if (targetScale <= 1) return null;
    const normPath = path.normalize(filePath);
    const session = sessions.get(normPath);
    if (!session) return null;

    const originalPath = session.pathForIndex(index);
    if (!originalPath) return null;

    // Round scale to 1 decimal for cache key
    const scaleKey = Math.round(targetScale * 10) / 10;
    const cacheKey = `page_${String(index).padStart(4, '0')}_s${scaleKey}`;

    // Check if already rendered at this scale
    if (session._scaledCache && session._scaledCache.has(cacheKey)) {
        const cached = session._scaledCache.get(cacheKey);
        try { fs.accessSync(cached); return cached; } catch (_) { /* re-render */ }
    }

    try {
        const sharp = require('sharp');
        const meta = await sharp(originalPath).metadata();
        if (!meta.width || !meta.height) return null;

        // Get current display width from dimensions cache
        const dims = session.dimensions.get(index);
        const origW = dims ? dims.width : meta.width;

        // Target width capped at original (no upscale)
        const targetW = Math.min(Math.round(origW * targetScale / (origW / meta.width)), meta.width);

        // If the user zooms in to 95%+ of the original image size, completely bypass Sharp.
        // This renders instantly directly from the OS file, and prevents any double-compression artifacts on custom jpegli files!
        if (targetW >= meta.width * 0.95 && meta.width <= 10000 && meta.height <= 10000) {
            return originalPath;
        }

        if (targetW <= meta.width * 0.9 && targetScale > 1.1) {
            // Only render if meaningfully larger than what we already have or close to original
        }

        const ext = path.extname(originalPath).toLowerCase() || '.jpg';
        const outPath = path.join(session.tmpDir, cacheKey + ext);

        let sh = sharp(originalPath).resize({ width: targetW, withoutEnlargement: true });

        // Inject hyper-fast encoding heuristics based on the native target container
        if (ext === '.jpg' || ext === '.jpeg') {
            sh = sh.jpeg({ quality: 85, mozjpeg: false });
        } else if (ext === '.png') {
            sh = sh.png({ compressionLevel: 1 });
        } else if (ext === '.webp') {
            sh = sh.webp({ quality: 80, effort: 1 });
        }

        await sh.toFile(outPath);

        if (!session._scaledCache) session._scaledCache = new Map();
        session._scaledCache.set(cacheKey, outPath);
        return outPath;
    } catch (err) {
        console.error('renderAtScale failed:', err);
        return null;
    }
}

/**
 * Clean up the session for an archive (remove temp files).
 */
function cleanup(filePath) {
    const normPath = path.normalize(filePath);
    const session = sessions.get(normPath);
    if (session) session.destroy();
}

/**
 * Clean up all sessions.
 */
function cleanupAll() {
    for (const session of sessions.values()) {
        session.destroy();
    }
    sessions.clear();
}

// ── CBZ: remove entry without re-compression ────────────────────────────

/**
 * Remove a single entry from a CBZ (ZIP) archive.
 * Uses yauzl to read raw compressed streams and yazl to write them
 * into a new archive, skipping the entry to delete. No re-compression.
 * Atomically replaces the original file.
 */
function removeEntryCBZ(archivePath, entryName) {
    return new Promise((resolve, reject) => {
        const yauzl = requireYauzl();
        const yazl = requireYazl();
        const tmpOut = archivePath + '.tmp';

        yauzl.open(archivePath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
            if (err) return reject(err);

            const outZip = new yazl.ZipFile();
            const ws = fs.createWriteStream(tmpOut);
            outZip.outputStream.pipe(ws);

            zipfile.readEntry();
            zipfile.on('entry', entry => {
                if (entry.fileName === entryName) {
                    // Skip this entry
                    zipfile.readEntry();
                    return;
                }

                if (/\/$/.test(entry.fileName)) {
                    // Directory entry
                    outZip.addEmptyDirectory(entry.fileName, {
                        mtime: entry.getLastModDate(),
                    });
                    zipfile.readEntry();
                } else {
                    // File entry: pipe raw compressed data (no re-compression)
                    zipfile.openReadStream(entry, { decompress: false }, (errS, rawStream) => {
                        if (errS) return reject(errS);
                        outZip.addReadStream(rawStream, entry.fileName, {
                            mtime: entry.getLastModDate(),
                            compress: false, // already compressed
                            size: entry.uncompressedSize,
                        });
                        rawStream.on('end', () => zipfile.readEntry());
                    });
                }
            });

            zipfile.on('end', () => {
                zipfile.close();
                outZip.end();
            });

            ws.on('finish', () => {
                // Atomic replace
                try {
                    fs.renameSync(tmpOut, archivePath);
                } catch (renameErr) {
                    // Cross-device: copy + delete
                    fs.copyFileSync(tmpOut, archivePath);
                    fs.unlinkSync(tmpOut);
                }
                // Invalidate session cache
                const normPath = path.normalize(archivePath);
                const session = sessions.get(normPath);
                if (session) session.destroy();
                resolve();
            });

            ws.on('error', reject);
            zipfile.on('error', reject);
        });
    });
}

// Cleanup on process exit
process.on('exit', cleanupAll);
process.on('SIGINT', () => { cleanupAll(); process.exit(); });
process.on('SIGTERM', () => { cleanupAll(); process.exit(); });

module.exports = {
    listImages,
    getImagePath,
    getImagePathsInRange,
    getImageBufferByIndex,
    getFirstImageBuffer,
    getImageDimensions,
    getAllDimensions,
    renderAtScale,
    removeEntryCBZ,
    cleanup,
    cleanupAll,
    isImageFileName,
    IMAGE_EXT,
    PRELOAD_AHEAD,
    PURGE_DISTANCE,
};
