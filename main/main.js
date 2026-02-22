/**
 * CBZ Creator – Window plugin for creating CBZ archives from selected Eagle images.
 * Uses yazl with compress: false (STORE method) for zero-overhead archiving.
 */
const path = require('path');
const fs = require('fs');
const pluginRoot = path.join(__dirname, '..');
const yazl = require(path.join(pluginRoot, 'node_modules', 'yazl'));

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif']);

let items = []; // Eagle Item objects
let listEl, emptyEl, nameInput, btnCreate, statusEl;
let dragReorder = { fromIndex: -1 }; // drag-to-reorder state

// ── Eagle lifecycle ─────────────────────────────────────────

eagle.onPluginCreate((plugin) => {
    console.log('CBZ Creator: onPluginCreate', plugin.manifest.name);

    listEl = document.getElementById('image-list');
    emptyEl = document.getElementById('empty-state');
    nameInput = document.getElementById('cbz-name');
    btnCreate = document.getElementById('btn-create');
    statusEl = document.getElementById('status');

    btnCreate.addEventListener('click', createCBZ);
    nameInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') createCBZ();
    });
    nameInput.addEventListener('input', updateButtonState);

    // Close button (frameless window)
    const btnClose = document.getElementById('btn-close');
    if (btnClose) {
        btnClose.addEventListener('click', () => eagle.window.hide());
    }

    // Drag and drop support
    setupDragDrop();
});

eagle.onPluginRun(() => {
    console.log('CBZ Creator: onPluginRun');
    loadSelected();
});

eagle.onPluginShow(() => {
    console.log('CBZ Creator: onPluginShow');
    // Refresh selection each time the window is shown
    loadSelected();
});

// ── Load selected images ────────────────────────────────────

async function loadSelected() {
    try {
        const selected = await eagle.item.getSelected();
        const imageItems = selected.filter(item => {
            const ext = ('.' + (item.ext || '')).toLowerCase();
            return IMAGE_EXTS.has(ext);
        });

        if (imageItems.length > 0) {
            // Merge with existing items (avoid duplicates by id)
            const existingIds = new Set(items.map(it => it.id));
            for (const item of imageItems) {
                if (!existingIds.has(item.id)) {
                    items.push(item);
                }
            }
        }

        updateUI();

        // Prefill name from currently selected folder (if not already set)
        if (!nameInput.value) {
            try {
                const folders = await eagle.folder.getSelected();
                if (folders && folders.length > 0 && folders[0].name) {
                    nameInput.value = folders[0].name;
                }
            } catch (_) { }
            updateButtonState();
        }
    } catch (err) {
        console.error('Failed to load selected items:', err);
        statusEl.textContent = 'Error loading items';
    }
}

// ── Drag and drop ───────────────────────────────────────────

function setupDragDrop() {
    const dropTarget = document.body;

    dropTarget.addEventListener('dragover', e => {
        e.preventDefault();
        e.stopPropagation();
        listEl.classList.add('drag-over');
    });

    dropTarget.addEventListener('dragleave', e => {
        e.preventDefault();
        e.stopPropagation();
        listEl.classList.remove('drag-over');
    });

    dropTarget.addEventListener('drop', async e => {
        e.preventDefault();
        e.stopPropagation();
        listEl.classList.remove('drag-over');

        const files = e.dataTransfer.files;
        if (!files || files.length === 0) return;

        const existingIds = new Set(items.map(it => it.id));

        for (const file of files) {
            const ext = path.extname(file.name).toLowerCase();
            if (!IMAGE_EXTS.has(ext)) continue;

            // Create a pseudo-item for dropped files (not from Eagle)
            const pseudoItem = {
                id: 'drop_' + Date.now() + '_' + Math.random().toString(36).slice(2),
                name: path.basename(file.name, ext),
                ext: ext.slice(1),
                filePath: file.path,
                size: file.size,
                width: 0,
                height: 0,
                thumbnailURL: '',
            };

            if (!existingIds.has(pseudoItem.id)) {
                items.push(pseudoItem);
                existingIds.add(pseudoItem.id);
            }
        }

        updateUI();
    });
}

// ── UI ──────────────────────────────────────────────────────

function updateUI() {
    if (items.length === 0) {
        emptyEl.style.display = '';
        statusEl.textContent = 'No images selected';
    } else {
        emptyEl.style.display = 'none';
        statusEl.textContent = items.length + ' image' + (items.length > 1 ? 's' : '');
    }

    updateButtonState();
    renderList();
}

function updateButtonState() {
    btnCreate.disabled = items.length === 0 || !nameInput.value.trim();
}

