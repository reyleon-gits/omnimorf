// ═══════════════════════════════════════════════════════════════
//  Omnimorf — Electron Preload (contextBridge)
//  Exposes IPC channels for conversion, vault, shred, and hash
// ═══════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

    // ── File Open ────────────────────────────────────────────
    onOpenFiles: (callback) => {
        ipcRenderer.on('omnimorf:open-files', (_, files) => callback(files));
    },
    requestOpenFiles: () => {
        ipcRenderer.send('omnimorf:request-open');
    },
    removeOpenFilesListener: () => {
        ipcRenderer.removeAllListeners('omnimorf:open-files');
    },

    // ── Native Conversion (FFmpeg / ImageMagick) ─────────────
    convertFile: (opts) => ipcRenderer.invoke('omnimorf:convert-file', opts),
    saveConverted: (opts) => ipcRenderer.invoke('omnimorf:save-converted', opts),
    readConverted: (opts) => ipcRenderer.invoke('omnimorf:read-converted', opts),

    // ── Vault (AES-256 encrypted, gzip-compressed, content-dedup storage) ──
    vaultSave:   (opts) => ipcRenderer.invoke('omnimorf:vault-save', opts),
    vaultLoad:   (opts) => ipcRenderer.invoke('omnimorf:vault-load', opts),
    vaultList:   ()     => ipcRenderer.invoke('omnimorf:vault-list'),
    vaultDelete: (opts) => ipcRenderer.invoke('omnimorf:vault-delete', opts),

    // ── Vault Location (custom dir on all tiers; LAN/UNC gated to Team+) ──
    vaultGetLocation:   ()      => ipcRenderer.invoke('omnimorf:vault-get-location'),
    vaultPickLocation:  ()      => ipcRenderer.invoke('omnimorf:vault-pick-location'),
    vaultSetLocation:   (opts)  => ipcRenderer.invoke('omnimorf:vault-set-location', opts),
    vaultResetLocation: ()      => ipcRenderer.invoke('omnimorf:vault-reset-location'),
    vaultStats:         ()      => ipcRenderer.invoke('omnimorf:vault-stats'),
    vaultUpdateEntry:   (opts)  => ipcRenderer.invoke('omnimorf:vault-update-entry', opts),

    // ── Shred Engine (secure 3-pass delete) ──────────────────
    shredFile:   (opts) => ipcRenderer.invoke('omnimorf:shred-file', opts),

    // ── Hash Verification ────────────────────────────────────
    hashFile:    (opts) => ipcRenderer.invoke('omnimorf:hash-file', opts),

    // ── Document Engine (LibreOffice status) ───────────────────
    checkLibreOffice: () => ipcRenderer.invoke('omnimorf:check-libreoffice'),

    // ── License Key (Polar.sh) ───────────────────────────────
    licenseActivate:   (opts) => ipcRenderer.invoke('omnimorf:license-activate', opts),
    licenseCheck:      ()     => ipcRenderer.invoke('omnimorf:license-check'),
    licenseDeactivate: ()     => ipcRenderer.invoke('omnimorf:license-deactivate'),
    licenseGet:        ()     => ipcRenderer.invoke('omnimorf:license-get'),

});
