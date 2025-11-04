import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PERFORMANCE_SETTINGS_FILE = 'performance-settings.json';
const defaultPerformanceSettings = {
  disableHardwareAcceleration: false,
  backgroundThrottling: true
};

function resolveSettingsPath() {
  try {
    const userDataDir = app.getPath('userData');
    return path.join(userDataDir, PERFORMANCE_SETTINGS_FILE);
  } catch (err) {
    console.warn('Failed to resolve performance settings path, using cwd fallback', err);
    return path.join(process.cwd(), PERFORMANCE_SETTINGS_FILE);
  }
}

function loadPerformanceSettings() {
  const settingsPath = resolveSettingsPath();
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...defaultPerformanceSettings, ...parsed };
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn('Failed to load performance settings, falling back to defaults', err);
    }
    return { ...defaultPerformanceSettings };
  }
}

function persistPerformanceSettings(settings) {
  const settingsPath = resolveSettingsPath();
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  } catch (err) {
    if (err && err.code !== 'EEXIST') {
      console.warn('Failed to ensure settings directory exists', err);
    }
  }
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist performance settings', err);
  }
}

const performanceSettings = loadPerformanceSettings();

if (performanceSettings.disableHardwareAcceleration) {
  app.disableHardwareAcceleration();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const windows = new Set();

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: performanceSettings.backgroundThrottling !== false,
      preload: path.join(__dirname, 'electron-preload.js')
    },
    title: 'Arc'
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  if (performanceSettings.backgroundThrottling === false) {
    try {
      mainWindow.webContents.setBackgroundThrottling(false);
    } catch (err) {
      console.warn('Failed to disable background throttling for window', err);
    }
  }

  windows.add(mainWindow);
  mainWindow.on('closed', () => {
    windows.delete(mainWindow);
  });
}

function broadcastPerformanceSettings(settings) {
  windows.forEach(win => {
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send('performance:settings-updated', settings);
    } catch (err) {
      console.warn('Failed to broadcast performance settings', err);
    }
  });
}

ipcMain.handle('performance:get-settings', () => ({ ...performanceSettings }));

ipcMain.handle('performance:update-settings', (event, requestedSettings = {}) => {
  if (!requestedSettings || typeof requestedSettings !== 'object') {
    return {
      settings: { ...performanceSettings },
      requiresRestart: false
    };
  }

  let requiresRestart = false;
  const nextSettings = { ...performanceSettings };

  if (Object.prototype.hasOwnProperty.call(requestedSettings, 'disableHardwareAcceleration')) {
    const disable = Boolean(requestedSettings.disableHardwareAcceleration);
    if (disable !== performanceSettings.disableHardwareAcceleration) {
      nextSettings.disableHardwareAcceleration = disable;
      requiresRestart = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(requestedSettings, 'backgroundThrottling')) {
    const shouldThrottle = Boolean(requestedSettings.backgroundThrottling);
    nextSettings.backgroundThrottling = shouldThrottle;
    windows.forEach(win => {
      if (!win || win.isDestroyed()) return;
      try {
        win.webContents.setBackgroundThrottling(shouldThrottle);
      } catch (err) {
        console.warn('Failed to update background throttling for window', err);
      }
    });
  }

  Object.assign(performanceSettings, nextSettings);
  persistPerformanceSettings(performanceSettings);
  broadcastPerformanceSettings(performanceSettings);

  return {
    settings: { ...performanceSettings },
    requiresRestart
  };
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
