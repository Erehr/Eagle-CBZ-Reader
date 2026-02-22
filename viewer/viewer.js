/**
 * CBZ/CBR Reader
 *
 * Single reading body for all modes: slide (single/double page), scroll (continuous), compact (instant single).
 * Same DOM for all modes; layout and navigation change only. No virtual scroll, no dynamic add/remove.
 */
(function () {
    const pathModule = require('path');
    const urlParams = new URLSearchParams(window.location.search);
    const fileId = urlParams.get('id') || '';
    let filePath = urlParams.get('path') || '';
    if (filePath.startsWith('file://')) {
        filePath = filePath.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
        try { filePath = decodeURIComponent(filePath); } catch (_) { }
    }
    filePath = pathModule.normalize(filePath);

    // Check if sharp is successfully loaded
    let sharp;
    try { sharp = require('sharp'); } catch (e) { console.error('Failed to load sharp', e); sharp = null; }
    filePath = pathModule.normalize(filePath);
    const theme = (urlParams.get('theme') || 'dark').toLowerCase();
    document.documentElement.setAttribute('theme', theme === 'light' ? 'light' : 'dark');

    const readingContainer = document.getElementById('reading-container');
    const readingBody = readingContainer.querySelector('.reading-body');
    const readingTrack = document.getElementById('reading-track');
    const pageInfo = document.getElementById('page-info');
    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');
    const modeSingle = document.getElementById('mode-single');
    const modeDouble = document.getElementById('mode-double');
    const continuousToggle = document.getElementById('continuous-toggle');
    const toolbar = document.getElementById('toolbar');
    const scrollWidthLabel = document.getElementById('scroll-width-label');
    const scrollGapToggle = document.getElementById('scroll-gap-toggle');
    const gapOnIcon = document.getElementById('gap-on-icon');
    const gapOffIcon = document.getElementById('gap-off-icon');
    const mangaRtlBtn = document.getElementById('manga-rtl');
    const scrollNavToggle = document.getElementById('scroll-nav-toggle');
    const mouseOnIcon = document.getElementById('mouse-on-icon');
    const mouseOffIcon = document.getElementById('mouse-off-icon');
    const transitionSpeedToggle = document.getElementById('transition-speed-toggle');
    const transitionSpeedLabel = document.getElementById('transition-speed-label');
    const dirLtrIcon = document.getElementById('dir-ltr-icon');
    const dirRtlIcon = document.getElementById('dir-rtl-icon');
    const zoomInBtn = document.getElementById('zoom-in');
    const zoomOutBtn = document.getElementById('zoom-out');
    const zoomResetBtn = document.getElementById('zoom-reset');
    const zoomLabel = document.getElementById('zoom-label');
    const contentEl = document.getElementById('content');

    const STORAGE_PREFIX = (typeof eagle !== 'undefined' && eagle.plugin && eagle.plugin.manifest && eagle.plugin.manifest.id) ? eagle.plugin.manifest.id : 'eagle-cbz-cbr-reader';
    function getSetting(key, def) {
        try { const v = localStorage.getItem(STORAGE_PREFIX + ':setting:' + key); return v !== null ? v : def; } catch (_) { return def; }
    }
    function setSetting(key, val) {
        try { localStorage.setItem(STORAGE_PREFIX + ':setting:' + key, String(val)); } catch (_) { }
    }
    function getPosKey() {
        const key = fileId || filePath.replace(/\\/g, '/');
        return STORAGE_PREFIX + ':pos:' + key;
    }

    let imageNames = [];
    /** imagesData[index] = { width, height, aspectRatio } — 0-based image index */
    let imagesData = {};
    /** indexNum = spread count in double mode, image count otherwise (set by updateIndexNum) */
    let indexNum = 0;
    /** 1-based current spread index */
    let currentIndex = 1;
    /** Scroll mode: position of each image. imagesFullPosition[imageIndex] = { top, center, bottom, height } */
    let imagesFullPosition = {};
    let rightSize = { width: 0, height: 0, scrollHeight: 0 };
    let slideTrackTotalW = 0;

    /** 1 or 2 pages per view */
    let pagesPerView = getSetting('pagesPerView', '1') === '2' ? 2 : 1;
    /** Continuous scroll (vertical); when false = paged slide/compact */
    let continuous = getSetting('continuous', 'false') === 'true';
    /** Derived: 'single' | 'double' | 'scroll' for layout/nav (scroll when continuous) */
    let viewMode = continuous ? 'scroll' : (pagesPerView === 1 ? 'single' : 'double');
    let scrollWidth = Math.max(50, Math.min(100, parseInt(getSetting('scrollWidth', '100'), 10) || 100));
    if (![100, 75, 50].includes(scrollWidth)) scrollWidth = 100;
    let scrollGap = getSetting('scrollGap', 'true') !== 'false';
    let mangaRtl = getSetting('mangaRtl', 'false') === 'true';
    let scrollNavEnabled = getSetting('scrollNavEnabled', 'true') !== 'false';
    let pageTransitionMs = parseInt(getSetting('pageTransitionSpeed', '300'), 10);
    if (pageTransitionMs !== 0) pageTransitionMs = Math.max(100, Math.min(500, pageTransitionMs));

    let currentScale = 1;
    let unscaledTrackHeight = 0;
    let haveZoom = false;
    let currentZoomIndex = false; // 0-based index of zoomed page
    let scalePrevData = { tranX: 0, tranX2: 0, tranY: 0, tranY2: 0, scale: 1 };
    let originalRect = false;
    let zoomMoveData = {};

    // Drag navigation state
    let dragNav = null; // { startX, startY, startTx, startScrollTop }
    let rightDrag = null; // { startY, startScale }
    let rightDragUsed = false; // true after right-drag zoom, suppresses context menu once

    // Standard portrait comic/manga shape falls back here (width/height)
    const DEFAULT_ASPECT = 0.69;

    const archiveUtil = require('../js/archive-util.js');



    function getAspectRatio(imageIndex) {
        const d = imagesData[imageIndex];
        if (d && d.aspectRatio) return d.aspectRatio;
        return DEFAULT_ASPECT;
    }

    function loadImageSrc(index) {
        return archiveUtil.getImagePath(filePath, index).then(fp => {
            if (!fp) throw new Error('No path for page ' + index);
            const dims = archiveUtil.getImageDimensions(filePath, [index]);
            if (dims && dims[0] && dims[0].width > 0) {
                imagesData[index] = {
                    width: dims[0].width,
                    height: dims[0].height,
                    aspectRatio: dims[0].width / dims[0].height
                };
            }
            return 'file:///' + fp.replace(/\\/g, '/');
        });
    }

    // Single track: one .r-flex per image for all 3 views. Double = 50% width + nav by spreads.
    function getSpreadCount(n) {
        if (n <= 1) return Math.max(1, n);
        return 2 + Math.floor((n - 2) / 2);
    }
    function getSpreadPages(n, spreadIndex0) {
        if (n <= 0) return { idx1: 0, idx2: null, single: true };
        if (spreadIndex0 <= 0) return { idx1: 0, idx2: null, single: true };
        const idx1 = 2 * spreadIndex0 - 1;
        const idx2 = idx1 + 1 < n ? idx1 + 1 : null;
        return { idx1, idx2, single: idx2 === null };
    }

    function getSpreadForImage(n, imageIndex0) {
        if (imageIndex0 <= 0) return 0;
        return Math.floor((imageIndex0 - 1) / 2) + 1;
    }

    function syncViewMode() {
        viewMode = continuous ? 'scroll' : (pagesPerView === 1 ? 'single' : 'double');
    }
    function updateIndexNum() {
        const n = imageNames.length;
        indexNum = pagesPerView === 2 ? getSpreadCount(n) : n;
    }

    // Build DOM: one .r-flex per image, same for all modes
    function addHtmlImages() {
        const n = imageNames.length;

        readingTrack.innerHTML = '';
        readingTrack.className = '';

        for (let i = 0; i < n; i++) {
            const rFlex = document.createElement('div');
            rFlex.className = 'r-flex';
            rFlex.dataset.index = String(i);

            const rImg = document.createElement('div');
            rImg.className = 'r-img r-img-i' + i;
            rImg.dataset.index = String(i);
            const wrap = document.createElement('div');
            const img = document.createElement('img');
            img.alt = '';
            img.dataset.index = String(i);
            img.loading = 'eager';
            img.decoding = 'async';
            wrap.appendChild(img);
            rImg.appendChild(wrap);
            rFlex.appendChild(rImg);
            readingTrack.appendChild(rFlex);
        }

        readingTrack.classList.toggle('track-has-gap', scrollGap);
        lazyLoadObserver();
    }

    let imgObserver = null;
    let disposeAfterLoadTimer = 0;

    /** Monotonically increasing epoch – incremented on every navigation so stale tasks can bail out */
    let renderEpoch = 0;
    let preloadTimer = 0;

    /** Asynchronous render queue to prevent main-thread blocking during parallel image decodes */
    const renderQueue = {
        tasks: [],
        running: false,
        add: function (priority, idx, taskFn, epoch) {
            if (this.tasks.some(t => t.idx === idx)) return;
            this.tasks.push({ priority, idx, taskFn, epoch: epoch !== undefined ? epoch : renderEpoch });
            this.tasks.sort((a, b) => b.priority - a.priority);
            this.process();
        },
        process: async function () {
            if (this.running || this.tasks.length === 0) return;
            this.running = true;
            const task = this.tasks.shift();
            try {
                /* Skip stale tasks from a previous navigation epoch */
                if (task.epoch === renderEpoch) {
                    const abortToken = {
                        get aborted() { return task.epoch !== renderEpoch; }
                    };
                    await task.taskFn(abortToken);
                }
            } finally {
                this.running = false;
                this.process();
            }
        },
        clear: function () {
            this.tasks = [];
        }
    };

    /** Debounced layout pass after image loads – batches multiple loads into one pass */
    function scheduleDisposeAfterLoad() {
        if (disposeAfterLoadTimer) return; // already scheduled
        disposeAfterLoadTimer = setTimeout(() => {
            disposeAfterLoadTimer = 0;
            if (slideAnimationRaf) {
                scheduleDisposeAfterLoad();
                return;
            }
            disposeImages();
            if (continuous) {
                calculateView(false);
                if (haveZoom) applyScale(currentScale, false);
            }
        }, continuous ? 150 : 16);
    }

    /** Set the source of an image natively, followed by a sharp downsample if applicable */
    async function smartLoadImage(img, absolutePath, taskEpoch) {
        const oldBlob = img.dataset.blobUrl;
        let newBlobUrl = '';

        const wrap = img.closest('.r-img > div');
        const targetWidth = wrap ? (parseInt(wrap.style.width, 10) || wrap.offsetWidth) : 0;

        let url = 'file:///' + absolutePath.replace(/\\/g, '/');

        // If sharp is available and we have a valid container width, scale it down
        // We use JPEG for maximum encoding speed (vastly faster than PNG)
        if (sharp && targetWidth > 0 && targetWidth < 3000) {
            try {
                // Determine target pixel width based on device pixel ratio for crispness
                const pxWidth = Math.round(targetWidth * (window.devicePixelRatio || 1));

                // Abort if user scrolled away before sharp starts
                if (taskEpoch !== undefined && taskEpoch !== renderEpoch) return;

                const buffer = await sharp(absolutePath)
                    .resize({ width: pxWidth, withoutEnlargement: true })
                    .jpeg({ quality: 90 }) // Instant encode
                    .toBuffer();

                // Abort if user scrolled away while sharp was crunching in C++
                // This instantly unlocks the renderQueue for the new page!
                if (taskEpoch !== undefined && taskEpoch !== renderEpoch) return;

                const blob = new Blob([buffer], { type: 'image/jpeg' });
                url = URL.createObjectURL(blob);
                newBlobUrl = url;
            } catch (err) {
                // Self-Heal: if sharp failed because archive-util purged the file just before we read it
                if (err && err.message && err.message.includes("missing")) {
                    const imgIndexStr = img.dataset.index;
                    if (imgIndexStr !== undefined) {
                        try {
                            const idx = parseInt(imgIndexStr, 10);
                            const recoveredPath = await archiveUtil.getImagePath(filePath, idx);
                            if (recoveredPath) {
                                url = 'file:///' + recoveredPath.replace(/\\/g, '/');
                                // Let it fall back to native loading below (or we could recurse)
                            }
                        } catch (e) { }
                    }
                } else {
                    console.error("Sharp resize error:", err);
                }
            }
        }

        try {
            const preloader = new Image();
            preloader.src = url;
            await preloader.decode(); // Wait until decoded in memory (0-frame flicker swap)

            // Final safety abort before mutating DOM
            if (taskEpoch !== undefined && taskEpoch !== renderEpoch) return;

            img.src = url;
            img.dataset.blobUrl = newBlobUrl;

            // Clean up the old blob ONLY AFTER the new image is safely rendered on screen
            if (oldBlob && oldBlob !== url) URL.revokeObjectURL(oldBlob);

            if (currentScale > 1 && !disposeAfterLoadScheduled) {
                scheduleHiResRender(); // Snap to high-res instantly right after the chunk loads if user is presently zoomed
            }
        } catch (e) {
            if (taskEpoch !== undefined && taskEpoch !== renderEpoch) return;
            img.src = url;
            img.dataset.blobUrl = newBlobUrl;
            if (oldBlob && oldBlob !== url) URL.revokeObjectURL(oldBlob);
        }
    }

    function lazyLoadObserver() {
        if (imgObserver) imgObserver.disconnect();
        imgObserver = new IntersectionObserver(entries => {
            for (const e of entries) {
                if (!e.isIntersecting) continue;
                const wrap = e.target;
                const img = wrap.tagName === 'IMG' ? wrap : wrap.querySelector('img');
                if (!img || img.src) continue;
                const idx = parseInt(img.dataset.index, 10);
                if (isNaN(idx)) continue;
                const dist = Math.abs(idx - getCurrentCenterImageIndex());
                renderQueue.add(2000 - dist, idx, async (abortToken) => {
                    const taskEpoch = renderEpoch;
                    // Abort if user fast-scrolled far away before this task started
                    const currentDist = Math.abs(idx - getCurrentCenterImageIndex());
                    if (currentDist > 15) return;

                    if (img.src) return;

                    try {
                        const fp = await archiveUtil.getImagePath(filePath, idx, abortToken);
                        if (!fp) return;
                        if (img.dataset.index !== String(idx) || img.src) return;

                        if (taskEpoch !== renderEpoch) return;

                        const dims = archiveUtil.getImageDimensions(filePath, [idx]);
                        if (dims && dims[0] && dims[0].width > 0) {
                            imagesData[idx] = { width: dims[0].width, height: dims[0].height, aspectRatio: dims[0].width / dims[0].height };
                        }

                        if (idx === 0) {
                            img.addEventListener('load', function onFirstLoad() {
                                img.removeEventListener('load', onFirstLoad);
                                const w = img.closest('.r-img > div');
                                if (w) { w.style.backgroundImage = ''; w.style.backgroundSize = ''; w.style.backgroundPosition = ''; w.style.backgroundRepeat = ''; }
                            });
                        }
                        await smartLoadImage(img, fp, taskEpoch);
                        if (img.decode) {
                            try { await img.decode(); } catch (_) { }
                        }
                        scheduleDisposeAfterLoad();
                    } catch (e) {
                        console.error('Failed to load image ' + idx, e);
                    }
                });
            }
        }, { root: readingContainer, rootMargin: '2000px', threshold: 0 });
        readingTrack.querySelectorAll('.r-img img').forEach(el => {
            const wrap = el.closest('.r-img > div');
            if (wrap) imgObserver.observe(wrap);
        });
    }

    // Size and position images (disposeImages)
    function disposeImages() {
        const content = readingContainer;
        const rect = content.getBoundingClientRect();
        let contentHeight = rect.height || 1;
        let contentWidth = Math.round(rect.width) || 1;
        if (continuous) {
            const bodyDiv = content.querySelector('.reading-body') || content;
            contentWidth = bodyDiv.offsetWidth || content.clientWidth || 1;
        }
        const n = imageNames.length;

        const isDouble = pagesPerView === 2;
        const rFlexAll = readingTrack.querySelectorAll('.r-flex');

        for (let i = 0; i < n; i++) {
            const rFlex = rFlexAll[i];
            if (!rFlex) continue;

            const isCover = i === 0;
            const isLastSingle = (i === n - 1) && (n % 2 === 1);

            const cellW = isDouble
                ? (isCover || isLastSingle ? contentWidth : (continuous ? Math.floor(contentWidth / 2) : contentWidth / 2))
                : contentWidth;

            const ar = getAspectRatio(i);

            let imageWidth, imageHeight;
            if (!continuous) {
                imageHeight = contentHeight;
                imageWidth = imageHeight * ar;
                if (imageWidth > cellW) {
                    imageWidth = cellW;
                    imageHeight = imageWidth / ar;
                }
            } else {
                const effW = cellW * (scrollWidth / 100);
                imageWidth = effW;
                imageHeight = imageWidth / ar;
            }

            const rImg = rFlex.querySelector('.r-img');
            if (rImg) setRImgSize(rImg, imageWidth, imageHeight);

            rFlex.style.width = cellW + 'px';
            if (!continuous) {
                rFlex.style.height = contentHeight + 'px';
                rFlex.style.minHeight = '';
            } else {
                rFlex.style.minHeight = imageHeight + 'px';
                rFlex.style.height = '';
            }

            if (isDouble) {
                const isCover = i === 0;
                const isLastSingle = i === n - 1 && n % 2 === 1;
                rFlex.classList.remove('double-left', 'double-right');
                if (!isCover && !isLastSingle) {
                    rFlex.classList.add(i % 2 === 1 ? 'double-left' : 'double-right');
                }
            } else {
                rFlex.classList.remove('double-left', 'double-right');
            }
        }
    }

    function setRImgSize(rImg, w, h) {
        const wrap = rImg.querySelector(':scope > div');
        if (!wrap) return;
        wrap.style.width = w + 'px';
        wrap.style.height = h + 'px';
        wrap.style.maxWidth = w + 'px';
        wrap.style.maxHeight = h + 'px';
        wrap.style.margin = '0';
        const img = wrap.querySelector('img');
        if (img) {
            img.style.width = w + 'px';
            img.style.height = h + 'px';
            img.style.maxWidth = w + 'px';
            img.style.maxHeight = h + 'px';
        }
    }

    // Layout mode (calculateView)
    function calculateView(first) {
        const content = readingContainer;
        const rect = content.getBoundingClientRect();
        rightSize = { width: Math.round(rect.width), height: Math.round(rect.height), scrollHeight: content.scrollHeight };

        if (continuous) {
            /* flex row + wrap so 1 page = one column, 2 pages = two columns; scroll vertical */
            readingTrack.classList.remove('slide-layout', 'compact-layout');
            readingTrack.classList.add('scroll-layout');
            readingTrack.style.width = '100%';
            readingTrack.style.height = '';
            readingTrack.style.flexDirection = 'row';
            readingTrack.style.flexWrap = 'wrap';
            readingTrack.style.transform = '';
            readingTrack.style.direction = mangaRtl ? 'rtl' : 'ltr';

            // Math-based position calculation: no DOM reads (.offsetHeight) needed.
            // Compute each row's height from aspect ratio + container width.
            const n = imageNames.length;
            const bodyDiv = content.querySelector('.reading-body') || content;
            const cW = bodyDiv.offsetWidth || content.clientWidth || 1;
            const isDouble = pagesPerView === 2;
            const gapPx = scrollGap ? 8 : 0;
            let runY = 0;

            // Wipe dict to rebuild row heights
            imagesFullPosition = {};

            for (let i = 0; i < n; i++) {
                const ar = getAspectRatio(i);
                let rowHeight = 0;

                if (!isDouble) {
                    const effW = cW * (scrollWidth / 100);
                    rowHeight = effW / ar;
                    imagesFullPosition[i] = { top: runY, center: runY + rowHeight / 2, bottom: runY + rowHeight, height: rowHeight };
                } else {
                    const isCover = i === 0;
                    const isLastSole = (i === n - 1) && (n % 2 === 1);
                    if (isCover || isLastSole) {
                        const effW = cW * (scrollWidth / 100);
                        rowHeight = effW / ar;
                        imagesFullPosition[i] = { top: runY, center: runY + rowHeight / 2, bottom: runY + rowHeight, height: rowHeight };
                    } else {
                        // Two images per row
                        const nextI = i + 1;
                        const ar1 = ar;
                        const ar2 = nextI < n ? getAspectRatio(nextI) : ar1;
                        const effW = Math.floor((cW / 2) * (scrollWidth / 100));
                        const h1 = effW / ar1;
                        const h2 = effW / ar2;
                        rowHeight = Math.max(h1, h2);

                        imagesFullPosition[i] = { top: runY, center: runY + h1 / 2, bottom: runY + h1, height: h1 };
                        if (nextI < n) {
                            imagesFullPosition[nextI] = { top: runY, center: runY + h2 / 2, bottom: runY + h2, height: h2 };
                            i++; // Skip the next image as we processed it in this row
                        }
                    }
                }

                runY += rowHeight + gapPx;
            }

            unscaledTrackHeight = runY;

            if (!scrollLayerRaf) scrollLayerRaf = requestAnimationFrame(updateScrollLayerClass);
        } else {
            readingTrack.classList.remove('scroll-layout', 'compact-layout');
            readingTrack.classList.add('slide-layout');
            readingTrack.style.flexDirection = '';
            readingTrack.style.direction = mangaRtl ? 'rtl' : '';
            const n = readingTrack.querySelectorAll('.r-flex').length;
            let totalW = pagesPerView === 2
                ? (n <= 1 ? rect.width : rect.width * (1 + (n - 2) * 0.5 + (n % 2 === 1 ? 1 : 0.5)))
                : rect.width * n;
            readingTrack.style.width = totalW + 'px';
            slideTrackTotalW = totalW;
            readingTrack.style.height = rect.height + 'px';
            readingTrack.style.flexDirection = '';
            updateSlideLayerClass();
        }
    }

    /** Add .slide-layer only to prev/current/next spreads to avoid layer explosion */
    function updateSlideLayerClass() {
        if (continuous || !readingTrack.classList.contains('slide-layout')) return;
        readingTrack.querySelectorAll('.r-flex.scroll-layer').forEach(r => r.classList.remove('scroll-layer'));
        const indices = new Set();
        for (let s = -2; s <= 2; s++) {
            const spread0 = currentIndex - 1 + s;
            if (spread0 < 0) continue;
            const spread = getSpreadAt(spread0);
            if (spread) spread.forEach(p => indices.add(p.index));
        }
        readingTrack.querySelectorAll('.r-flex').forEach(r => {
            const i = parseInt(r.dataset.index, 10);
            r.classList.toggle('slide-layer', indices.has(i));
        });
    }

    /** Add .scroll-layer only to items near viewport to limit layers and fix vertical flicker */
    let scrollLayerRaf = 0;
    function updateScrollLayerClass() {
        scrollLayerRaf = 0;
        if (!continuous || !readingTrack.classList.contains('scroll-layout')) return;

        // Map scroll coordinate back from the visually scaled space to unscaled layout space
        const scrollTop = readingContainer.scrollTop / currentScale;
        const viewHeight = rightSize.height / currentScale;

        const center = scrollTop + viewHeight / 2;
        const margin = viewHeight * 1.5;
        const viewTop = center - margin;
        const viewBot = center + margin;

        // Use math-based positions to find visible range (no DOM reads)
        let rangeStart = -1, rangeEnd = -1;
        for (const key in imagesFullPosition) {
            const pos = imagesFullPosition[key];
            if (pos && pos.bottom >= viewTop && pos.top <= viewBot) {
                const k = parseInt(key, 10);
                if (rangeStart < 0 || k < rangeStart) rangeStart = k;
                if (k > rangeEnd) rangeEnd = k;
            }
        }

        // Only toggle classes on elements that changed state
        const rFlexAll = readingTrack.querySelectorAll('.r-flex');
        for (let i = 0, len = rFlexAll.length; i < len; i++) {
            const shouldHave = i >= rangeStart && i <= rangeEnd;
            const has = rFlexAll[i].classList.contains('scroll-layer');
            if (shouldHave !== has) {
                rFlexAll[i].classList.toggle('scroll-layer', shouldHave);
            }
            // Also clear stale slide-layer
            if (rFlexAll[i].classList.contains('slide-layer')) {
                rFlexAll[i].classList.remove('slide-layer');
            }
        }
    }

    /** Pixel offset of the left edge of spread (0-based) in slide mode */
    function getSpreadStartOffset(spreadIndex0, contentWidth) {
        if (spreadIndex0 <= 0) return 0;
        const k = spreadIndex0;
        if (pagesPerView === 2)
            return k * contentWidth;
        return k * contentWidth;
    }

    function returnLargerImage(spreadIndex0) {
        const n = imageNames.length;
        if (pagesPerView === 2) {
            const sp = getSpreadPages(n, spreadIndex0);
            const el0 = readingTrack.querySelectorAll('.r-flex')[sp.idx1];
            const el1 = sp.idx2 != null ? readingTrack.querySelectorAll('.r-flex')[sp.idx2] : null;
            const r0 = el0 ? (el0.querySelector('.r-img') || el0).getBoundingClientRect() : { height: 0, top: 0 };
            const r1 = el1 ? (el1.querySelector('.r-img') || el1).getBoundingClientRect() : { height: 0, top: 0 };
            if (r0.height >= r1.height) return { height: r0.height, top: r0.top };
            return { height: r1.height, top: r1.top };
        }
        const el = readingTrack.querySelectorAll('.r-flex')[spreadIndex0];
        const rImg = el ? el.querySelector('.r-img') : null;
        const r = rImg ? rImg.getBoundingClientRect() : { height: 0, top: 0 };
        return { height: r.height, top: r.top };
    }

    // Go to spread (goToIndex)
    let slideAnimationRaf = 0;
    let slideCurrentTx = 0;
    const slideAnimState = { startTx: 0, targetTx: 0, startTime: 0, durationMs: 0 };
    let slideTransitionEndBound = false;

    /** CSS transition runs on compositor thread, no main-thread stutter */
    function onSlideTransitionEnd() {
        slideAnimationRaf = 0;
        slideCurrentTx = slideAnimState.targetTx;
        preloadImagesAroundCurrent();
    }
    function bindSlideTransitionEnd() {
        if (slideTransitionEndBound) return;
        slideTransitionEndBound = true;
        readingTrack.addEventListener('transitionend', function (e) {
            if (e.target === readingTrack && e.propertyName === 'transform') onSlideTransitionEnd();
        });
    }

    function goToIndex(spreadIndex1Based, animation) {
        const eIndex = Math.max(1, Math.min(spreadIndex1Based, indexNum));
        const content = readingContainer;
        const durationMs = animation ? pageTransitionMs : 0;

        if (continuous) {
            // Use math-based positions (no DOM read / forced reflow)
            const imgIdx = pagesPerView === 2
                ? getSpreadPages(imageNames.length, eIndex - 1).idx1
                : (eIndex - 1);
            const pos = imagesFullPosition[imgIdx];
            if (pos) {
                content.scrollTop = pos.top * currentScale;
            }
            currentIndex = eIndex;
            return;
        }

        /* No layout read in slide path: use cached width so compositor transition isn't delayed */
        const contentWidth = rightSize.width;
        if (!contentWidth) {
            /* First time: instant jump and cache width; next navigation will animate */
            rightSize.width = content.getBoundingClientRect().width;
            slideAnimationRaf = 0;
            readingTrack.style.transition = 'none';
            const ltrOff = getSpreadStartOffset(eIndex - 1, rightSize.width);
            const tx = mangaRtl ? ltrOff - (slideTrackTotalW - rightSize.width) : -ltrOff;
            readingTrack.style.transform = 'translate3d(' + tx + 'px, 0, 0)';
            slideCurrentTx = tx;
            currentIndex = eIndex;
            updateSlideLayerClass();
            return;
        }
        const ltrOff2 = getSpreadStartOffset(eIndex - 1, contentWidth);
        const targetTx = mangaRtl ? ltrOff2 - (slideTrackTotalW - contentWidth) : -ltrOff2;
        if (durationMs <= 0) {
            slideAnimationRaf = 0;
            readingTrack.style.transition = 'none';
            readingTrack.style.transform = 'translate3d(' + targetTx + 'px, 0, 0)';
            slideCurrentTx = targetTx;
            currentIndex = eIndex;
            updateSlideLayerClass();
            return;
        }

        currentIndex = eIndex;
        updateSlideLayerClass();
        slideAnimState.targetTx = targetTx;
        slideAnimationRaf = 1; /* non-zero = animating, so scheduleDisposeAfterLoad defers */
        bindSlideTransitionEnd();
        /* Apply transition in next frame so no layout read + no other DOM work in same frame */
        const durationS = durationMs / 1000;
        const targetTxVal = targetTx;
        requestAnimationFrame(() => {
            readingTrack.style.transition = 'transform ' + durationS + 's cubic-bezier(0.215, 0.61, 0.355, 1)';
            readingTrack.style.transform = 'translate3d(' + targetTxVal + 'px, 0, 0)';
        });
    }

    let onScrollBlock = false;
    let scrollPreloadTimer = 0;
    function onScroll() {
        if (!continuous || onScrollBlock) return;
        const content = readingContainer;
        // Map scrollbar physical visual space back to unscaled layout space
        const scrollTop = content.scrollTop / currentScale;
        const center = scrollTop + (rightSize.height / 2) / currentScale;

        let selKey1 = 0;
        let closest = Infinity;
        for (const key1 in imagesFullPosition) {
            const pos = imagesFullPosition[key1];
            if (!pos) continue;
            if (pos.top <= center && pos.bottom >= center) {
                selKey1 = parseInt(key1, 10);
                break;
            }
            const d = Math.abs(pos.center - center);
            if (d < closest) {
                closest = d;
                selKey1 = parseInt(key1, 10);
            }
        }

        // Secondary fallback: if we yoinked the scrollbar deep, but the layout engine hasn't 
        // measured those pages yet (so imagesFullPosition has huge gaps and closest is far),
        // we map the physical scroll ratio purely mathematically to the image array index.
        if (closest > rightSize.height * 3 && content.scrollHeight > rightSize.height) {
            const ratio = content.scrollTop / (content.scrollHeight - rightSize.height);
            selKey1 = Math.round(ratio * (indexNum - 1));
            // Ensure we map spread blocks accurately in 2-page view
            if (pagesPerView === 2) {
                const sp = getSpreadPages(imageNames.length, selKey1);
                selKey1 = sp.idx1;
            }
        }
        const newIndex = pagesPerView === 2 ? getSpreadForImage(imageNames.length, selKey1) + 1 : selKey1 + 1;
        if (newIndex !== currentIndex) {
            // Clear stale render tasks when user scrolls to a new page
            // so viewport-local images get priority
            renderQueue.clear();
            renderEpoch++;

            currentIndex = newIndex;
            updatePageInfo();
            preloadImagesAroundCurrent();
        }
        /* Keep preload pipeline full: run again after short delay so ahead images are requested early */
        clearTimeout(scrollPreloadTimer);
        scrollPreloadTimer = setTimeout(preloadImagesAroundCurrent, 200);
        savePosition();
        if (!scrollLayerRaf) scrollLayerRaf = requestAnimationFrame(updateScrollLayerClass);
    }

    // Position save/restore
    let savePositionTimer = 0;
    function savePositionImmediate() {
        clearTimeout(savePositionTimer);
        try {
            const data = {
                pagesPerView,
                continuous,
                index: currentIndex,
                spreadIndex: pagesPerView === 2 ? currentSpreadIndex() : undefined
            };
            localStorage.setItem(getPosKey(), JSON.stringify(data));
        } catch (_) { }
    }
    function savePosition() {
        clearTimeout(savePositionTimer);
        savePositionTimer = setTimeout(savePositionImmediate, 100);
    }

    function currentSpreadIndex() {
        if (pagesPerView !== 2) return 0;
        return Math.max(0, Math.min(currentIndex - 1, indexNum - 1));
    }

    function restorePosition() {
        try {
            const raw = localStorage.getItem(getPosKey());
            if (!raw) return;
            const data = JSON.parse(raw);
            if (typeof data.pagesPerView === 'number') pagesPerView = data.pagesPerView === 2 ? 2 : 1;
            if (typeof data.continuous === 'boolean') continuous = data.continuous;
            else if (data.mode === 'scroll') continuous = true;
            else if (data.mode === 'single' || data.mode === 'double') { continuous = false; pagesPerView = data.mode === 'double' ? 2 : 1; }
            syncViewMode();
            updateIndexNum();
            const idx = Math.max(1, Math.min(Number(data.index) || 1, indexNum));
            currentIndex = idx;
        } catch (_) { }
    }

    // Page info & nav
    function updatePageInfo() {
        const total = imageNames.length;
        if (pagesPerView === 2) {
            const spread = getSpreadAt(currentIndex - 1);
            if (spread && spread.length === 2)
                pageInfo.textContent = (spread[0].index + 1) + '-' + (spread[1].index + 1) + ' / ' + total;
            else if (spread && spread[0])
                pageInfo.textContent = (spread[0].index + 1) + ' / ' + total;
            else
                pageInfo.textContent = '1 / ' + total;
        } else {
            const spread = getSpreadAt(currentIndex - 1);
            const first = spread && spread[0];
            pageInfo.textContent = (first ? first.index + 1 : 1) + ' / ' + total;
        }
    }

    function getSpreadAt(spreadIndex0) {
        const n = imageNames.length;
        if (pagesPerView === 2) {
            const sp = getSpreadPages(n, spreadIndex0);
            const out = [{ index: sp.idx1 }];
            if (sp.idx2 != null) out.push({ index: sp.idx2 });
            return out;
        }
        if (spreadIndex0 < 0 || spreadIndex0 >= n) return null;
        return [{ index: spreadIndex0 }];
    }

    /** Current spread's first image index (0-based) for preload center */
    function getCurrentCenterImageIndex() {
        const spread = getSpreadAt(currentIndex - 1);
        return spread && spread[0] ? spread[0].index : 0;
    }

    /** Preload */
    const MAX_PREV = 5;
    const MAX_NEXT = 10;

    function applyPathMapToDom(pathMap, center, priority) {
        if (!pathMap || pathMap.size === 0) return;
        const resolvedIndices = [...pathMap.keys()];
        const dims = archiveUtil.getImageDimensions(filePath, resolvedIndices);
        if (dims && dims.length === resolvedIndices.length) {
            resolvedIndices.forEach((idx, i) => {
                const d = dims[i];
                if (d && d.width > 0 && d.height > 0) {
                    imagesData[idx] = {
                        width: d.width,
                        height: d.height,
                        aspectRatio: d.width / d.height
                    };
                }
            });
        }
        const order = priority ? resolvedIndices : [...pathMap.keys()].sort((a, b) =>
            Math.abs(a - center) - Math.abs(b - center));
        const imgsByIndex = {};
        readingTrack.querySelectorAll('.r-img img').forEach(img => {
            const idx = parseInt(img.dataset.index, 10);
            if (!isNaN(idx) && !img.src) imgsByIndex[idx] = img;
        });
        for (const idx of order) {
            const path = pathMap.get(idx);
            const img = imgsByIndex[idx];
            if (path && img && img.dataset.index === String(idx)) {
                const dist = Math.abs(idx - center);
                let taskPriority = priority ? (1000 - dist) : (100 - dist);
                if (idx === center || (priority && idx > center && idx <= center + 2)) {
                    taskPriority += 2000;
                }

                renderQueue.add(taskPriority, idx, async (abortToken) => {
                    const taskEpoch = renderEpoch;
                    if (img.src) return;

                    if (idx === 0) {
                        img.addEventListener('load', function clearThumbnailPlaceholder() {
                            img.removeEventListener('load', clearThumbnailPlaceholder);
                            const w = img.closest('.r-img > div');
                            if (w) { w.style.backgroundImage = ''; w.style.backgroundSize = ''; w.style.backgroundPosition = ''; w.style.backgroundRepeat = ''; }
                        });
                    }

                    await smartLoadImage(img, path, taskEpoch);

                    if (img.decode) {
                        try { await img.decode(); } catch (_) { }
                    }
                    scheduleDisposeAfterLoad();
                });
            }
        }
    }

    let lastPreloadCenter = 0;
    function preloadImagesAroundCurrent() {
        const currentEpoch = renderEpoch;
        let center = getCurrentCenterImageIndex();

        // Track scroll momentum to bias preloading direction
        let scrollDirection = (center >= lastPreloadCenter) ? 1 : -1;
        lastPreloadCenter = center;

        // Ensure the CURRENT spread (which could be 1 or 2 pages) is the absolute highest priority
        const currentSpread = getSpreadAt(currentIndex - 1) || [];
        let priorityIndices = currentSpread.map(s => s.index);

        const n = imageNames.length;

        // Next priority: The immediate adjacent spreads (Prev and Next). 
        // We calculate what makes up the previous and next spread explicitly.
        const prevSpreadTarget = currentIndex - 2; // Index before the start of current spread
        const nextSpreadTarget = currentIndex - 1 + currentSpread.length; // Index after current spread

        let prevSpreadIdxs = [];
        if (prevSpreadTarget >= 0) {
            const spreadPrev = getSpreadAt(prevSpreadTarget) || [];
            prevSpreadIdxs = spreadPrev.map(s => s.index);
        }

        let nextSpreadIdxs = [];
        if (nextSpreadTarget < n) {
            const spreadNext = getSpreadAt(nextSpreadTarget) || [];
            nextSpreadIdxs = spreadNext.map(s => s.index);
        }

        // Add them to priority queue: favor the scroll-direction's adjacent spread first
        const firstAdjacent = scrollDirection === 1 ? nextSpreadIdxs : prevSpreadIdxs;
        const secondAdjacent = scrollDirection === 1 ? prevSpreadIdxs : nextSpreadIdxs;

        firstAdjacent.forEach(idx => { if (!priorityIndices.includes(idx)) priorityIndices.push(idx); });
        secondAdjacent.forEach(idx => { if (!priorityIndices.includes(idx)) priorityIndices.push(idx); });

        // Dynamically shift the 15/5 preload buffer to match the user's scroll direction
        let effectivePrev = scrollDirection === 1 ? MAX_PREV : MAX_NEXT;
        let effectiveNext = scrollDirection === 1 ? MAX_NEXT : MAX_PREV;

        const minI = Math.max(0, center - effectivePrev);
        const maxI = Math.min(n - 1, center + effectiveNext);
        const restIndices = [];
        for (let i = minI; i <= maxI; i++) {
            if (!priorityIndices.includes(i)) restIndices.push(i);
        }

        /* 1) Load priority first */
        if (priorityIndices.length > 0) {
            const token = { get aborted() { return renderEpoch !== currentEpoch; } };
            archiveUtil.getImagePathsInRange(filePath, priorityIndices, token).then(pathMap => {
                applyPathMapToDom(pathMap, center, true);
            }).catch(() => { });
        }

        /* 2) Load rest of window in background */
        if (restIndices.length > 0) {
            const token = { get aborted() { return renderEpoch !== currentEpoch; } };
            archiveUtil.getImagePathsInRange(filePath, restIndices, token).then(pathMap => {
                applyPathMapToDom(pathMap, center, false);
            }).catch(() => { });
        }
    }

    function updateNav() {
        const canPrev = currentIndex > 1;
        const canNext = currentIndex < indexNum;
        btnPrev.disabled = !canPrev;
        btnNext.disabled = !canNext;
    }

    function go(delta) {
        const newIndex = Math.max(1, Math.min(currentIndex + delta, indexNum));
        if (newIndex === currentIndex) return;

        /* Flush all pending render work so the new page isn't stuck behind old tasks */
        renderQueue.clear();
        renderEpoch++;
        clearTimeout(preloadTimer);

        const anim = !continuous;
        goToIndex(newIndex, anim);
        updatePageInfo();
        updateNav();
        savePosition();

        /* Debounce preloading: only fire 300ms after the last navigation event.
           During rapid key-holds this means work is queued only once the user stops. */
        if (continuous || !anim || pageTransitionMs === 0) {
            preloadTimer = setTimeout(preloadImagesAroundCurrent, 300);
        }
    }

    // View: pages per view (1/2) + continuous toggle
    function applyView() {
        syncViewMode();
        setSetting('pagesPerView', pagesPerView);
        setSetting('continuous', continuous ? 'true' : 'false');
        modeSingle.classList.toggle('active', pagesPerView === 1);
        modeDouble.classList.toggle('active', pagesPerView === 2);
        if (continuousToggle) continuousToggle.classList.toggle('active', continuous);
        toolbar.classList.remove('scroll-mode', 'single-mode', 'double-mode');
        toolbar.classList.add(continuous ? 'scroll-mode' : (pagesPerView === 1 ? 'single-mode' : 'double-mode'));

        /* Reset cached width so goToIndex recalculates from fresh container dimensions */
        rightSize.width = 0;

        readingContainer.classList.remove('width-100', 'width-75', 'width-50', 'scroll-mode');
        if (continuous) {
            readingContainer.classList.add('scroll-mode', 'width-' + scrollWidth);
        } else {
            // Force reset native scroll state so horizontal layout doesn't render permanently off-screen
            readingContainer.scrollTop = 0;
            readingContainer.scrollLeft = 0;
        }

        updateIndexNum();
        if (!readingTrack.querySelector('.r-flex[data-index="0"]')) addHtmlImages();
        else {
            readingTrack.classList.toggle('track-has-gap', scrollGap);
        }
        disposeImages();
        calculateView(true);
        goToIndex(currentIndex, false);
        updatePageInfo();
        updateNav();
        savePosition();
        preloadImagesAroundCurrent();

        if (continuous) {
            readingContainer.removeEventListener('scroll', onScroll);
            readingContainer.addEventListener('scroll', onScroll, { passive: true });
        }
        /* Re-run layout after first frame so container has real size (fixes cover = full width in double on first open) */
        requestAnimationFrame(() => {
            if (!readingTrack.children.length) return;
            disposeImages();
            calculateView(true);
            goToIndex(currentIndex, false);
            if (haveZoom) applyScale(currentScale, false);
        });
    }
    function setPagesPerView(nVal) {
        const oldPv = pagesPerView;
        pagesPerView = nVal === 2 ? 2 : 1;

        if (oldPv !== pagesPerView) {
            const n = imageNames.length;
            if (pagesPerView === 2) {
                currentIndex = getSpreadForImage(n, currentIndex - 1) + 1;
            } else {
                const sp = getSpreadPages(n, currentIndex - 1);
                currentIndex = sp.idx1 + 1;
            }
        }

        resetZoom(); // Always wipe lingering native/transform DOM state explicitly
        applyView();
    }

    function setContinuous(on) {
        const oldCont = continuous;
        continuous = !!on;

        resetZoom(); // Always wipe lingering native/transform DOM state explicitly
        applyView();
    }
    // Scroll options
    function applyScrollOptions() {
        resetZoom();
        readingContainer.classList.remove('width-100', 'width-75', 'width-50');
        if (continuous) readingContainer.classList.add('width-' + scrollWidth);
        if (readingTrack.children.length) {
            // Save scroll fraction before recalculating
            const scrollFrac = continuous && readingContainer.scrollHeight > 0
                ? readingContainer.scrollTop / readingContainer.scrollHeight
                : 0;
            disposeImages();
            calculateView(true);
            if (continuous) {
                // Restore to same proportional position
                readingContainer.scrollTop = scrollFrac * readingContainer.scrollHeight;
            }
        }
    }

    // Scroll options
    function setScrollGap(on) {
        scrollGap = on;
        setSetting('scrollGap', on ? 'true' : 'false');
        if (gapOnIcon) gapOnIcon.classList.toggle('hide', !on);
        if (gapOffIcon) gapOffIcon.classList.toggle('hide', on);
        if (scrollGapToggle) scrollGapToggle.title = on ? 'Gap between images (on)' : 'Gap (off)';
        readingTrack.classList.toggle('track-has-gap', scrollGap);
    }
    function setMangaRtl(on) {
        mangaRtl = on;
        setSetting('mangaRtl', on ? 'true' : 'false');
        if (dirLtrIcon) dirLtrIcon.classList.toggle('hide', on);
        if (dirRtlIcon) dirRtlIcon.classList.toggle('hide', !on);
        if (!continuous) {
            updatePageInfo();
            updateNav();
            disposeImages();
            calculateView(false);
            goToIndex(currentIndex, false);
        }
    }
    function setScrollNavEnabled(on) {
        scrollNavEnabled = on;
        setSetting('scrollNavEnabled', on ? 'true' : 'false');
        if (scrollNavToggle) scrollNavToggle.classList.toggle('scroll-nav-off', !on);
        if (mouseOnIcon) mouseOnIcon.classList.toggle('hide', !on);
        if (mouseOffIcon) mouseOffIcon.classList.toggle('hide', on);
    }
    function setPageTransitionSpeed(ms) {
        pageTransitionMs = ms;
        setSetting('pageTransitionSpeed', String(ms));
        if (transitionSpeedLabel) transitionSpeedLabel.textContent = ms === 0 ? '0' : (ms / 1000) + 's';
        if (transitionSpeedToggle) {
            transitionSpeedToggle.classList.toggle('instant', ms === 0);
            transitionSpeedToggle.title = ms === 0 ? 'Instant' : 'Slide ' + (ms / 1000) + 's';
        }
        if (!continuous && pagesPerView === 1) {
            readingTrack.classList.toggle('compact-layout', ms === 0);
            readingTrack.classList.toggle('slide-layout', ms !== 0);
            calculateView(true);
            goToIndex(currentIndex, false);
        }
    }

    // Zoom — unified scaling model
    const MIN_SCALE = 0.5;
    const MAX_SCALE = 8;
    let zoomTx = 0, zoomTy = 0;

    // Helper: get unscaled track height from math-based positions (no DOM read)
    function getUnscaledTrackHeight() {
        const n = imageNames.length;
        if (n > 0 && imagesFullPosition[n - 1]) {
            return imagesFullPosition[n - 1].bottom;
        }
        // Fallback: compute from last DOM element (only if positions not built yet)
        const last = readingTrack.lastElementChild;
        return last ? (last.offsetTop + last.offsetHeight) : readingContainer.clientHeight;
    }

    // Observer for dynamically loaded images in continuous zoom
    // Observer for dynamically loaded images in continuous zoom is no longer needed 
    // because native layout scaling automatically expands the DOM naturally.
    function getTrackObserver() {
        return null;
    }

    function applyScale(scale, animation, focalX, focalY) {
        const prevScale = currentScale;
        currentScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
        haveZoom = currentScale !== 1;

        readingContainer.style.overflowX = 'hidden';
        readingContainer.style.overflowY = continuous ? 'auto' : 'hidden';

        if (!haveZoom) {
            zoomTx = 0; zoomTy = 0;
            scalePrevData = { tranX: 0, tranX2: 0, tranY: 0, tranY2: 0, scale: 1 };
        }
        if (zoomResetBtn) {
            const label = currentScale === 1 ? '1\u00d7' : currentScale.toFixed(1) + '\u00d7';
            zoomResetBtn.title = `Zoom: ${label} (Click to reset)`;
        }

        const rect = readingContainer.getBoundingClientRect();
        const fX = focalX !== undefined ? focalX : rect.width / 2;
        const fY = focalY !== undefined ? focalY : rect.height / 2;

        if (continuous) {
            const scrollBefore = readingContainer.scrollTop;

            // In continuous mode, Y is handled by the scrollbar.
            const absY = (scrollBefore + fY) / prevScale;
            const newAbsY = absY * currentScale;

            // In continuous mode, X is handled by transform.
            const cx = rect.width / 2;
            const vecX = (fX - cx - zoomTx) / prevScale;

            if (prevScale !== currentScale && prevScale > 0) {
                zoomTx = zoomTx - vecX * (currentScale - prevScale);
            }

            // Loose limits so the image can be panned fully off edge
            const looseMaxTx = rect.width * Math.max(1, currentScale);
            zoomTx = Math.max(-looseMaxTx, Math.min(looseMaxTx, zoomTx));

            if (prevScale !== currentScale && prevScale > 0) {
                scalePrevData.tranX2 = zoomTx;
                scalePrevData.tranY2 = zoomTy;
            }

            // Clear any paged mode zoom
            readingBody.style.transition = 'none';
            readingBody.style.transform = '';

            // Explicitly stretch the layout container so the native scrollbar physically matches the visual CSS zoom geometry
            readingBody.style.height = (unscaledTrackHeight * currentScale) + 'px';

            readingTrack.style.transition = animation ? 'transform 0.2s cubic-bezier(0.2, 0, 0.2, 1)' : 'none';
            // Anchor horizontal scaling to center (50%) to match vecX/cx focal math.
            // Vertical scaling anchors to top (0), scrollbar handles the exact focal placement.
            readingTrack.style.transformOrigin = '50% 0';

            // Because readingTrack is scaled up by `currentScale`, any translation *after* a scale
            // visually multiplies the movement. To keep panning 1:1 with mouse movement (dx),
            // we translate FIRST, then scale.
            readingTrack.style.transform = `translate3d(${zoomTx}px, 0, 0) scale(${currentScale})`;

            // Snap the scrollbar down so the focal point stays under the mouse
            readingContainer.scrollTop = newAbsY - fY;
        } else {
            // Paged mode scales outwards from the very center of the viewport
            const rect = readingContainer.getBoundingClientRect();

            // Unscaled distance from center to finger/mouse
            const cx = rect.width / 2;
            const cy = rect.height / 2;

            const vecX = (fX - cx - zoomTx) / prevScale;
            const vecY = (fY - cy - zoomTy) / prevScale;

            // When scaling up, points move further from center. We shift the other way to pin them.
            if (prevScale !== currentScale && prevScale > 0) {
                zoomTx = zoomTx - vecX * (currentScale - prevScale);
                zoomTy = zoomTy - vecY * (currentScale - prevScale);
            }

            // Absolutely NO bounds clamping during scale application!
            // If we clamp here, the focal point math is broken because the image shifts away from the mouse cursor.
            // This guarantees the point under your cursor stays exactly under your cursor, regardless of image size or aspect ratio.

            if (prevScale !== currentScale && prevScale > 0) {
                scalePrevData.tranX2 = zoomTx;
                scalePrevData.tranY2 = zoomTy;
            }

            readingBody.style.transition = animation ? `transform ${pageTransitionMs / 1000}s` : 'transform 0s';
            // Origin center natively tracks exactly the viewport center without needing track offsets
            readingBody.style.transformOrigin = 'center center';
            readingBody.style.transform = currentScale === 1
                ? ''
                : `translate(${zoomTx}px, ${zoomTy}px) scale(${currentScale})`;

            readingBody.style.height = '100%';
        }

        contentEl.classList.toggle('zoomed', haveZoom);
        scheduleHiResRender();
    }

    /** After zoom settles, re-render visible images at higher resolution via Sharp */
    let hiResTimer = 0;
    function scheduleHiResRender() {
        clearTimeout(hiResTimer);
        if (currentScale <= 1) {
            revertHiRes();
            return;
        }
        hiResTimer = setTimeout(() => {
            const spread = getSpreadAt(currentIndex - 1);
            if (!spread) return;

            spread.forEach(p => {
                const idx = p.index;
                const img = readingTrack.querySelector(`.r-img-i${idx} img`);
                if (!img) return;
                const d = imagesData[idx];
                if (!d || !d.width) return;

                const wrap = img.closest('.r-img > div');
                const explicitW = wrap ? parseInt(wrap.style.width, 10) : 0;
                const displayW = explicitW > 0 ? explicitW : (wrap ? wrap.getBoundingClientRect().width / currentScale : 0);
                if (displayW <= 0) return;

                const dpr = window.devicePixelRatio || 1;
                const targetScale = Math.min(currentScale * dpr, d.width / displayW);
                if (targetScale <= dpr * 1.1) return;

                archiveUtil.renderAtScale(filePath, idx, targetScale).then(async fp => {
                    if (!fp || currentScale <= 1) return;

                    try {
                        const preload = new Image();
                        preload.src = 'file:///' + fp.replace(/\\/g, '/');
                        await preload.decode(); // Wait until decoded in memory (0-frame flicker swap)

                        if (img.dataset.index === String(idx) && currentScale > 1) {
                            if (img.dataset.blobUrl) URL.revokeObjectURL(img.dataset.blobUrl);
                            img.dataset.blobUrl = '';
                            img.dataset.hiRes = '1';
                            img.src = preload.src;
                        }
                    } catch (err) {
                        // Ignore decode errors
                    }
                }).catch(() => { });
            });
        }, 50); // fast snap
    }

    function revertHiRes() {
        readingTrack.querySelectorAll('img[data-hi-res="1"]').forEach(img => {
            const idx = parseInt(img.dataset.index, 10);
            if (isNaN(idx)) return;
            img.dataset.hiRes = '';

            archiveUtil.getImagePath(filePath, idx).then(async fp => {
                if (fp && img.dataset.index === String(idx)) {
                    // Revert to original seamlessly
                    try {
                        const newSrc = 'file:///' + fp.replace(/\\/g, '/');
                        const preload = new Image();
                        preload.src = newSrc;
                        await preload.decode();
                        if (img.dataset.index === String(idx) && currentScale <= 1) {
                            smartLoadImage(img, fp);
                        }
                    } catch (e) {
                        smartLoadImage(img, fp);
                    }
                }
            }).catch(() => { });
        });
    }

    // Helper to get the on-screen focal point of the current image
    function getFocalPoint() {
        const rect = readingContainer.getBoundingClientRect();
        const fX = rect.width / 2;
        let fY = rect.height / 2;

        if (continuous && imagesFullPosition[currentIndex - 1]) {
            // Find where the center of the current image actually is on screen
            const pos = imagesFullPosition[currentIndex - 1];
            const imgCenterY = pos.center; // Already naturally scaled by calculateView
            // Subtract scroll to get screen-relative Y coordinate
            const screenY = imgCenterY - readingContainer.scrollTop;

            // If the image center is completely off-screen, fall back to screen center
            if (screenY >= 0 && screenY <= rect.height) {
                fY = screenY;
            }
        }
        return { fX, fY };
    }

    function zoomIn(fX, fY) {
        const targetScale = currentScale * 1.25;
        if (fX === undefined) { const fp = getFocalPoint(); fX = fp.fX; fY = fp.fY; }
        applyScale(targetScale, !continuous, fX, fY);
    }

    function zoomOut(fX, fY) {
        const targetScale = currentScale / 1.25;
        if (fX === undefined) { const fp = getFocalPoint(); fX = fp.fX; fY = fp.fY; }
        applyScale(targetScale, !continuous, fX, fY);
    }

    function resetZoom() {
        currentScale = 1;
        scalePrevData = { tranX: 0, tranX2: 0, tranY: 0, tranY2: 0, scale: 1 };
        zoomTx = 0; zoomTy = 0;

        readingContainer.style.overflowX = 'hidden';
        readingContainer.style.overflowY = continuous ? 'auto' : 'hidden';

        readingBody.style.transform = '';
        readingBody.style.transition = '';

        // Remove hardcoded inline limits so the generic .scroll-mode CSS logic
        // takes over and rebuilds the scrollbar track properly in continuous view!
        readingBody.style.height = '';
        readingBody.style.transformOrigin = '';
        applyScale(1, false);
    }

    function dragZoom(dx, dy) {
        zoomTx = scalePrevData.tranX2 + dx;
        const rect = readingContainer.getBoundingClientRect();

        const looseMaxTx = (rect.width * currentScale);
        zoomTx = Math.max(-looseMaxTx, Math.min(looseMaxTx, zoomTx));

        if (!continuous) {
            zoomTy = scalePrevData.tranY2 + dy;
            const looseMaxTy = (rect.height * currentScale);
            zoomTy = Math.max(-looseMaxTy, Math.min(looseMaxTy, zoomTy));
        }

        applyScale(currentScale, false); // no focal points, avoid triggering scale math
    }

    function dragZoomEnd() {
        scalePrevData.tranX2 = zoomTx;
        if (!continuous) {
            scalePrevData.tranY2 = zoomTy;
        }
        zoomMoveData.active = false;
    }

    /** Momentum / inertia scrolling for vertical drag release */
    let momentumRaf = 0;
    function momentumScroll(velocity) {
        cancelAnimationFrame(momentumRaf);
        const friction = 0.95;
        const step = () => {
            velocity *= friction;
            if (Math.abs(velocity) < 0.5) return;
            readingContainer.scrollTop += velocity;
            momentumRaf = requestAnimationFrame(step);
        };
        momentumRaf = requestAnimationFrame(step);
    }

    // Events
    btnPrev.addEventListener('click', () => go(-1));
    btnNext.addEventListener('click', () => go(1));
    modeSingle.addEventListener('click', () => setPagesPerView(1));
    modeDouble.addEventListener('click', () => setPagesPerView(2));
    if (continuousToggle) continuousToggle.addEventListener('click', () => setContinuous(!continuous));
    if (scrollGapToggle) scrollGapToggle.addEventListener('click', () => setScrollGap(!scrollGap));
    if (mangaRtlBtn) mangaRtlBtn.addEventListener('click', () => setMangaRtl(!mangaRtl));
    if (scrollNavToggle) scrollNavToggle.addEventListener('click', () => setScrollNavEnabled(!scrollNavEnabled));
    if (transitionSpeedToggle) transitionSpeedToggle.addEventListener('click', () => setPageTransitionSpeed(pageTransitionMs === 0 ? 300 : 0));

    if (contentEl) {
        contentEl.addEventListener('selectstart', e => e.preventDefault());
        contentEl.addEventListener('wheel', e => {
            if (continuous) return;
            if (!scrollNavEnabled) return;
            e.preventDefault();
            go(e.deltaY > 0 ? 1 : -1);
        }, { passive: false });

        // Custom per-image context menu (replaces default browser menu)
        contentEl.addEventListener('contextmenu', onImageContextMenu);

        // Mouse drag handlers
        contentEl.addEventListener('mousedown', e => {
            if (e.button === 2) {
                // Right-click drag → zoom
                e.preventDefault();
                rightDrag = { startX: e.clientX, startY: e.clientY, startScale: currentScale };
                contentEl.classList.add('dragging');
            } else if (e.button === 0) {
                // Left-click drag → navigate (or pan when zoomed)
                if (haveZoom) {
                    // Pan zoomed view
                    e.preventDefault();
                    zoomMoveData = {
                        x: e.clientX,
                        y: e.clientY,
                        active: true,
                        startScroll: readingContainer.scrollTop,
                        velocityHistory: []
                    };
                    contentEl.classList.add('dragging');
                } else if (!continuous && pageTransitionMs === 0) {
                    // Instant mode: no drag, just track clicks for navigation
                    dragNav = {
                        startX: e.clientX,
                        startY: e.clientY,
                        startTx: slideCurrentTx || 0,
                        startScrollTop: readingContainer.scrollTop,
                        moved: false,
                    };
                } else {
                    // Drag to navigate
                    cancelAnimationFrame(momentumRaf); // stop any ongoing momentum
                    dragNav = {
                        startX: e.clientX,
                        startY: e.clientY,
                        startTx: slideCurrentTx || 0,
                        startScrollTop: readingContainer.scrollTop,
                        moved: false,
                    };
                    contentEl.classList.add('dragging');
                }
            }
        });

        window.addEventListener('mousemove', e => {
            if (rightDrag) {
                // Right-drag zoom: up = zoom in, down = zoom out
                const dy = rightDrag.startY - e.clientY;
                const newScale = rightDrag.startScale * Math.pow(1.005, dy);

                const rect = readingContainer.getBoundingClientRect();
                const fX = rightDrag.startX - rect.left;
                const fY = rightDrag.startY - rect.top;

                // Update CSS scale without triggering native recalculations
                applyScale(newScale, false, fX, fY);
            } else if (zoomMoveData.active) {
                // Left-drag pan (zoomed)
                e.preventDefault();
                const dx = e.clientX - zoomMoveData.x;
                const dy = e.clientY - zoomMoveData.y;
                if (continuous) {
                    readingContainer.scrollTop = zoomMoveData.startScroll - dy;
                    const now = performance.now();
                    zoomMoveData.velocityHistory.push({ t: now, y: e.clientY });
                    if (zoomMoveData.velocityHistory.length > 5) zoomMoveData.velocityHistory.shift();
                }
                dragZoom(dx, dy);
            } else if (dragNav) {
                const dx = e.clientX - dragNav.startX;
                const dy = e.clientY - dragNav.startY;
                const maxDiff = Math.max(Math.abs(dx), Math.abs(dy));
                if (maxDiff > 5) dragNav.moved = true;

                if (!continuous && pageTransitionMs > 0) {
                    // Paged: drag the track horizontally with elastic resistance at boundaries
                    const dir = mangaRtl ? -dx : dx;
                    const atStart = currentIndex <= 1 && dir > 0;
                    const atEnd = currentIndex >= indexNum && dir < 0;
                    let effectiveDx = dx;
                    if (atStart || atEnd) {
                        // Rubber-band: reduce movement to 30% beyond boundary
                        effectiveDx = dx * 0.3;
                    }

                    // The physical translation of the track should always match the mouse vector exactly 
                    // (if you drag your mouse 100px right, the track must physically shift 100px right)
                    // We only invert `dir` for calculating if we hit the elastic boundary.
                    const offset = dragNav.startTx + effectiveDx;
                    readingTrack.style.transition = 'none';
                    readingTrack.style.transform = `translateX(${offset}px)`;
                } else if (!continuous) {
                    // Instant mode: don't physically drag, only track moved state
                } else {
                    // Scroll: drag vertically + track velocity for momentum
                    readingContainer.scrollTop = dragNav.startScrollTop - dy;
                    const now = performance.now();
                    if (!dragNav.velocityHistory) dragNav.velocityHistory = [];
                    dragNav.velocityHistory.push({ t: now, y: e.clientY });
                    // Keep only last 5 samples for velocity calculation
                    if (dragNav.velocityHistory.length > 5)
                        dragNav.velocityHistory.shift();
                }
            }
        });

        window.addEventListener('mouseup', e => {
            if (rightDrag) {
                const dx = e.clientX - rightDrag.startX;
                const dy = e.clientY - rightDrag.startY;
                rightDragUsed = Math.abs(dx) > 3 || Math.abs(dy) > 3;

                rightDrag = null;
                contentEl.classList.remove('dragging');
                if (Math.abs(currentScale - 1) < 0.05) resetZoom();
            } else if (zoomMoveData.active) {
                if (continuous) {
                    const hist = zoomMoveData.velocityHistory;
                    if (hist && hist.length >= 2) {
                        const last = hist[hist.length - 1];
                        const first = hist[0];
                        const dt = last.t - first.t;
                        if (dt > 0 && dt < 300) {
                            const vy = -(last.y - first.y) / dt * 16;
                            momentumScroll(vy);
                        }
                    }
                }
                dragZoomEnd();
                contentEl.classList.remove('dragging');
            } else if (dragNav) {
                const wasDrag = dragNav.moved;
                contentEl.classList.remove('dragging');

                if (!wasDrag) {
                    // Click (no drag): navigate
                    if (e.button === 0) go(-1);
                } else if (!continuous) {
                    // Paged: snap to nearest page (with boundary awareness)
                    const dx = e.clientX - dragNav.startX;
                    const threshold = readingContainer.getBoundingClientRect().width * 0.05;
                    const dir = mangaRtl ? -dx : dx;
                    if (dir < -threshold && currentIndex < indexNum) go(1);
                    else if (dir > threshold && currentIndex > 1) go(-1);
                    else goToIndex(currentIndex, true); // snap back
                } else if (wasDrag) {
                    // Scroll: apply momentum
                    const hist = dragNav.velocityHistory;
                    if (hist && hist.length >= 2) {
                        const last = hist[hist.length - 1];
                        const first = hist[0];
                        const dt = last.t - first.t;
                        if (dt > 0 && dt < 300) {
                            const vy = -(last.y - first.y) / dt * 16; // px per frame
                            momentumScroll(vy);
                        }
                    }
                }
                dragNav = null;
            }
        });

        // Cancel all drags when mouse leaves reader or window loses focus
        function cancelAllDrags() {
            if (rightDrag) {
                rightDrag = null;
                contentEl.classList.remove('dragging');
                if (Math.abs(currentScale - 1) < 0.05) resetZoom();
            }
            if (zoomMoveData.active) {
                dragZoomEnd();
                contentEl.classList.remove('dragging');
            }
            if (dragNav) {
                if (!continuous && dragNav.moved) {
                    goToIndex(currentIndex, false); // snap back
                }
                contentEl.classList.remove('dragging');
                dragNav = null;
            }
        }
        document.addEventListener('mouseleave', cancelAllDrags);
        window.addEventListener('blur', cancelAllDrags);
    }

    if (zoomInBtn) zoomInBtn.addEventListener('click', () => zoomIn());
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => zoomOut());
    if (zoomResetBtn) zoomResetBtn.addEventListener('click', () => resetZoom());

    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (mangaRtl && !continuous) {
            if (e.key === 'ArrowLeft') { e.preventDefault(); go(1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); go(-1); }
        } else {
            if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
        }
    });

    window.addEventListener('resize', () => {
        if (!readingTrack.children.length) return;
        if (haveZoom) resetZoom();
        disposeImages();
        calculateView(false);
        // Both paged and continuous need to snap back to the active page after layout changes
        goToIndex(currentIndex, false);
    });

    window.addEventListener('beforeunload', () => {
        savePositionImmediate();
        archiveUtil.cleanup(filePath);
    });

    // ── Per-image context menu ──────────────────────────────────────────
    const isCBZ = pathModule.extname(filePath).toLowerCase() === '.cbz';

    function getImageIndexFromEvent(e) {
        let el = e.target;
        while (el && el !== contentEl) {
            if (el.classList && el.classList.contains('r-flex') && el.dataset.index !== undefined) {
                return parseInt(el.dataset.index, 10);
            }
            el = el.parentElement;
        }
        return -1;
    }

    function getPageLabel(idx) {
        const name = imageNames[idx] || '';
        const basename = name.replace(/^.*[\\/]/, '');
        return `Page ${idx + 1} – ${basename}`;
    }

    async function unpackImage(idx) {
        try {
            const fp = await archiveUtil.getImagePath(filePath, idx);
            if (!fp) throw new Error('Image not extracted');
            const item = fileId ? await eagle.item.getById(fileId) : null;
            const basename = (imageNames[idx] || 'image').replace(/^.*[\\/]/, '');
            const name = pathModule.basename(basename, pathModule.extname(basename));
            const opts = {};
            if (item) {
                if (item.tags && item.tags.length) opts.tags = item.tags;
                if (item.folders && item.folders.length) opts.folders = item.folders;
            }
            await eagle.item.addFromPath(fp, { name, ...opts });
            eagle.notification.show({ duration: 3000, title: 'Image Unpacked', body: getPageLabel(idx) });
        } catch (err) {
            console.error('Unpack failed:', err);
            eagle.notification.show({ duration: 3000, title: 'Unpack Failed', body: err.message });
        }
    }

    async function setAsThumbnail(idx) {
        try {
            const fp = await archiveUtil.getImagePath(filePath, idx);
            if (!fp) throw new Error('Image not extracted');
            if (!fileId) throw new Error('No file ID');
            const item = await eagle.item.getById(fileId);
            await item.setCustomThumbnail(fp);
            eagle.notification.show({ duration: 3000, title: 'Thumbnail Updated', body: getPageLabel(idx) });
        } catch (err) {
            console.error('Set thumbnail failed:', err);
            eagle.notification.show({ duration: 3000, title: 'Thumbnail Failed', body: err.message });
        }
    }

    async function removeFromArchive(idx) {
        if (!isCBZ) return;
        const entryName = imageNames[idx];
        if (!entryName) return;
        try {
            const result = await eagle.dialog.showMessageBox({
                type: 'warning',
                title: 'Remove from Archive',
                message: `Remove "${getPageLabel(idx)}" from archive?\n\nThis cannot be undone.`,
                buttons: ['Cancel', 'Remove'],
            });
            if (result.response !== 1) return;

            await archiveUtil.removeEntryCBZ(filePath, entryName);

            // Reload viewer with updated archive
            const savedIndex = currentIndex;
            imageNames = await archiveUtil.listImages(filePath);
            if (imageNames.length === 0) {
                readingTrack.innerHTML = '<div style="padding:20px;text-align:center;color:var(--color-text-secondary)">Archive is empty</div>';
                return;
            }
            updateIndexNum();
            readingTrack.innerHTML = '';
            addHtmlImages();
            currentIndex = Math.min(savedIndex, indexNum);
            disposeImages();
            calculateView(true);
            goToIndex(currentIndex, false);
            updatePageInfo();
            updateNav();
            preloadImagesAroundCurrent();

            eagle.notification.show({ duration: 3000, title: 'Image Removed', body: getPageLabel(Math.min(idx, imageNames.length - 1)) });
        } catch (err) {
            console.error('Remove failed:', err);
            eagle.notification.show({ duration: 3000, title: 'Remove Failed', body: err.message });
        }
    }

    function onImageContextMenu(e) {
        // Suppress menu after right-drag zoom gesture
        if (rightDragUsed) {
            rightDragUsed = false;
            e.preventDefault();
            return;
        }
        const idx = getImageIndexFromEvent(e);
        if (idx < 0) return; // Not on an image

        e.preventDefault();
        const menuItems = [
            { id: 'unpack', label: 'Unpack Image to Eagle', click: () => unpackImage(idx) },
            { id: 'thumbnail', label: 'Set as Thumbnail', click: () => setAsThumbnail(idx) },
        ];
        if (isCBZ) {
            menuItems.push({ id: 'remove', label: 'Remove from Archive', click: () => removeFromArchive(idx) });
        }
        eagle.contextMenu.open(menuItems);
    }

    // Init
    if (!filePath) {
        console.error('No file path provided.');
        return;
    }

    archiveUtil.listImages(filePath).then(names => {
        imageNames = names;
        if (names.length === 0) {
            console.error('No images found in archive.');
            return;
        }

        setScrollGap(scrollGap);
        setMangaRtl(mangaRtl);
        setScrollNavEnabled(scrollNavEnabled);
        setPageTransitionSpeed(pageTransitionMs);
        restorePosition();
        applyView();
        updatePageInfo();
        updateNav();
    }).catch(err => {
        console.error('Failed to load archive:', err);
    });
})();
