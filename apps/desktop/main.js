// Subterra desktop entry point.
//
// Boots the Express API and the Next.js web server as child processes, then
// opens a Chromium window pointing at http://localhost:3000/map. In a
// packaged build these are bundled inside the .exe; in dev mode they are
// started from the repo root.
//
// The app intentionally runs in "demo mode" when no PostgreSQL is reachable
// — every public-data layer (BLM, USGS, state wells, federal lands,
// pipelines, OSM geocoder) still works. Saved AOIs and auth require a DB
// and surface a clear banner when unavailable.

const { app, BrowserWindow, shell, Menu } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const DEV = !app.isPackaged;
const REPO_ROOT = DEV ? path.resolve(__dirname, '..', '..') : process.resourcesPath;
const API_PORT = Number(process.env.API_PORT ?? 4000);
const WEB_PORT = Number(process.env.WEB_PORT ?? 3000);
const WEB_URL = `http://localhost:${WEB_PORT}/map`;

let mainWindow = null;
const children = [];

function spawnSubterraServer(name, command, args, cwd, env = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
  child.stdout.on('data', (b) => process.stdout.write(`[${name}] ${b}`));
  child.stderr.on('data', (b) => process.stderr.write(`[${name}] ${b}`));
  child.on('exit', (code) => console.log(`[${name}] exited with ${code}`));
  children.push(child);
  return child;
}

function startServers() {
  if (DEV) {
    // Dev mode: workspaces already on disk, start tsx + next dev directly.
    spawnSubterraServer('api', 'npx', ['tsx', 'watch', 'src/server.ts'], path.join(REPO_ROOT, 'apps/api'), {
      API_PORT: String(API_PORT),
    });
    spawnSubterraServer('web', 'npx', ['next', 'dev', '-p', String(WEB_PORT)], path.join(REPO_ROOT, 'apps/web'), {
      NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}`,
    });
  } else {
    // Packaged mode: API runs from a precompiled bundle, web runs from the
    // Next.js standalone server. Both ship inside the asar.
    const apiEntry = path.join(REPO_ROOT, 'app', 'apps', 'api', 'dist', 'server.js');
    const webDir = path.join(REPO_ROOT, 'app', 'apps', 'web', '.next', 'standalone');
    spawnSubterraServer('api', process.execPath, [apiEntry], path.dirname(apiEntry), {
      ELECTRON_RUN_AS_NODE: '1',
      API_PORT: String(API_PORT),
    });
    spawnSubterraServer('web', process.execPath, [path.join(webDir, 'server.js')], webDir, {
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(WEB_PORT),
      HOSTNAME: '127.0.0.1',
      NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}`,
    });
  }
}

function waitForUrl(url, timeoutMs = 60_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      http.get(url, (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() - start > timeoutMs) reject(new Error(`Timed out waiting for ${url}`));
          else setTimeout(tryOnce, 500);
        });
    };
    tryOnce();
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#0a0c10',
    title: 'Subterra',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // External links open in the user's default browser, not a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(loadingHtml()));

  try {
    await waitForUrl(WEB_URL);
    await mainWindow.loadURL(WEB_URL);
  } catch (err) {
    await mainWindow.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(errorHtml(err.message)),
    );
  }
}

function loadingHtml() {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Subterra · starting</title>
<style>
  html,body{height:100%;margin:0;background:#0a0c10;color:#e2e8f0;font-family:ui-monospace,Menlo,monospace;}
  .wrap{display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:14px}
  .dot{width:8px;height:8px;border-radius:50%;background:#f59e0b;animation:pulse 1.6s infinite}
  @keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}
  h1{font-size:18px;margin:0;font-weight:500;letter-spacing:-.01em}
  p{color:#64748b;font-size:12px;margin:0}
</style></head>
<body><div class="wrap">
  <div class="dot"></div>
  <h1>Subterra</h1>
  <p>booting API + map server…</p>
</div></body></html>`;
}

function errorHtml(message) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Subterra · failed to start</title>
<style>
  html,body{height:100%;margin:0;background:#0a0c10;color:#e2e8f0;font-family:ui-monospace,Menlo,monospace;}
  .wrap{padding:48px;max-width:640px;margin:0 auto}
  h1{color:#ef4444;font-size:18px}
  pre{background:#161a22;border:1px solid #1e2430;padding:12px;border-radius:6px;color:#94a3b8;font-size:12px;white-space:pre-wrap;word-break:break-word}
</style></head>
<body><div class="wrap">
  <h1>Subterra failed to start</h1>
  <p>The bundled API or web server didn't come up in time.</p>
  <pre>${message.replace(/[<>&]/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</pre>
  <p>Check the developer console (Ctrl+Shift+I) for child-process logs.</p>
</div></body></html>`;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  startServers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const c of children) {
    try { c.kill(); } catch { /* ignore */ }
  }
  if (process.platform !== 'darwin') app.quit();
});
