const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

let statusWindow = null;
let pluginApi = null;
let isEditMode = false;

// Default Bar Configuration
const BAR_HEIGHT = 60;
const BAR_MARGIN_TOP = 0;
const BAR_MARGIN_LEFT = 100;
const BAR_WIDTH = 500; // Initial width, can be auto-expanded based on content

function createStatusWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) return;

  const primaryDisplay = screen.getPrimaryDisplay();
  const { x, y, width, height } = primaryDisplay.bounds;

  // Initial State: View Mode (Top Bar)
  const initialBounds = {
      x: x + BAR_MARGIN_LEFT,
      y: y + BAR_MARGIN_TOP,
      width: BAR_WIDTH,
      height: BAR_HEIGHT
  };

  statusWindow = new BrowserWindow({
    ...initialBounds,
    type: 'toolbar', 
    frame: false,
    transparent: true,
    resizable: false, // We handle resizing manually via setBounds
    movable: true,    // Allow moving in view mode? Maybe restrict.
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  statusWindow.loadFile(path.join(__dirname, 'index.html'));
  
  statusWindow.on('closed', () => {
    statusWindow = null;
  });

  // IPC Handlers
  ipcMain.on('sidebar-status:set-mode', (event, mode) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win !== statusWindow) return;

      isEditMode = (mode === 'edit');
      
      if (isEditMode) {
          // Fullscreen for editing
          const display = screen.getDisplayMatching(win.getBounds());
          win.setBounds(display.bounds);
          win.setIgnoreMouseEvents(false);
          // Bring to front mainly for the overlay
          win.setAlwaysOnTop(true, 'screen-saver'); // Force highest level
          win.moveTop();
      } else {
          // Revert to Bar Mode
          const display = screen.getDisplayMatching(win.getBounds());
          win.setBounds({
              x: display.bounds.x + BAR_MARGIN_LEFT,
              y: display.bounds.y + BAR_MARGIN_TOP,
              width: BAR_WIDTH, // This should ideally be dynamic
              height: BAR_HEIGHT
          });
          // In view mode, we interact with widgets, so don't ignore mouse
          win.setIgnoreMouseEvents(false);
          win.setAlwaysOnTop(true, 'floating'); // Force top level
          win.moveTop();
      }
  });

  ipcMain.on('sidebar-status:update-bounds', (event, bounds) => {
      if (!isEditMode && statusWindow) {
          const current = statusWindow.getBounds();
          statusWindow.setBounds({
              ...current,
              width: bounds.width || current.width,
              height: bounds.height || current.height
          });
      }
  });

  ipcMain.handle('sidebar-status:get-components', async () => {
      if (pluginApi && pluginApi.components && pluginApi.components.list) {
          try {
              const res = await pluginApi.components.list();
              let allComponents = [];
              if (Array.isArray(res)) {
                  allComponents = res;
              } else if (res && res.components && Array.isArray(res.components)) {
                  allComponents = res.components;
              }

              // Filter for sidebar widgets
              const filtered = allComponents.filter(c => c.group === 'sidebar_widget');

              // Ensure URL is present (especially for local components)
              filtered.forEach(c => {
                  if (!c.url && c.entry) {
                      // If entry is relative and it's our component (or we assume it is relative to plugin dir)
                      // Ideally we should match plugin ID, but c.pluginId might be available
                      // Fallback: Resolve relative to THIS plugin's dir if it looks like ours
                      if (!path.isAbsolute(c.entry)) {
                           c.url = 'file:///' + path.join(__dirname, c.entry).replace(/\\/g, '/');
                      }
                  }
              });

              return filtered;
          } catch (e) {
              console.error('Failed to fetch components:', e);
              return [];
          }
      }
      return [];
  });

  ipcMain.handle('sidebar-status:load-config', () => {
      if (pluginApi && pluginApi.store) {
          return pluginApi.store.getAll() || {};
      }
      return {};
  });

  ipcMain.handle('sidebar-status:save-config', (event, config) => {
      if (pluginApi && pluginApi.store) {
          pluginApi.store.setAll(config);
      }
  });
}

module.exports = {
  name: '边栏.顶部状态',
  init: (api) => {
    pluginApi = api;
    createStatusWindow();
  },
  functions: {
    toggleEditMode: () => {
      if (statusWindow && !statusWindow.isDestroyed()) {
        statusWindow.webContents.send('toggle-edit-mode');
      }
    }
  }
};
