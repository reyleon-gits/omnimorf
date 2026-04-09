// ═══════════════════════════════════════════════════════════════
//  Omnimorf — Electron Main Process
//  Universal file converter with native binary integration
//
//  Copyright (c) 2026 Green Ave Consulting LLC
//  DBA: Crownarchy Omnithrone — Creator: Blanton Banks II
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
const { execFile } = require('child_process');

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
        const mediaFiles = argv.filter(a => /\.(heic|heif|jpg|jpeg|png|webp|mp4|mov|avi|mkv|mp3|wav|flac|pdf|docx)$/i.test(a));
        if (mediaFiles.length) sendFilesToRenderer(mediaFiles);
    }
});

// ── App ready ────────────────────────────────────────────────
app.whenReady().then(() => {
    ensureVaultDir();
    createWindow();
    buildMenu();
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
            { name: 'Documents', extensions: ['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'html', 'rtf', 'csv'] },
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
ipcMain.handle('omnimorf:convert-file', async (event, { buffer, name, targetFormat, quality, category }) => {
    const tempDir = path.join(app.getPath('temp'), 'omnimorf-convert');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const inputPath = path.join(tempDir, 'input-' + Date.now() + '-' + name);
    const outputPath = path.join(tempDir, 'output-' + Date.now() + '.' + targetFormat);

    fs.writeFileSync(inputPath, Buffer.from(buffer));

    try {
        if (category === 'video' || category === 'audio') {
            await ffmpegConvert(inputPath, outputPath, category, quality);
        } else if (category === 'image') {
            await imageMagickConvert(inputPath, outputPath, quality);
        } else {
            throw new Error('Document conversion requires LibreOffice — coming in next update');
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
                    label: 'About Omnimorf',
                    click: () => {
                        dialog.showMessageBox(mainWindow, {
                            type:    'info',
                            title:   'About Omnimorf',
                            message: 'Omnimorf',
                            detail: [
                                'Version 1.0.0',
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
