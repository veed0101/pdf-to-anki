/**
 * PDF → Anki — Client-side converter
 *
 * Pipeline:
 *   1. PDF.js renders each page to a <canvas>
 *   2. For each column (0 = left card, 1 = right card), crop:
 *        top-row box → front image
 *        bottom-row box → back image
 *   3. sql.js builds an Anki 2.1-compatible SQLite database
 *   4. JSZip packages db + images into a .apkg file
 *   5. Browser triggers a download
 *
 * Layout constants mirror generate_template.py exactly.
 */

'use strict';

// ─── Layout constants (must match generate_template.py) ───────────────────────
const PAGE_W = 792;   // landscape US Letter
const PAGE_H = 612;
const MARGIN = 25;
const GAP = 18;
const ROWS = 2;
const COLS = 2;
const BORDER_INSET = 10; // px inside box border to fully clear the rounded corners

const BOX_W = (PAGE_W - 2 * MARGIN - (COLS - 1) * GAP) / COLS;
const BOX_H = (PAGE_H - 2 * MARGIN - (ROWS - 1) * GAP) / ROWS;
const OFFSET_X = (PAGE_W - (COLS * BOX_W + (COLS - 1) * GAP)) / 2;
const OFFSET_Y = (PAGE_H - (ROWS * BOX_H + (ROWS - 1) * GAP)) / 2;

// Fixed Anki model ID (stable across exports so re-imports update the same model)
const MODEL_ID = 1706888194;

// ─── Library init ─────────────────────────────────────────────────────────────
let SQL = null;  // sql.js instance

pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

