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
  const { x, y, width: screenWidth, height: screenHeight } = primaryDisplay.bounds;

  // Initial State: View Mode (Top Bar)
  const initialBounds = {
      x: x,
      y: y + BAR_MARGIN_TOP,
      width: screenWidth, // Full width
      height: BAR_HEIGHT
  };

  statusWindow = new BrowserWindow({
    ...initialBounds,
    type: 'toolbar', 
    frame: false,
    transparent: true,
    resizable: false, // We handle resizing manually via setBounds
    movable: false,    // Fixed position
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false, // Don't steal focus in view mode
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true // Enable webview for widgets
    }
  });

  // Ensure it stays on top
  statusWindow.setAlwaysOnTop(true, 'screen-saver');

  // Initial state: ignore mouse events (allow click-through)
  // forward: true is crucial to allow mouse events to pass to apps behind
  // while still allowing Chromium to receive mousemove/mouseenter (if supported by OS)
  // On Windows, this works perfectly for "click-through but interactive on hover" visual effects.
  statusWindow.setIgnoreMouseEvents(true, { forward: true });

  statusWindow.loadFile(path.join(__dirname, 'index.html'));
  
  statusWindow.on('closed', () => {
    statusWindow = null;
  });

  // IPC Handlers
  
  // Settings Action
  ipcMain.on('sidebar-status:open-settings', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) win.webContents.send('open-settings');
  });

  ipcMain.on('sidebar-status:set-ignore-mouse', (event, ignore) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win !== statusWindow) return;
      
      if (ignore) {
          win.setIgnoreMouseEvents(true, { forward: true });
      } else {
          // When not ignoring, we capture clicks.
          // Used for Edit Mode.
          win.setIgnoreMouseEvents(false);
      }
  });

  ipcMain.on('sidebar-status:set-mode', (event, mode) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win !== statusWindow) return;

      isEditMode = (mode === 'edit');
      
      const display = screen.getDisplayMatching(win.getBounds());
      
      if (isEditMode) {
          // Fullscreen for editing
          win.setBounds(display.bounds);
          // In Edit Mode, we need to capture clicks
          win.setIgnoreMouseEvents(false);
          win.setFocusable(true); 
          win.setAlwaysOnTop(true, 'screen-saver'); 
          win.moveTop();
          win.focus();
      } else {
          // Revert to Bar Mode
          win.setBounds({
              x: display.bounds.x,
              y: display.bounds.y + BAR_MARGIN_TOP,
              width: display.bounds.width, 
              height: BAR_HEIGHT
          });
          // In View Mode, we ignore mouse clicks (pass-through)
          // But allow forwarding so we can maybe detect hover? 
          // Actually, if we want PURE pass-through where clicks go behind, 
          // we use forward: true.
          win.setIgnoreMouseEvents(true, { forward: true });
          win.setFocusable(false);
          win.setAlwaysOnTop(true, 'screen-saver');
          win.moveTop();
      }
  });

  ipcMain.on('sidebar-status:update-bounds', (event, bounds) => {
      // In standalone mode, we handle bounds updates if necessary
      // But we generally stick to full width now.
  });

  // ... (rest of IPC handlers for config) ...

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

              // Filter for sidebar widgets and the new clock group
              const filtered = allComponents.filter(c => c.group === 'sidebar_widget' || c.group === 'sidebar_clock');

              // Resolve URLs for all components
              filtered.forEach(c => {
                  if (!c.url) {
                      // Try to get absolute URL via API
                      if (pluginApi && pluginApi.components && pluginApi.components.entryUrl) {
                          const url = pluginApi.components.entryUrl(c.id);
                          if (url && typeof url === 'string') {
                              c.url = url;
                          }
                      }
                      
                      // Fallback for local components if API didn't resolve (e.g. not in manifest correctly)
                      if (!c.url && c.entry && !path.isAbsolute(c.entry)) {
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

// Helper to find our widget's webContents to send messages
function getWidgetWebContents() {
    const all = require('electron').webContents.getAllWebContents();
    // Look for our URL (normalized)
    const targetUrl = require('url').pathToFileURL(path.join(__dirname, 'index.html')).href;
    // Note: webview URL might have encoded characters or query params?
    // Usually exact match works for file://
    return all.find(wc => wc.getURL().startsWith(targetUrl));
}

module.exports = {
  name: '边栏.顶部状态',
  init: (api) => {
    pluginApi = api;
    createStatusWindow();
    
    // Register as notification provider
    setTimeout(() => {
        if (pluginApi && typeof pluginApi.call === 'function') {
            // We need to pass a callback function that will be executed by notify-plugin.
            // But pluginApi.call serializes arguments? No, usually in-process or via remote object.
            // In OrbiBoard, pluginApi.call usually goes via PluginManager.
            // If plugins are in same process (Main), functions can be passed if not over IPC.
            // If notify-plugin is in same process, we can pass function directly.
            
            // However, the `handler` argument in `registerProvider` is expected to be a function.
            // Let's assume direct function passing works between plugins in Main process.
            
            try {
                // If notify-plugin exposes `registerProvider` as a function in `functions` export:
                const notifyPlugin = require('../notify-plugin/index.js'); // Direct require if possible? No, paths might vary.
                // Better use api.call if supported.
                
                // Wait, api.call(target, fnName, ...args).
                // If args contain function, it might be lost if over IPC.
                // But here all plugins run in Main process context usually.
                // So function reference should work.
                
                pluginApi.call('notify-plugin', 'registerProvider', 
                    'sidebar-top-status', 
                    '顶部边栏', 
                    (payload) => {
                        const wc = getWidgetWebContents();
                        if (wc && !wc.isDestroyed()) {
                            wc.send('show-notification', payload);
                        }
                    }
                ).then(() => console.log('Registered sidebar-top-status as notification provider'))
                 .catch(e => {
                     // If call fails (e.g. notify-plugin not ready or function passing not supported),
                     // we might need another way. But let's try this first.
                     console.error('Failed to register provider:', e);
                 });
            } catch (err) {
                console.error('Error in sidebar-top-status provider registration:', err);
            }
        }
    }, 2000);
  },
  functions: {
    toggleEditMode: () => {
      const wc = getWidgetWebContents();
      if (wc && !wc.isDestroyed()) {
        wc.send('toggle-edit-mode');
      }
    },
    openSettings: () => {
      const wc = getWidgetWebContents();
      if (wc && !wc.isDestroyed()) {
        wc.send('open-settings');
      }
    }
  }
};
