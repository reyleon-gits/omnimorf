// ═══════════════════════════════════════════════════════════════
//  Omnimorf — Electron Main Process
//  Universal file converter with native binary integration
//
//  Copyright (c) 2026 Green Aventurine Consulting, LLC
//  Creator: Blanton Banks II
//  All Rights Reserved. Proprietary — see LICENSE for terms.
//
//  Use of this source code is governed by the Omnimorf Proprietary
//  Source License. Use of the compiled application is governed by
//  the End User License Agreement (EULA.md).
//
//  On-chain authorship proof: Polygon contract
//  0x72dB28F53B97d7BBd19beA25856Bc7B6D9fFc7Bc (2026-04-05)
// ═══════════════════════════════════════════════════════════════

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const https = require('https');
const crypto = require('crypto');
const { execFile, execSync } = require('child_process');
const { autoUpdater } = require('electron-updater');
const Tesseract = require('tesseract.js');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const { marked } = require('marked');

// ── Polar.sh license configuration ───────────────────────────
// PASTE YOUR POLAR.SH ORGANIZATION ID HERE (UUID format)
// Find it: Polar.sh dashboard → Settings → Organization → Copy ID
const POLAR_ORG_ID = '8f6465a8-d819-475d-809e-ac034a76b3df';
const POLAR_API_BASE = 'https://api.polar.sh/v1';

// Organization Access Token from Polar.sh
// Create at: Polar.sh dashboard → Settings → Developers → New Token
// Required scopes: license_keys:read, license_keys:write
const POLAR_ACCESS_TOKEN = 'polar_oat_Fh1qijibnQvNY3zvs0ltDnUW5cBT9IcsmrR9y2tdBPY';

// Map Polar product IDs → tier name
// (Kept for fallback / future API changes — Polar currently does NOT
// include product_id in license key responses, so this rarely matches.)
const POLAR_PRODUCT_TIER_MAP = {
    '53d8141f-495b-4f08-a3e2-689149997860': 'personal',
    'aa0b8c02-82db-411c-b0bc-bcd72a63db0e': 'pro',
    'a93da143-d422-4c98-9b8e-79c6b3d49032': 'lifetime',
    '9304d9c4-7bd6-4e4d-8dc3-5fdce6a7eb71': 'team',
    '3b512133-38e8-4bf7-9cdd-bde9946ac86b': 'enterprise',
};

// Map Polar BENEFIT IDs → tier name
// THIS IS THE PRIMARY MAPPING. Polar's license key responses include
// `benefit_id`, which uniquely identifies the license-key benefit attached
// to each product. Find these in Polar.sh dashboard → Benefits, OR by
// running: curl -H "Authorization: Bearer $TOKEN" \
//   "https://api.polar.sh/v1/benefits/?organization_id=$ORG_ID"
const POLAR_BENEFIT_TIER_MAP = {
    '2a6c6ac6-b1f9-4abf-b0fd-912a82c90473': 'personal',   // Activation Key Personal
    'aa37223a-5dfc-434e-8e8b-0519ffc932c2': 'pro',        // Activation Key Pro
    '9fd99f57-86ab-4daf-acc5-413ec33501eb': 'lifetime',   // Activation Key Lifetime
    '1c3ddbee-3db5-4591-bd0e-c25eb5ea0dc2': 'team',       // Activation Key Team
    'ae6bcb9e-c399-43f1-88ff-f2702d46304c': 'enterprise', // Activation Key Enterprise
};

// License storage
const LICENSE_FILE = path.join(app.getPath('userData'), 'license.json');

function readLicense() {
    try { return JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8')); }
    catch { return null; }
}
function writeLicense(data) {
    fs.writeFileSync(LICENSE_FILE, JSON.stringify(data, null, 2));
}
function clearLicense() {
    try { fs.unlinkSync(LICENSE_FILE); } catch {}
}

// Stable per-device label (machine + user)
function deviceLabel() {
    return `${os.hostname()}-${os.userInfo().username}-${process.platform}`;
}

// ── Hardware fingerprint ─────────────────────────────────────
// SHA-256 of stable hardware traits. Used to bind a license.json to
// a specific machine so a copied license file fails on another device.
// Inputs are intentionally narrow: traits that change rarely (CPU model,
// total RAM, platform/arch, primary MAC, hostname, username).
function machineFingerprint() {
    try {
        const cpu = (os.cpus()[0] || {}).model || 'unknown';
        const ram = os.totalmem();
        const ifaces = os.networkInterfaces();
        let mac = '';
        for (const name of Object.keys(ifaces)) {
            for (const i of ifaces[name] || []) {
                if (!i.internal && i.mac && i.mac !== '00:00:00:00:00:00') { mac = i.mac; break; }
            }
            if (mac) break;
        }
        const raw = [cpu, ram, os.platform(), os.arch(), mac, os.hostname(), os.userInfo().username].join('|');
        return crypto.createHash('sha256').update(raw).digest('hex');
    } catch {
        return 'unknown';
    }
}

// Recursively walk an object/array and find any string value that matches
// a key in the provided map. Returns { tier, matchedId, path } or null.
// This is bulletproof against Polar moving fields around between API versions.
function findTierInResponse(obj, productMap, path = '') {
    if (obj == null) return null;
    if (typeof obj === 'string') {
        if (productMap[obj]) return { tier: productMap[obj], matchedId: obj, path };
        return null;
    }
    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            const r = findTierInResponse(obj[i], productMap, `${path}[${i}]`);
            if (r) return r;
        }
        return null;
    }
    if (typeof obj === 'object') {
        for (const key of Object.keys(obj)) {
            const r = findTierInResponse(obj[key], productMap, path ? `${path}.${key}` : key);
            if (r) return r;
        }
    }
    return null;
}