async function initSQLite() {
    if (SQL) return;
    SQL = await initSqlJs({
        locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
    return h;
}

/** Deterministic GUID: same deck + card index always produces the same 16-char hex string */
function guidFor(deckName, cardIndex) {
    const h1 = djb2(deckName + '::a::' + cardIndex);
    const h2 = djb2(deckName + '::b::' + cardIndex);
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** SHA-1 checksum of the sort field (used by Anki for duplicate detection) */
async function fieldChecksum(text) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    return parseInt(hex.slice(0, 8), 16);
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

// ─── PDF processing ───────────────────────────────────────────────────────────
/** Render a PDF page to a canvas at the given DPI */
async function renderPage(page, dpi) {
    const scale = dpi / 72;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return { canvas, scale };
}

/** Crop a sub-rectangle out of a canvas and return it as a PNG Blob */
function cropToBlob(src, x, y, w, h) {
    const dst = document.createElement('canvas');
    dst.width = w; dst.height = h;
    dst.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
    return new Promise(res => dst.toBlob(res, 'image/png'));
}

/** Extract the 4 card images from a rendered page canvas */
async function extractCards(canvas, scale) {
    const cards = [];
    for (let col = 0; col < COLS; col++) {
        const pairs = [];
        for (let row = 0; row < ROWS; row++) {
            const px = Math.round((OFFSET_X + col * (BOX_W + GAP)) * scale) + BORDER_INSET;
            const py = Math.round((OFFSET_Y + row * (BOX_H + GAP)) * scale) + BORDER_INSET;
            const pw = Math.round(BOX_W * scale) - 2 * BORDER_INSET;
            const ph = Math.round(BOX_H * scale) - 2 * BORDER_INSET;
            pairs.push(await cropToBlob(canvas, px, py, pw, ph));
        }
        // pairs[0] = front (top row), pairs[1] = back (bottom row)
        cards.push({ front: pairs[0], back: pairs[1] });
    }
    return cards; // 2 cards per page
}

// ─── Anki database ─────────────────────────────────────────────────────────────
function buildSchema(db) {
    db.run(`CREATE TABLE col (id integer NOT NULL, crt integer NOT NULL, mod integer NOT NULL,
    scm integer NOT NULL, ver integer NOT NULL, dty integer NOT NULL, usn integer NOT NULL,
    ls integer NOT NULL, conf text NOT NULL, models text NOT NULL, decks text NOT NULL,
    dconf text NOT NULL, tags text NOT NULL)`);
    db.run(`CREATE TABLE notes (id integer NOT NULL, guid text NOT NULL, mid integer NOT NULL,
    mod integer NOT NULL, usn integer NOT NULL, tags text NOT NULL, flds text NOT NULL,
    sfld integer NOT NULL, csum integer NOT NULL, flags integer NOT NULL, data text NOT NULL)`);
    db.run(`CREATE TABLE cards (id integer NOT NULL, nid integer NOT NULL, did integer NOT NULL,
    ord integer NOT NULL, mod integer NOT NULL, usn integer NOT NULL, type integer NOT NULL,
    queue integer NOT NULL, due integer NOT NULL, ivl integer NOT NULL, factor integer NOT NULL,
    reps integer NOT NULL, lapses integer NOT NULL, left integer NOT NULL, odue integer NOT NULL,
    odid integer NOT NULL, flags integer NOT NULL, data text NOT NULL)`);
    db.run(`CREATE TABLE revlog (id integer NOT NULL, cid integer NOT NULL, usn integer NOT NULL,
    ease integer NOT NULL, ivl integer NOT NULL, lastIvl integer NOT NULL, factor integer NOT NULL,
    time integer NOT NULL, type integer NOT NULL)`);
    db.run(`CREATE TABLE graves (usn integer NOT NULL, oid integer NOT NULL, type integer NOT NULL)`);
}

async function buildAnkiDb(cardInfoList, deckName) {
    const db = new SQL.Database();
    buildSchema(db);

    const now = Math.floor(Date.now() / 1000);
    const nowMs = Date.now();
    const deckId = (djb2(deckName + '_deck') % 2147483647) + 1;

    // ── Model JSON ──
    const model = {
        [MODEL_ID]: {
            id: MODEL_ID, name: 'PDF Flashcard', type: 0, mod: now, usn: -1, sortf: 0, did: null,
            tmpls: [{
                name: 'Card 1', ord: 0,
                qfmt: '{{FrontImage}}',
                afmt: '{{FrontSide}}<hr id=answer>{{BackImage}}',
                bqfmt: '', bafmt: '', did: null, bfont: 'Arial', bsize: 12
            }],
            flds: [
                { name: 'FrontImage', ord: 0, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
                { name: 'BackImage', ord: 1, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] }
            ],
            css: '.card{font-family:arial;font-size:20px;text-align:center;color:black;background-color:white}img{max-width:100%;max-height:85vh;object-fit:contain}',
            latexPre: '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
            latexPost: '\\end{document}', latexsvg: false, req: [[0, 'any', [0]]]
        }
    };

    // ── Deck JSON ──
    const decks = {
        1: {
            id: 1, name: 'Default', desc: '', extendRev: 50, usn: 0, collapsed: false,
            browserCollapsed: false, newToday: [0, 0], revToday: [0, 0], lrnToday: [0, 0],
            timeToday: [0, 0], dyn: 0, extendNew: 10, conf: 1, mod: now
        },
        [deckId]: {
            id: deckId, name: deckName, desc: '', extendRev: 50, usn: -1,
            collapsed: false, browserCollapsed: false, newToday: [0, 0], revToday: [0, 0],
            lrnToday: [0, 0], timeToday: [0, 0], dyn: 0, extendNew: 10, conf: 1, mod: now
        }
    };

    const dconf = {
        1: {
            id: 1, mod: 0, name: 'Default', usn: 0, maxTaken: 60, autoplay: true, timer: 0,
            replayq: true,
            new: { bury: false, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 0], order: 1, perDay: 20, separate: true },
            lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 },
            rev: { bury: false, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, minSpace: 1, perDay: 100 }
        }
    };

    const conf = {
        activeDecks: [deckId], curDeck: deckId, newSpread: 0, collapseTime: 1200, timeLim: 0,
        estTimes: true, dueCounts: true, curModel: MODEL_ID,
        nextPos: cardInfoList.length + 1, sortType: 'noteFld', sortBackwards: false,
        addToCur: true, dayLearnFirst: false, newBury: true
    };

    db.run('INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [
        1, now, nowMs, nowMs, 11, 0, 0, 0,
        JSON.stringify(conf), JSON.stringify(model), JSON.stringify(decks), JSON.stringify(dconf), '{}'
    ]);

    // ── Notes + Cards ──
    for (let i = 0; i < cardInfoList.length; i++) {
        const { frontName, backName } = cardInfoList[i];
        const noteId = nowMs + i * 10;
        const cardId = nowMs + i * 10 + 5;
        const guid = guidFor(deckName, i);
        const flds = `<img src="${frontName}">\x1f<img src="${backName}">`;
        const csum = await fieldChecksum(frontName);
        db.run('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            [noteId, guid, MODEL_ID, now, -1, '', flds, frontName, csum, 0, '']);
        db.run('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [cardId, noteId, deckId, 0, now, -1, 0, 0, i, 0, 0, 0, 0, 0, 0, 0, 0, '']);
    }

    const bytes = db.export();
    db.close();
    return bytes;
}

// ─── Package builder ──────────────────────────────────────────────────────────
async function buildApkg(allCards, deckName) {
    const zip = new JSZip();
    const mediaMap = {};
    const cardInfo = [];
    let mediaIndex = 0;

    for (let i = 0; i < allCards.length; i++) {
        const frontName = `front_${String(i).padStart(4, '0')}.png`;
        const backName = `back_${String(i).padStart(4, '0')}.png`;

        mediaMap[String(mediaIndex)] = frontName;
        zip.file(String(mediaIndex), allCards[i].front);
        mediaIndex++;

        mediaMap[String(mediaIndex)] = backName;
        zip.file(String(mediaIndex), allCards[i].back);
        mediaIndex++;

        cardInfo.push({ frontName, backName });
    }

    const dbBytes = await buildAnkiDb(cardInfo, deckName);
    zip.file('collection.anki2', dbBytes);
    zip.file('media', JSON.stringify(mediaMap));

    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

// ─── UI wiring ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const dropZone = $('drop-zone');
const fileInput = $('file-input');
const fileRow = $('file-row');
const fileNameEl = $('file-name');
const fileSizeEl = $('file-size');
const clearBtn = $('clear-btn');
const deckInput = $('deck-name');
const dpiSelect = $('dpi-select');
const convertBtn = $('convert-btn');
const btnLabel = $('btn-label');
const btnSpinner = $('btn-spinner');
const progressWrap = $('progress-wrap');
const progressBar = $('progress-bar');
const progressLabel = $('progress-label');
const statusMsg = $('status-msg');

let selectedFile = null;

// Drag & drop
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(e => {
    document.addEventListener(e, ev => ev.preventDefault());
});
['dragenter', 'dragover'].forEach(e => dropZone.addEventListener(e, () => dropZone.classList.add('drag-over')));
['dragleave', 'drop'].forEach(e => dropZone.addEventListener(e, () => dropZone.classList.remove('drag-over')));

dropZone.addEventListener('drop', ev => handleFile(ev.dataTransfer.files[0]));
fileInput.addEventListener('change', ev => handleFile(ev.target.files[0]));
dropZone.addEventListener('click', ev => { if (ev.target !== fileInput) fileInput.click(); });
clearBtn.addEventListener('click', clearFile);

function handleFile(file) {
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
        return showStatus('Please select a PDF file.', 'error');
    }
    selectedFile = file;
    fileNameEl.textContent = file.name;
    fileSizeEl.textContent = formatBytes(file.size);
    if (!deckInput.value.trim()) deckInput.value = file.name.replace(/\.pdf$/i, '');
    dropZone.classList.add('hidden');
    fileRow.classList.remove('hidden');
    convertBtn.disabled = false;
    clearStatus();
}

function clearFile() {
    selectedFile = null;
    fileInput.value = '';
    deckInput.value = '';
    dropZone.classList.remove('hidden');
    fileRow.classList.add('hidden');
    convertBtn.disabled = true;
    clearStatus();
    setProgress(0, '');
}

function setProgress(pct, label) {
    if (pct > 0) {
        progressWrap.classList.remove('hidden');
        progressLabel.classList.remove('hidden');
    } else {
        progressWrap.classList.add('hidden');
        progressLabel.classList.add('hidden');
    }
    progressBar.style.width = Math.round(pct) + '%';
    progressLabel.textContent = label;
}

function showStatus(msg, type) {
    statusMsg.textContent = msg;
    statusMsg.className = `status-msg ${type}`;
    statusMsg.classList.remove('hidden');
}

function clearStatus() {
    statusMsg.classList.add('hidden');
    statusMsg.className = 'status-msg hidden';
}

function setBusy(busy) {
    convertBtn.disabled = busy;
    btnLabel.textContent = busy ? 'Converting…' : 'Convert to Anki Deck';
    btnSpinner.classList.toggle('hidden', !busy);
}

// ─── Main conversion ──────────────────────────────────────────────────────────
convertBtn.addEventListener('click', async () => {
    if (!selectedFile) return;
    clearStatus();
    setBusy(true);

    try {
        await initSQLite();

        const dpi = parseInt(dpiSelect.value, 10);
        const deckName = deckInput.value.trim() || selectedFile.name.replace(/\.pdf$/i, '');

        const arrayBuffer = await selectedFile.arrayBuffer();
        const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const totalPages = pdfDoc.numPages;

        const allCards = [];

        for (let p = 1; p <= totalPages; p++) {
            setProgress(
                ((p - 1) / totalPages) * 90,
                `Processing page ${p} of ${totalPages}…`
            );
            const page = await pdfDoc.getPage(p);
            const { canvas, scale } = await renderPage(page, dpi);
            const cards = await extractCards(canvas, scale);
            allCards.push(...cards);
        }

        setProgress(95, 'Packaging deck…');
        const blob = await buildApkg(allCards, deckName);

        setProgress(100, 'Done!');

        // Build a proper File object with the .apkg name baked in
        const fileName = `${deckName}.apkg`;
        const apkgFile = new File([blob], fileName, { type: 'application/octet-stream' });

        // On mobile: use Web Share API to send directly to AnkiDroid
        if (navigator.canShare && navigator.canShare({ files: [apkgFile] })) {
            try {
                await navigator.share({ files: [apkgFile], title: fileName });
                showStatus(`✓ Shared "${fileName}" — ${allCards.length} cards!`, 'success');
                return; // skip the fallback download
            } catch (shareErr) {
                if (shareErr.name === 'AbortError') {
                    showStatus('Share cancelled.', 'error');
                    return;
                }
                // Share failed for another reason — fall through to download
            }
        }

        // Fallback: trigger a regular download (works on desktop)
        const url = URL.createObjectURL(apkgFile);
        const a = document.createElement('a');
        a.href = url; a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

    } catch (err) {
        console.error(err);
        showStatus('Error: ' + err.message, 'error');
    } finally {
        setBusy(false);
        setTimeout(() => setProgress(0, ''), 3000);
    }
});