function renderList() {
    // Clear existing items but keep empty state
    listEl.querySelectorAll('.image-item').forEach(el => el.remove());

    items.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = 'image-item';
        row.draggable = true;
        row.dataset.index = i;

        // Drag handle
        const handle = document.createElement('div');
        handle.className = 'drag-handle';
        handle.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';

        // Reorder drag events
        row.addEventListener('dragstart', e => {
            dragReorder.fromIndex = i;
            row.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(i));
        });
        row.addEventListener('dragend', () => {
            row.classList.remove('dragging');
            dragReorder.fromIndex = -1;
            listEl.querySelectorAll('.drag-over-row').forEach(el => el.classList.remove('drag-over-row'));
        });
        row.addEventListener('dragover', e => {
            if (dragReorder.fromIndex < 0) return; // external drop, ignore
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            listEl.querySelectorAll('.drag-over-row').forEach(el => el.classList.remove('drag-over-row'));
            row.classList.add('drag-over-row');
        });
        row.addEventListener('dragleave', () => {
            row.classList.remove('drag-over-row');
        });
        row.addEventListener('drop', e => {
            e.preventDefault();
            row.classList.remove('drag-over-row');
            const from = dragReorder.fromIndex;
            const to = i;
            if (from < 0 || from === to) return;
            const [moved] = items.splice(from, 1);
            items.splice(to, 0, moved);
            dragReorder.fromIndex = -1;
            renderList();
        });

        const thumb = document.createElement('img');
        thumb.className = 'thumb';
        thumb.draggable = false;
        // Use thumbnailURL for Eagle items, or try to load from filePath for drops
        if (item.thumbnailURL) {
            thumb.src = item.thumbnailURL;
        } else if (item.filePath) {
            thumb.src = 'file:///' + item.filePath.replace(/\\/g, '/');
        }
        thumb.alt = '';
        thumb.onerror = () => { thumb.style.display = 'none'; };

        const info = document.createElement('div');
        info.className = 'info';

        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = item.name + '.' + item.ext;

        const meta = document.createElement('div');
        meta.className = 'meta';
        const size = item.size ? formatSize(item.size) : '';
        const dims = (item.width && item.height) ? item.width + '×' + item.height : '';
        meta.textContent = [dims, size].filter(Boolean).join(' · ');

        info.appendChild(name);
        info.appendChild(meta);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn-remove';
        removeBtn.title = 'Remove from list';
        removeBtn.innerHTML = '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        removeBtn.addEventListener('click', () => {
            items.splice(i, 1);
            updateUI();
        });

        row.appendChild(handle);
        row.appendChild(thumb);
        row.appendChild(info);
        row.appendChild(removeBtn);
        listEl.appendChild(row);
    });
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Create CBZ ──────────────────────────────────────────────

async function createCBZ() {
    if (items.length === 0) return;

    const archiveName = (nameInput.value.trim() || 'archive');
    btnCreate.disabled = true;
    btnCreate.classList.add('working');
    statusEl.textContent = 'Creating CBZ…';

    try {
        // Determine target folder: currently selected folder in Eagle
        let targetFolders = [];
        try {
            const selectedFolders = await eagle.folder.getSelected();
            if (selectedFolders && selectedFolders.length > 0) {
                targetFolders = [selectedFolders[0].id];
            }
        } catch (_) { }

        // Build CBZ in temp directory
        const tmpDir = path.join(eagle.os.tmpdir(), 'eagle-cbz-creator-' + Date.now());
        fs.mkdirSync(tmpDir, { recursive: true });
        const tmpFile = path.join(tmpDir, archiveName + '.cbz');

        await new Promise((resolve, reject) => {
            const zip = new yazl.ZipFile();
            const ws = fs.createWriteStream(tmpFile);
            zip.outputStream.pipe(ws);

            // Track filenames to avoid duplicates
            const usedNames = new Set();

            items.forEach((item, i) => {
                const ext = '.' + (item.ext || 'jpg');
                // Zero-pad page number for natural sort order
                const pad = String(i + 1).padStart(String(items.length).length + 1, '0');
                let fileName = pad + '_' + sanitize(item.name) + ext;

                // Deduplicate
                let base = fileName;
                let counter = 2;
                while (usedNames.has(fileName.toLowerCase())) {
                    fileName = base.replace(ext, '_' + counter + ext);
                    counter++;
                }
                usedNames.add(fileName.toLowerCase());

                zip.addFile(item.filePath, fileName, { compress: false });
            });

            zip.end();

            ws.on('finish', resolve);
            ws.on('error', reject);
        });

        statusEl.textContent = 'Adding to Eagle…';

        // Add CBZ to Eagle
        const opts = { name: archiveName };
        if (targetFolders.length > 0) opts.folders = targetFolders;
        await eagle.item.addFromPath(tmpFile, opts);

        // Cleanup temp
        try {
            fs.unlinkSync(tmpFile);
            fs.rmdirSync(tmpDir);
        } catch (_) { }

        statusEl.textContent = 'Done! ' + archiveName + '.cbz created';
        eagle.notification.show({
            duration: 3000,
            title: 'CBZ Created',
            body: archiveName + '.cbz – ' + items.length + ' images',
        });

        // Reset state for next creation
        items = [];
        nameInput.value = '';
        updateUI();

    } catch (err) {
        console.error('CBZ creation failed:', err);
        statusEl.textContent = 'Error: ' + err.message;
        eagle.notification.show({
            duration: 3000,
            title: 'CBZ Creation Failed',
            body: err.message,
        });
    } finally {
        btnCreate.disabled = false;
        btnCreate.classList.remove('working');
    }
}

function sanitize(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
}