// Promise wrapper for HTTPS POST
function polarPost(endpoint, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            'Accept': 'application/json'
        };
        if (POLAR_ACCESS_TOKEN && POLAR_ACCESS_TOKEN !== 'REPLACE_WITH_YOUR_POLAR_ACCESS_TOKEN') {
            headers['Authorization'] = 'Bearer ' + POLAR_ACCESS_TOKEN;
        }
        const req = https.request({
            hostname: 'api.polar.sh',
            port: 443,
            path: '/v1' + endpoint,
            method: 'POST',
            headers
        }, res => {
            let chunks = '';
            res.on('data', c => chunks += c);
            res.on('end', () => {
                try {
                    const parsed = chunks ? JSON.parse(chunks) : {};
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
                    else reject({ status: res.statusCode, body: parsed });
                } catch (e) { reject({ status: res.statusCode, body: chunks }); }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// ── Single instance lock ─────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

let mainWindow = null;

// ── Paths to bundled native binaries ─────────────────────────
const BINARIES_DIR = app.isPackaged
    ? path.join(process.resourcesPath, 'binaries')
    : path.join(__dirname, 'binaries');

const BIN = {
    ffmpeg:      path.join(BINARIES_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    imagemagick: path.join(BINARIES_DIR, process.platform === 'win32' ? 'magick.exe' : 'magick'),
};

// ── LibreOffice detection (document conversion engine) ──────
// Checks standard system installation paths per platform, then PATH.
// Returns the full path to soffice binary, or null if not installed.
function findLibreOffice() {
    const systemPaths = {
        win32: [
            path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'LibreOffice', 'program', 'soffice.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LibreOffice', 'program', 'soffice.exe'),
            'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        ],
        darwin: [
            '/Applications/LibreOffice.app/Contents/MacOS/soffice',
            path.join(os.homedir(), 'Applications', 'LibreOffice.app', 'Contents', 'MacOS', 'soffice'),
        ],
        linux: [
            '/usr/bin/soffice',
            '/usr/bin/libreoffice',
            '/usr/lib/libreoffice/program/soffice',
            '/snap/bin/libreoffice',
            '/usr/local/bin/soffice',
            '/opt/libreoffice/program/soffice',
            path.join(os.homedir(), '.local', 'bin', 'soffice'),
        ],
    };

    // Check user-downloaded portable (stored in userData)
    const userDataLO = path.join(app.getPath('userData'), 'libreoffice');
    const portableSoffice = process.platform === 'win32'
        ? path.join(userDataLO, 'program', 'soffice.exe')
        : path.join(userDataLO, 'program', 'soffice');
    if (fs.existsSync(portableSoffice)) return portableSoffice;

    // Check system installation paths
    for (const p of (systemPaths[process.platform] || [])) {
        if (p && fs.existsSync(p)) return p;
    }

    // Check PATH
    try {
        const cmd = process.platform === 'win32' ? 'where soffice 2>nul' : 'which soffice 2>/dev/null';
        const result = execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim().split(/\r?\n/)[0];
        if (result && fs.existsSync(result)) return result;
    } catch {}

    return null;
}

// ── Vault directory ──────────────────────────────────────────
const VAULT_DIR = path.join(app.getPath('userData'), 'vault');
const VAULT_INDEX = path.join(VAULT_DIR, 'vault-index.json');

function ensureVaultDir() {
    if (!fs.existsSync(VAULT_DIR)) fs.mkdirSync(VAULT_DIR, { recursive: true });
    if (!fs.existsSync(VAULT_INDEX)) fs.writeFileSync(VAULT_INDEX, '[]');
}

// ── Create window ────────────────────────────────────────────
function createWindow() {
    mainWindow = new BrowserWindow({
        width:          1100,
        height:         720,
        minWidth:       800,
        minHeight:      560,
        title:          'Omnimorf',
        icon:           path.join(__dirname, 'assets',
                            process.platform === 'win32' ? 'icon.ico' :
                            process.platform === 'darwin' ? 'icon.icns' : 'icon.png'),
        backgroundColor:'#070711',
        show:           false,
        webPreferences: {
            preload:          path.join(__dirname, 'preload.js'),
            nodeIntegration:  false,
            contextIsolation: true,
            webSecurity:      true
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; });

    // ── Production hardening ─────────────────────────────────
    // Block DevTools, view-source, and inspect shortcuts in packaged builds.
    // Dev mode (npm start) keeps everything available for debugging.
    if (app.isPackaged) {
        mainWindow.webContents.on('devtools-opened', () => mainWindow.webContents.closeDevTools());
        mainWindow.webContents.on('before-input-event', (event, input) => {
            const k = (input.key || '').toLowerCase();
            const block =
                (input.control && input.shift && (k === 'i' || k === 'j' || k === 'c')) ||
                (input.meta && input.alt && (k === 'i' || k === 'j' || k === 'c')) ||
                k === 'f12' ||
                (input.control && k === 'u');
            if (block) event.preventDefault();
        });
        // Block any window from navigating away or opening external pages
        mainWindow.webContents.setWindowOpenHandler(({ url }) => {
            shell.openExternal(url);
            return { action: 'deny' };
        });
        mainWindow.webContents.on('will-navigate', (e, url) => {
            if (!url.startsWith('file://')) e.preventDefault();
        });
    }
}

// ── Second-instance: focus existing window ───────────────────
app.on('second-instance', (event, argv) => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
        const mediaFiles = argv.filter(a => /\.(heic|heif|jpg|jpeg|png|webp|bmp|gif|tiff?|svg|avif|ico|mp4|mov|avi|mkv|webm|wmv|flv|mp3|wav|flac|aac|ogg|m4a|opus|pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|tsv|txt|md|html?|epub|json|xml)$/i.test(a));
        if (mediaFiles.length) sendFilesToRenderer(mediaFiles);
    }
});

// ── Auto-updater (checks GitHub Releases — fully offline between checks) ──
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', (info) => {
    if (!mainWindow) return;
    dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Available',
        message: `Omnimorf v${info.version} is available`,
        detail: 'A new version is ready. Download now? It will install when you restart.',
        buttons: ['Download', 'Later'],
        defaultId: 0
    }).then(({ response }) => {
        if (response === 0) autoUpdater.downloadUpdate();
    });
});

autoUpdater.on('update-downloaded', () => {
    if (!mainWindow) return;
    dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Ready',
        message: 'Update downloaded successfully.',
        detail: 'Restart Omnimorf now to install the update?',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0
    }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
    });
});

autoUpdater.on('error', (err) => {
    console.log('[Omnimorf Updater] Error:', err.message);
});

