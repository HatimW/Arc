import { contextBridge, ipcRenderer } from 'electron';

const performanceListeners = new Set();

ipcRenderer.on('performance:settings-updated', (_event, settings) => {
  performanceListeners.forEach(listener => {
    try {
      listener(settings);
    } catch (err) {
      console.error('Performance listener callback failed', err);
    }
  });
});

const performanceBridge = {
  async getSettings() {
    try {
      return await ipcRenderer.invoke('performance:get-settings');
    } catch (err) {
      console.error('Failed to fetch performance settings', err);
      return null;
    }
  },
  async updateSettings(settings) {
    try {
      return await ipcRenderer.invoke('performance:update-settings', settings);
    } catch (err) {
      console.error('Failed to update performance settings', err);
      throw err;
    }
  },
  onSettingsChanged(listener) {
    if (typeof listener !== 'function') return () => {};
    performanceListeners.add(listener);
    return () => {
      performanceListeners.delete(listener);
    };
  }
};

contextBridge.exposeInMainWorld('arc', {
  performance: performanceBridge
});