// ── App ready ────────────────────────────────────────────────
app.whenReady().then(() => {
    ensureVaultDir();
    createWindow();
    buildMenu();

    // Check for updates 5 seconds after launch (packaged builds only)
    if (app.isPackaged) {
        setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// ── Open files via native dialog ─────────────────────────────
async function openFilesDialog() {
    if (!mainWindow) return;
    const result = await dialog.showOpenDialog(mainWindow, {
        title:      'Open Files',
        buttonLabel:'Convert',
        filters: [
            { name: 'Images', extensions: ['heic', 'heif', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tiff', 'tif', 'svg', 'avif', 'ico'] },
            { name: 'Video',  extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv'] },
            { name: 'Audio',  extensions: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus'] },
            { name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'odt', 'ott', 'fodt', 'rtf', 'wpd', 'wps', 'wri', 'abw', 'sxw', 'xls', 'xlsx', 'xlsm', 'xlt', 'xltx', 'xlsb', 'ods', 'ots', 'fods', 'csv', 'tsv', 'dif', 'slk', 'dbf', 'wk1', 'wk3', 'wk4', '123', 'sxc', 'ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'ppsm', 'pot', 'potx', 'potm', 'odp', 'otp', 'fodp', 'sxi', 'txt', 'log', 'nfo', 'ini', 'cfg', 'md', 'html', 'htm', 'xhtml', 'mht', 'mhtml', 'xml', 'json', 'yaml', 'yml', 'toml', 'tex', 'rst', 'org', 'epub', 'fb2'] },
            { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile', 'multiSelections']
    });
    if (!result.canceled && result.filePaths.length) {
        sendFilesToRenderer(result.filePaths);
    }
}

// ── Read files from disk → send to renderer ──────────────────
function sendFilesToRenderer(filePaths) {
    if (!mainWindow) return;
    const files = filePaths
        .filter(p => fs.existsSync(p))
        .map(p => {
            const buffer = fs.readFileSync(p);
            return {
                name: path.basename(p),
                size: buffer.length,
                buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
            };
        });
    if (files.length) mainWindow.webContents.send('omnimorf:open-files', files);
}

// ── IPC: Open file dialog ────────────────────────────────────
ipcMain.on('omnimorf:request-open', () => openFilesDialog());

// ── IPC: Convert file via native binaries ────────────────────
ipcMain.handle('omnimorf:convert-file', async (event, { buffer, name, targetFormat, quality, category, ocr }) => {
    const tempDir = path.join(app.getPath('temp'), 'omnimorf-convert');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const inputPath = path.join(tempDir, 'input-' + Date.now() + '-' + name);
    const outputPath = path.join(tempDir, 'output-' + Date.now() + '.' + targetFormat);

    fs.writeFileSync(inputPath, Buffer.from(buffer));

    try {
        if (ocr) {
            await ocrConvert(inputPath, outputPath, targetFormat);
        } else if (category === 'video' || category === 'audio') {
            await ffmpegConvert(inputPath, outputPath, category, quality);
        } else if (category === 'image') {
            await imageMagickConvert(inputPath, outputPath, quality);
        } else if (category === 'document') {
            await documentConvert(inputPath, outputPath, targetFormat);
        } else {
            throw new Error('Unsupported conversion category: ' + category);
        }

        const resultBuffer = fs.readFileSync(outputPath);
        return { buffer: resultBuffer.buffer.slice(resultBuffer.byteOffset, resultBuffer.byteOffset + resultBuffer.byteLength) };
    } finally {
        try { fs.unlinkSync(inputPath); } catch {}
        try { fs.unlinkSync(outputPath); } catch {}
    }
});

// ── FFmpeg conversion ────────────────────────────────────────
function ffmpegConvert(input, output, category, quality) {
    return new Promise((resolve, reject) => {
        const args = ['-i', input, '-y'];

        if (category === 'video') {
            const crf = Math.round(51 - (quality * 51)); // quality 0-1 → CRF 51-0
            args.push('-c:v', 'libx264', '-crf', String(crf), '-preset', 'medium', '-c:a', 'aac');
        } else if (category === 'audio') {
            const bitrate = Math.round(64 + (quality * 256)); // 64-320 kbps
            args.push('-b:a', bitrate + 'k');
        }

        args.push(output);

        execFile(BIN.ffmpeg, args, { timeout: 300000 }, (err, stdout, stderr) => {
            if (err) reject(new Error('FFmpeg failed: ' + (stderr || err.message)));
            else resolve();
        });
    });
}

// ── ImageMagick conversion ───────────────────────────────────
function imageMagickConvert(input, output, quality) {
    return new Promise((resolve, reject) => {
        const q = Math.round(quality * 100);
        const ext = path.extname(output).slice(1).toLowerCase();
        const args = ['convert', input];

        // ICO / ICNS need multi-size embedding for OS-level icons
        if (ext === 'ico') {
            args.push('-define', 'icon:auto-resize=16,24,32,48,64,128,256');
        } else if (ext === 'icns') {
            args.push('-define', 'icns:auto-resize=16,32,64,128,256,512');
        }

        // Quality only meaningful for lossy encoders
        const lossy = ['jpg', 'jpeg', 'webp', 'avif', 'heic', 'heif', 'jxl', 'jp2'];
        if (lossy.includes(ext)) args.push('-quality', String(q));

        // SVG output: ImageMagick rasterizes — let it through (vector trace not supported)
        args.push(output);

        execFile(BIN.imagemagick, args, { timeout: 120000 }, (err, stdout, stderr) => {
            if (err) reject(new Error('ImageMagick failed: ' + (stderr || err.message)));
            else resolve();
        });
    });
}

// ── OCR Engine (Tesseract.js — Maximum Precision) ───────────
// Uses tessdata_best LSTM model for highest accuracy on numbers,
// symbols, and mixed-format documents. Worker is lazy-initialized,
// reused across requests, and terminated on app quit.
let ocrWorker = null;

async function getOcrWorker() {
    if (!ocrWorker) {
        const tessdataPath = path.join(BINARIES_DIR, 'tessdata');
        const cachePath = path.join(app.getPath('userData'), 'tessdata-cache');
        if (!fs.existsSync(cachePath)) fs.mkdirSync(cachePath, { recursive: true });

        // OEM.DEFAULT (3) = best available engine (LSTM preferred, legacy fallback)
        ocrWorker = await Tesseract.createWorker('eng', Tesseract.OEM.DEFAULT, {
            langPath: fs.existsSync(tessdataPath) ? tessdataPath : cachePath,
            cachePath: cachePath,
        });

        // Maximum fidelity settings
        await ocrWorker.setParameters({
            preserve_interword_spaces: '1',   // Keep exact spacing between words
            tessedit_char_whitelist: '',       // Empty = recognize ALL characters (no restriction)
            tessedit_pageseg_mode: '3',        // Fully automatic page segmentation
        });
    }
    return ocrWorker;
}

async function ocrConvert(inputPath, outputPath, targetFormat) {
    // For non-PNG/JPG sources, convert to PNG first (Tesseract works best with PNG/JPG)
    let ocrInputPath = inputPath;
    const ext = path.extname(inputPath).toLowerCase().replace('.', '');
    const needsPreConvert = !['png', 'jpg', 'jpeg', 'bmp', 'tiff', 'tif', 'webp'].includes(ext);
    if (needsPreConvert) {
        ocrInputPath = inputPath + '.ocr-prep.png';
        await imageMagickConvert(inputPath, ocrInputPath, 1.0);
    }

    const worker = await getOcrWorker();
    const { data } = await worker.recognize(ocrInputPath);

    try {
        if (targetFormat === 'txt') {
            // Preserve exact line breaks, spacing, and paragraph structure
            fs.writeFileSync(outputPath, data.text || '', 'utf8');
        } else if (targetFormat === 'pdf') {
            const pdfBytes = await generateSearchablePdf(data, ocrInputPath);
            fs.writeFileSync(outputPath, pdfBytes);
        } else if (targetFormat === 'docx') {
            const docxBytes = await generatePrecisionDocx(data);
            fs.writeFileSync(outputPath, docxBytes);
        } else {
            throw new Error('Unsupported OCR output format: ' + targetFormat);
        }
    } finally {
        if (needsPreConvert) { try { fs.unlinkSync(ocrInputPath); } catch {} }
    }
}

// ── Searchable PDF: original image + invisible text overlay ──
// The gold standard for OCR PDFs. The image is visible, the OCR text
// is positioned at exact bounding box coordinates as an invisible layer.
// Result: visually identical to the original, fully searchable/selectable.
async function generateSearchablePdf(ocrData, imagePath) {
    const doc = await PDFDocument.create();
    const imageBytes = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();

    // Embed image (convert to PNG via ImageMagick if format not supported by pdf-lib)
    let image;
    if (ext === '.png') {
        image = await doc.embedPng(imageBytes);
    } else if (['.jpg', '.jpeg'].includes(ext)) {
        image = await doc.embedJpg(imageBytes);
    } else {
        // Convert to PNG for embedding
        const tmpPng = imagePath + '.embed.png';
        await imageMagickConvert(imagePath, tmpPng, 1.0);
        const pngBytes = fs.readFileSync(tmpPng);
        image = await doc.embedPng(pngBytes);
        try { fs.unlinkSync(tmpPng); } catch {}
    }

    const imgW = image.width;
    const imgH = image.height;

    // Scale to fit within Letter bounds while preserving aspect ratio
    const MAX_W = 612;
    const MAX_H = 792;
    const scale = Math.min(MAX_W / imgW, MAX_H / imgH, 1);
    const pageW = imgW * scale;
    const pageH = imgH * scale;

    const page = doc.addPage([pageW, pageH]);

    // Layer 1: Original image as background (visible)
    page.drawImage(image, { x: 0, y: 0, width: pageW, height: pageH });

    // Layer 2: OCR text overlay (invisible — for search/select/copy)
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const lines = ocrData.lines || [];

    for (const line of lines) {
        const words = line.words || [];
        for (const word of words) {
            const txt = (word.text || '').trim();
            if (!txt) continue;

            const bbox = word.bbox;
            if (!bbox) continue;

            // Scale bounding box from image coords to page coords
            const x = bbox.x0 * scale;
            const wordH = (bbox.y1 - bbox.y0) * scale;
            // PDF y-axis is bottom-up; Tesseract bbox y-axis is top-down
            const y = pageH - (bbox.y1 * scale);

            // Font size derived from word height for precise positioning
            const fontSize = Math.max(Math.round(wordH * 0.85), 4);

            page.drawText(txt, {
                x: x,
                y: y,
                size: fontSize,
                font: font,
                color: rgb(0, 0, 0),
                opacity: 0.001, // Near-invisible: searchable/selectable but not visually disruptive
            });
        }
    }

    return Buffer.from(await doc.save());
}

// ── Precision DOCX: preserves paragraph + line structure ─────
// Each Tesseract paragraph becomes a DOCX paragraph.
// Each line within a paragraph becomes a line break (soft return).
// Preserves the exact visual structure of the original document.
async function generatePrecisionDocx(ocrData) {
    const paragraphs = [];
    const blocks = ocrData.paragraphs || [];

    if (blocks.length > 0) {
        // Use Tesseract's paragraph/line detection for structure-aware output
        for (const para of blocks) {
            const lines = para.lines || [];
            const children = [];

            for (let i = 0; i < lines.length; i++) {
                const lineText = (lines[i].text || '').trimEnd();
                if (i > 0) children.push(new TextRun({ break: 1 })); // Soft line break
                children.push(new TextRun({ text: lineText, size: 24, font: 'Calibri' }));
            }

            paragraphs.push(new Paragraph({
                children: children,
                spacing: { after: 120 }, // 6pt paragraph spacing
            }));
        }
    } else {
        // Fallback: split on double newlines for paragraphs, single for lines
        const rawParagraphs = (ocrData.text || '').split(/\n\s*\n/);
        for (const rawPara of rawParagraphs) {
            const lines = rawPara.split('\n');
            const children = [];
            for (let i = 0; i < lines.length; i++) {
                if (i > 0) children.push(new TextRun({ break: 1 }));
                children.push(new TextRun({ text: lines[i].trimEnd(), size: 24, font: 'Calibri' }));
            }
            paragraphs.push(new Paragraph({
                children: children,
                spacing: { after: 120 },
            }));
        }
    }

    const doc = new Document({
        sections: [{
            properties: {
                page: {
                    margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }, // 1 inch = 1440 twips
                },
            },
            children: paragraphs,
        }],
    });

    return await Packer.toBuffer(doc);
}

// Terminate OCR worker on app quit
app.on('will-quit', () => {
    if (ocrWorker) { ocrWorker.terminate(); ocrWorker = null; }
});

// ═══════════════════════════════════════════════════════════════
//  DOCUMENT CONVERSION ENGINE — 200+ formats
//  Architecture: JS fast-path (mammoth, SheetJS, marked, pdf-lib)
//  for common conversions + LibreOffice headless for everything else.
//  70+ input formats × 18 output targets = 700+ conversion paths.
// ═══════════════════════════════════════════════════════════════

// ── LibreOffice headless wrapper ────────────────────────────
function libreOfficeConvert(soffficePath, inputPath, outputFormat, outDir) {
    return new Promise((resolve, reject) => {
        // LibreOffice --convert-to uses filter names for some formats
        const filterMap = {
            'csv':  'csv:"Text - txt - csv (StarCalc)":44,34,76,1',
            'txt':  'txt:"Text (encoded):UTF8"',
        };
        const convertArg = filterMap[outputFormat] || outputFormat;

        const args = ['--headless', '--norestore', '--convert-to', convertArg, '--outdir', outDir, inputPath];
        execFile(soffficePath, args, { timeout: 180000 }, (err, stdout, stderr) => {
            if (err) reject(new Error('LibreOffice failed: ' + (stderr || err.message)));
            else resolve();
        });
    });
}

// ── JS Fast-Path: DOCX → HTML ──────────────────────────────
async function docxToHtml(inputPath) {
    const result = await mammoth.convertToHtml({ path: inputPath });
    return result.value;
}

// ── JS Fast-Path: DOCX → TXT ───────────────────────────────
async function docxToText(inputPath) {
    const result = await mammoth.extractRawText({ path: inputPath });
    return result.value;
}

// ── JS Fast-Path: DOCX → PDF (mammoth → HTML → printToPDF) ─
async function docxToPdf(inputPath, outputPath) {
    const html = await docxToHtml(inputPath);
    const styledHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.5;margin:1in;color:#000;}
table{border-collapse:collapse;width:100%;}td,th{border:1px solid #999;padding:4px 8px;}
img{max-width:100%;}</style></head><body>${html}</body></html>`;
    await htmlStringToPdf(styledHtml, outputPath);
}

// ── JS Fast-Path: XLSX/XLS/ODS → CSV ───────────────────────
function spreadsheetToCsv(inputPath) {
    const workbook = XLSX.readFile(inputPath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_csv(sheet);
}

// ── JS Fast-Path: XLSX/XLS/ODS → JSON ──────────────────────
function spreadsheetToJson(inputPath) {
    const workbook = XLSX.readFile(inputPath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return JSON.stringify(XLSX.utils.sheet_to_json(sheet), null, 2);
}

// ── JS Fast-Path: XLSX/XLS/ODS → HTML ──────────────────────
function spreadsheetToHtml(inputPath) {
    const workbook = XLSX.readFile(inputPath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const html = XLSX.utils.sheet_to_html(sheet);
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{font-family:Arial,sans-serif;margin:1em;}table{border-collapse:collapse;width:100%;}
td,th{border:1px solid #ccc;padding:4px 8px;text-align:left;}th{background:#f0f0f0;font-weight:bold;}</style>
</head><body>${html}</body></html>`;
}

// ── JS Fast-Path: XLSX/XLS/ODS → TXT ───────────────────────
function spreadsheetToTxt(inputPath) {
    const workbook = XLSX.readFile(inputPath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_txt(sheet);
}

// ── JS Fast-Path: CSV/TSV → XLSX ───────────────────────────
function csvToXlsx(inputPath, outputPath) {
    const workbook = XLSX.readFile(inputPath);
    XLSX.writeFile(workbook, outputPath);
}

// ── JS Fast-Path: Markdown → HTML ──────────────────────────
function mdToHtml(inputPath) {
    const mdContent = fs.readFileSync(inputPath, 'utf8');
    const html = marked(mdContent);
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{font-family:Georgia,serif;font-size:11pt;line-height:1.6;margin:1in;color:#222;max-width:800px;}
code{background:#f4f4f4;padding:2px 6px;border-radius:3px;font-size:0.9em;}
pre{background:#f4f4f4;padding:12px;border-radius:6px;overflow-x:auto;}
pre code{background:none;padding:0;}blockquote{border-left:4px solid #ddd;margin:1em 0;padding:0.5em 1em;color:#555;}
table{border-collapse:collapse;width:100%;}td,th{border:1px solid #ddd;padding:6px 12px;}
h1,h2,h3{color:#111;}</style></head><body>${html}</body></html>`;
}

// ── JS Fast-Path: HTML → TXT ───────────────────────────────
function htmlToText(inputPath) {
    const html = fs.readFileSync(inputPath, 'utf8');
    return html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<\/tr>/gi, '\n')
        .replace(/<\/h[1-6]>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ── JS Fast-Path: TXT → PDF ────────────────────────────────
async function textToPdf(text, outputPath) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Courier);
    const fontSize = 10;
    const margin = 72; // 1 inch
    const pageW = 612;
    const pageH = 792;
    const usableW = pageW - 2 * margin;
    const usableH = pageH - 2 * margin;
    const lineH = fontSize * 1.4;
    const maxCharsPerLine = Math.floor(usableW / (fontSize * 0.6));
    const maxLinesPerPage = Math.floor(usableH / lineH);

    // Word-wrap text into lines
    const rawLines = text.split('\n');
    const wrappedLines = [];
    for (const raw of rawLines) {
        if (raw.length <= maxCharsPerLine) {
            wrappedLines.push(raw);
        } else {
            let remaining = raw;
            while (remaining.length > maxCharsPerLine) {
                let breakAt = remaining.lastIndexOf(' ', maxCharsPerLine);
                if (breakAt <= 0) breakAt = maxCharsPerLine;
                wrappedLines.push(remaining.substring(0, breakAt));
                remaining = remaining.substring(breakAt).trimStart();
            }
            wrappedLines.push(remaining);
        }
    }

    // Paginate
    for (let i = 0; i < wrappedLines.length; i += maxLinesPerPage) {
        const page = doc.addPage([pageW, pageH]);
        const pageLines = wrappedLines.slice(i, i + maxLinesPerPage);
        for (let j = 0; j < pageLines.length; j++) {
            // Sanitize: replace characters not in WinAnsiEncoding with '?'
            const safeLine = pageLines[j].replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
            page.drawText(safeLine, {
                x: margin,
                y: pageH - margin - (j * lineH),
                size: fontSize,
                font: font,
                color: rgb(0, 0, 0),
            });
        }
    }

    fs.writeFileSync(outputPath, await doc.save());
}

// ── JS Fast-Path: TXT → DOCX ───────────────────────────────
async function textToDocx(text, outputPath) {
    const paragraphs = text.split(/\n\s*\n/).map(block => {
        const lines = block.split('\n');
        const children = [];
        for (let i = 0; i < lines.length; i++) {
            if (i > 0) children.push(new TextRun({ break: 1 }));
            children.push(new TextRun({ text: lines[i], size: 24, font: 'Calibri' }));
        }
        return new Paragraph({ children, spacing: { after: 120 } });
    });

    const doc = new Document({
        sections: [{
            properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
            children: paragraphs,
        }],
    });

    fs.writeFileSync(outputPath, await Packer.toBuffer(doc));
}

// ── HTML → PDF via hidden Electron BrowserWindow ────────────
async function htmlStringToPdf(htmlContent, outputPath) {
    const win = new BrowserWindow({
        show: false,
        width: 800,
        height: 1100,
        webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
    });

    const tempHtml = path.join(app.getPath('temp'), 'omnimorf-html2pdf-' + Date.now() + '.html');
    fs.writeFileSync(tempHtml, htmlContent, 'utf8');

    try {
        await win.loadFile(tempHtml);
        // Allow content to render (fonts, images)
        await new Promise(resolve => setTimeout(resolve, 800));
        const pdfBuffer = await win.webContents.printToPDF({
            printBackground: true,
            pageSize: 'Letter',
            margins: { marginType: 'default' },
        });
        fs.writeFileSync(outputPath, pdfBuffer);
    } finally {
        win.destroy();
        try { fs.unlinkSync(tempHtml); } catch {}
    }
}

// ── HTML file → PDF ─────────────────────────────────────────
async function htmlFileToPdf(inputPath, outputPath) {
    const html = fs.readFileSync(inputPath, 'utf8');
    await htmlStringToPdf(html, outputPath);
}

// ── Markdown → PDF (marked → HTML → printToPDF) ────────────
async function mdToPdf(inputPath, outputPath) {
    const fullHtml = mdToHtml(inputPath);
    await htmlStringToPdf(fullHtml, outputPath);
}

// ── JSON → CSV ──────────────────────────────────────────────
function jsonToCsv(inputPath) {
    const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const rows = Array.isArray(data) ? data : [data];
    if (rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    const csvLines = [headers.join(',')];
    for (const row of rows) {
        csvLines.push(headers.map(h => {
            const val = (row[h] ?? '').toString();
            return val.includes(',') || val.includes('"') || val.includes('\n')
                ? '"' + val.replace(/"/g, '""') + '"'
                : val;
        }).join(','));
    }
    return csvLines.join('\n');
}

// ── CSV → JSON ──────────────────────────────────────────────
function csvToJson(inputPath) {
    const workbook = XLSX.readFile(inputPath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return JSON.stringify(XLSX.utils.sheet_to_json(sheet), null, 2);
}

// ═══════════════════════════════════════════════════════════════
//  DOCUMENT CONVERT — Master routing function
//  Tries JS fast-path first (instant, no external dependency).
//  Falls back to LibreOffice headless for exotic/legacy formats.
// ═══════════════════════════════════════════════════════════════
async function documentConvert(inputPath, outputPath, targetFormat) {
    const inputExt = path.extname(inputPath).toLowerCase().replace('.', '');
    const target = targetFormat.toLowerCase();

    // ── Same format: just copy ──────────────────────────────
    if (inputExt === target) {
        fs.copyFileSync(inputPath, outputPath);
        return;
    }

    // ── Image files dropped in Document tab → ImageMagick ───
    // Users may drop a PNG/JPG into the Document tab expecting PDF.
    // ImageMagick handles image→PDF (and any image→image) natively.
    const imageExts = ['png','jpg','jpeg','heic','heif','webp','bmp','gif','tiff','tif','svg','avif','ico','psd','tga','pcx','exr','hdr','jxl','jp2','dds','xbm','xpm','pbm','pgm','ppm','icns'];
    if (imageExts.includes(inputExt)) {
        await imageMagickConvert(inputPath, outputPath, 1.0);
        return;
    }

    // ── JS Fast-Path: DOCX → TXT/HTML/PDF/DOCX ─────────────
    if (inputExt === 'docx') {
        if (target === 'txt')  { fs.writeFileSync(outputPath, await docxToText(inputPath), 'utf8'); return; }
        if (target === 'html') { const h = await docxToHtml(inputPath); fs.writeFileSync(outputPath, h, 'utf8'); return; }
        if (target === 'pdf')  { await docxToPdf(inputPath, outputPath); return; }
    }

    // ── JS Fast-Path: Spreadsheets (XLSX/XLS/ODS/CSV/TSV) ──
    const spreadsheetExts = ['xlsx', 'xls', 'ods', 'csv', 'tsv', 'xlsm', 'xlsb'];
    if (spreadsheetExts.includes(inputExt)) {
        if (target === 'csv')  { fs.writeFileSync(outputPath, spreadsheetToCsv(inputPath), 'utf8'); return; }
        if (target === 'json') { fs.writeFileSync(outputPath, spreadsheetToJson(inputPath), 'utf8'); return; }
        if (target === 'html') { fs.writeFileSync(outputPath, spreadsheetToHtml(inputPath), 'utf8'); return; }
        if (target === 'txt')  { fs.writeFileSync(outputPath, spreadsheetToTxt(inputPath), 'utf8'); return; }
        if (target === 'xlsx' && inputExt !== 'xlsx') { csvToXlsx(inputPath, outputPath); return; }
        if (target === 'pdf') {
            const htmlContent = spreadsheetToHtml(inputPath);
            await htmlStringToPdf(htmlContent, outputPath);
            return;
        }
    }

    // ── JS Fast-Path: Markdown ──────────────────────────────
    if (inputExt === 'md' || inputExt === 'markdown') {
        if (target === 'html') { fs.writeFileSync(outputPath, mdToHtml(inputPath), 'utf8'); return; }
        if (target === 'pdf')  { await mdToPdf(inputPath, outputPath); return; }
        if (target === 'txt')  {
            const md = fs.readFileSync(inputPath, 'utf8');
            fs.writeFileSync(outputPath, md.replace(/[#*_~`>\[\]()!|]/g, '').replace(/\n{3,}/g, '\n\n').trim(), 'utf8');
            return;
        }
    }

    // ── JS Fast-Path: HTML ──────────────────────────────────
    if (inputExt === 'html' || inputExt === 'htm' || inputExt === 'xhtml' || inputExt === 'mht' || inputExt === 'mhtml') {
        if (target === 'pdf')  { await htmlFileToPdf(inputPath, outputPath); return; }
        if (target === 'txt')  { fs.writeFileSync(outputPath, htmlToText(inputPath), 'utf8'); return; }
    }

    // ── JS Fast-Path: TXT / LOG / plain text ────────────────
    const plainExts = ['txt', 'log', 'nfo', 'ini', 'cfg', 'conf', 'yaml', 'yml', 'toml', 'xml', 'json', 'rst', 'org', 'tex', 'latex'];
    if (plainExts.includes(inputExt)) {
        const text = fs.readFileSync(inputPath, 'utf8');
        if (target === 'pdf')  { await textToPdf(text, outputPath); return; }
        if (target === 'docx') { await textToDocx(text, outputPath); return; }
        if (target === 'html') {
            const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:monospace;white-space:pre-wrap;margin:1in;font-size:10pt;line-height:1.5;}</style></head><body>${escaped}</body></html>`;
            fs.writeFileSync(outputPath, html, 'utf8');
            return;
        }
        if (target === 'txt' || target === 'log') { fs.copyFileSync(inputPath, outputPath); return; }
        if (target === 'md')   { fs.copyFileSync(inputPath, outputPath); return; }
    }

    // ── JS Fast-Path: JSON ──────────────────────────────────
    if (inputExt === 'json') {
        if (target === 'csv')  { fs.writeFileSync(outputPath, jsonToCsv(inputPath), 'utf8'); return; }
        if (target === 'xlsx') {
            const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
            const rows = Array.isArray(data) ? data : [data];
            const ws = XLSX.utils.json_to_sheet(rows);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
            XLSX.writeFile(wb, outputPath);
            return;
        }
    }

    // ═════════════════════════════════════════════════════════
    //  LIBREOFFICE HEADLESS — handles ALL remaining conversions
    //  200+ formats: DOC, RTF, WPD, WPS, PPT, ODP, ODT, ODS,
    //  EPUB, FB2, DIF, SLK, DBF, Lotus 1-2-3, and dozens more.
    // ═════════════════════════════════════════════════════════
    const soffice = findLibreOffice();
    if (!soffice) {
        throw new Error(
            'LIBREOFFICE_NOT_FOUND: This format requires LibreOffice (free). ' +
            'Install from https://www.libreoffice.org/download/ then restart Omnimorf. ' +
            'Common formats (DOCX, XLSX, CSV, MD, TXT, HTML, JSON) work without it.'
        );
    }

    const outDir = path.dirname(outputPath);
    await libreOfficeConvert(soffice, inputPath, target, outDir);

    // LibreOffice writes output as inputBasename.newExt in outDir — rename to expected path
    const loOutputName = path.basename(inputPath, path.extname(inputPath)) + '.' + target;
    const loOutputPath = path.join(outDir, loOutputName);
    if (loOutputPath !== outputPath && fs.existsSync(loOutputPath)) {
        fs.renameSync(loOutputPath, outputPath);
    }
    if (!fs.existsSync(outputPath)) {
        throw new Error('Conversion produced no output. LibreOffice may not support this format combination.');
    }
}

// ── IPC: Check LibreOffice availability ─────────────────────
ipcMain.handle('omnimorf:check-libreoffice', async () => {
    const found = findLibreOffice();
    return { installed: !!found, path: found || null };
});

// ── IPC: Vault operations ────────────────────────────────────
ipcMain.handle('omnimorf:vault-save', async (event, { name, buffer, hash, passphrase }) => {
    ensureVaultDir();
    const id = crypto.randomUUID();
    const filePath = path.join(VAULT_DIR, id);

    // AES-256 encryption
    const key = crypto.scryptSync(passphrase || 'omnimorf-default', 'omnimorf-salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(Buffer.from(buffer)), cipher.final()]);

    fs.writeFileSync(filePath, encrypted);

    // Update index
    const index = JSON.parse(fs.readFileSync(VAULT_INDEX, 'utf8'));
    index.push({ id, name, size: buffer.byteLength, encryptedSize: encrypted.length, hash, iv: iv.toString('hex'), savedAt: new Date().toISOString() });
    fs.writeFileSync(VAULT_INDEX, JSON.stringify(index, null, 2));

    return { id, encryptedSize: encrypted.length };
});

ipcMain.handle('omnimorf:vault-load', async (event, { id, passphrase }) => {
    const filePath = path.join(VAULT_DIR, id);
    const index = JSON.parse(fs.readFileSync(VAULT_INDEX, 'utf8'));
    const entry = index.find(e => e.id === id);
    if (!entry) throw new Error('Vault entry not found');

    const key = crypto.scryptSync(passphrase || 'omnimorf-default', 'omnimorf-salt', 32);
    const iv = Buffer.from(entry.iv, 'hex');
    const encrypted = fs.readFileSync(filePath);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    return { buffer: decrypted.buffer.slice(decrypted.byteOffset, decrypted.byteOffset + decrypted.byteLength), name: entry.name };
});

ipcMain.handle('omnimorf:vault-list', async () => {
    ensureVaultDir();
    return JSON.parse(fs.readFileSync(VAULT_INDEX, 'utf8'));
});

ipcMain.handle('omnimorf:vault-delete', async (event, { id }) => {
    const filePath = path.join(VAULT_DIR, id);
    try { fs.unlinkSync(filePath); } catch {}

    const index = JSON.parse(fs.readFileSync(VAULT_INDEX, 'utf8'));
    const filtered = index.filter(e => e.id !== id);
    fs.writeFileSync(VAULT_INDEX, JSON.stringify(filtered, null, 2));
    return true;
});

// ── IPC: Shred engine (secure delete) ────────────────────────
ipcMain.handle('omnimorf:shred-file', async (event, { filePath }) => {
    if (!fs.existsSync(filePath)) return false;

    // 3-pass overwrite: zeros, ones, random
    const size = fs.statSync(filePath).size;
    const fd = fs.openSync(filePath, 'w');

    const zeros = Buffer.alloc(Math.min(size, 65536), 0x00);
    const ones = Buffer.alloc(Math.min(size, 65536), 0xFF);

    for (let pass = 0; pass < 3; pass++) {
        let written = 0;
        while (written < size) {
            const chunk = pass === 0 ? zeros : pass === 1 ? ones : crypto.randomBytes(Math.min(65536, size - written));
            fs.writeSync(fd, chunk, 0, Math.min(chunk.length, size - written), written);
            written += chunk.length;
        }
    }

    fs.closeSync(fd);
    fs.unlinkSync(filePath);
    return true;
});

// ── IPC: Hash verification ───────────────────────────────────
ipcMain.handle('omnimorf:hash-file', async (event, { buffer }) => {
    const hash = crypto.createHash('sha256').update(Buffer.from(buffer)).digest('hex');
    return hash;
});

// ── IPC: License — activate (validate + register device) ────
ipcMain.handle('omnimorf:license-activate', async (event, { key }) => {
    if (!key || typeof key !== 'string') {
        return { ok: false, error: 'Missing license key' };
    }
    if (POLAR_ORG_ID === 'REPLACE_WITH_YOUR_POLAR_ORG_UUID') {
        return { ok: false, error: 'License system not configured (missing org ID)' };
    }
    if (POLAR_ACCESS_TOKEN === 'REPLACE_WITH_YOUR_POLAR_ACCESS_TOKEN') {
        return { ok: false, error: 'License system not configured (missing access token)' };
    }

    try {
        // Step 1: validate
        const validateRes = await polarPost('/license-keys/validate', {
            key,
            organization_id: POLAR_ORG_ID
        });

        if (validateRes.status && validateRes.status !== 'granted') {
            return { ok: false, error: `License is ${validateRes.status}` };
        }

        // Step 2: activate this device
        const activateRes = await polarPost('/license-keys/activate', {
            key,
            organization_id: POLAR_ORG_ID,
            label: deviceLabel(),
            meta: {
                platform: process.platform,
                hostname: os.hostname(),
                version: app.getVersion()
            }
        });

        // Log full responses to console (only visible in dev mode / DevTools).
        // This makes debugging future tier-mapping issues trivial.
        console.log('[Omnimorf License] validate response:', JSON.stringify(validateRes, null, 2));
        console.log('[Omnimorf License] activate response:', JSON.stringify(activateRes, null, 2));

        // Determine tier by recursively scanning BOTH responses for any UUID
        // that matches our benefit OR product map. Benefit map is primary
        // (Polar's responses contain benefit_id); product map is a fallback.
        const combinedResponse = { activate: activateRes, validate: validateRes };
        const combinedMap = { ...POLAR_PRODUCT_TIER_MAP, ...POLAR_BENEFIT_TIER_MAP };
        const match = findTierInResponse(combinedResponse, combinedMap);

        if (!match) {
            // CRITICAL: do NOT fall back to a default tier. Failing safe means
            // we never accidentally upgrade a customer to a tier they didn't pay for.
            // Roll back the activation we just made so the slot isn't wasted.
            try {
                await polarPost('/license-keys/deactivate', {
                    key,
                    organization_id: POLAR_ORG_ID,
                    activation_id: activateRes.id
                });
            } catch {}
            console.error('[Omnimorf License] Tier could not be determined. Combined response was:',
                          JSON.stringify(combinedResponse, null, 2));
            return {
                ok: false,
                error: 'License is valid but the product tier could not be identified. ' +
                       'Please contact support@omnimorf.com with your license key.'
            };
        }

        console.log(`[Omnimorf License] Matched tier "${match.tier}" via path "${match.path}" (id=${match.matchedId})`);

        const lk = activateRes.license_key || validateRes;
        const licenseRecord = {
            key,
            tier: match.tier,
            activation_id: activateRes.id,
            license_key_id: lk?.id,
            limit_activations: lk?.limit_activations,
            usage: lk?.usage,
            activated_at: new Date().toISOString(),
            device_label: deviceLabel(),
            machine_fp: machineFingerprint(),
            matched_product_id: match.matchedId,
            matched_path: match.path
        };
        writeLicense(licenseRecord);

        return { ok: true, license: licenseRecord };
    } catch (err) {
        const msg = err.body?.detail || err.body?.error || err.message ||
                    (err.status === 404 ? 'License key not found' :
                     err.status === 403 ? 'Activation limit reached for this license' :
                     'License validation failed');
        return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) };
    }
});

// ── IPC: License — re-validate stored key on launch ─────────
ipcMain.handle('omnimorf:license-check', async () => {
    const stored = readLicense();
    if (!stored) return { ok: false, license: null };

    // Hardware-bind enforcement: a license file copied to another machine
    // (or this machine after a major hardware swap) fails the fingerprint
    // check and is purged. The user must re-activate.
    if (stored.machine_fp && stored.machine_fp !== machineFingerprint()) {
        clearLicense();
        return { ok: false, error: 'License is bound to a different device. Please re-activate.' };
    }

    if (POLAR_ORG_ID === 'REPLACE_WITH_YOUR_POLAR_ORG_UUID') {
        // Offline trust mode — accept stored license
        return { ok: true, license: stored, offline: true };
    }

    try {
        const res = await polarPost('/license-keys/validate', {
            key: stored.key,
            organization_id: POLAR_ORG_ID,
            activation_id: stored.activation_id
        });
        if (res.status && res.status !== 'granted') {
            clearLicense();
            return { ok: false, error: `License revoked: ${res.status}` };
        }
        return { ok: true, license: stored };
    } catch (err) {
        // Network failure — trust stored license (graceful offline)
        if (!err.status || err.status >= 500) {
            return { ok: true, license: stored, offline: true };
        }
        if (err.status === 404 || err.status === 403) {
            clearLicense();
            return { ok: false, error: 'License no longer valid' };
        }
        return { ok: true, license: stored, offline: true };
    }
});

// ── IPC: License — deactivate this device ───────────────────
ipcMain.handle('omnimorf:license-deactivate', async () => {
    const stored = readLicense();
    if (!stored) return { ok: true };

    try {
        await polarPost('/license-keys/deactivate', {
            key: stored.key,
            organization_id: POLAR_ORG_ID,
            activation_id: stored.activation_id
        });
    } catch (err) {
        // Continue even if remote deactivate fails — local clear is mandatory
    }
    clearLicense();
    return { ok: true };
});

// ── IPC: License — get stored license without network ──────
ipcMain.handle('omnimorf:license-get', async () => {
    return readLicense();
});

// ── macOS: handle files opened via file association ──────────
app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (mainWindow) sendFilesToRenderer([filePath]);
    else app.whenReady().then(() => sendFilesToRenderer([filePath]));
});

// ── Build native menu ────────────────────────────────────────
function buildMenu() {
    const isMac = process.platform === 'darwin';

    const template = [
        ...(isMac ? [{
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        }] : []),

        {
            label: 'File',
            submenu: [
                { label: 'Open Files…', accelerator: 'CmdOrCtrl+O', click: () => openFilesDialog() },
                { type: 'separator' },
                {
                    label: 'Activate License…',
                    click: () => mainWindow?.webContents.executeJavaScript('showLicenseModal()')
                },
                { type: 'separator' },
                isMac ? { role: 'close' } : { role: 'quit', label: 'Exit' }
            ]
        },

        {
            label: 'Edit',
            submenu: [
                { role: 'undo' }, { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
            ]
        },

        {
            label: 'View',
            submenu: [
                { role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
                { role: 'zoomOut' },
                { role: 'resetZoom' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
                { type: 'separator' },
                {
                    label: 'Developer Tools',
                    accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
                    click: (_, win) => win?.webContents.toggleDevTools()
                }
            ]
        },

        {
            role: 'help',
            submenu: [
                {
                    label: 'Check for Updates…',
                    click: () => {
                        autoUpdater.checkForUpdates().then(result => {
                            if (!result || !result.updateInfo || result.updateInfo.version === app.getVersion()) {
                                dialog.showMessageBox(mainWindow, {
                                    type: 'info',
                                    title: 'No Updates',
                                    message: 'You are running the latest version.',
                                    detail: `Omnimorf v${app.getVersion()}`,
                                    buttons: ['OK']
                                });
                            }
                        }).catch(() => {
                            dialog.showMessageBox(mainWindow, {
                                type: 'warning',
                                title: 'Update Check Failed',
                                message: 'Could not check for updates.',
                                detail: 'Please check your internet connection and try again.',
                                buttons: ['OK']
                            });
                        });
                    }
                },
                { type: 'separator' },
                {
                    label: 'About Omnimorf',
                    click: () => {
                        dialog.showMessageBox(mainWindow, {
                            type:    'info',
                            title:   'About Omnimorf',
                            message: 'Omnimorf',
                            detail: [
                                `Version ${app.getVersion()}`,
                                '',
                                'Every format. Zero uploads. One price. Forever.',
                                '100% local — your files never leave your device.',
                                '',
                                `Electron: ${process.versions.electron}`,
                                `Node:     ${process.versions.node}`,
                                `Platform: ${process.platform}`
                            ].join('\n'),
                            buttons: ['OK']
                        });
                    }
                }
            ]
        }
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
