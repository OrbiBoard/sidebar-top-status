const { ipcRenderer } = require('electron');

// State
let widgets = [];
let availableComponents = [];
let isEditMode = false;

// DOM Elements
const statusBar = document.getElementById('status-bar-container');
const widgetsArea = document.getElementById('widgets-area');
const editOverlay = document.getElementById('edit-overlay');
const componentList = document.getElementById('component-list');
const closeEditBtn = document.getElementById('close-edit-btn');

// Initialization
async function init() {
    // 1. Load Components from System
    try {
        const res = await ipcRenderer.invoke('sidebar-status:get-components');
        if (Array.isArray(res)) {
            // Filter components suitable for status bar? 
            // For now, allow all, but maybe user should be careful.
            // Ideally we'd filter by a tag like "status-bar-widget" but generic is fine.
            availableComponents = res;
        } else if (res && res.components) {
            availableComponents = res.components;
        }
    } catch (e) {
        console.error('Error loading components:', e);
    }

    // 2. Load Saved Config
    try {
        const config = await ipcRenderer.invoke('sidebar-status:load-config');
        if (config && config.widgets) {
            widgets = config.widgets;
        }
    } catch (e) {
        console.error('Error loading config:', e);
    }

    // 3. Render Initial State
    renderWidgets();
    renderComponentPanel();

    // 4. Setup Event Listeners
    setupEventListeners();
}

function setupEventListeners() {
    // Toggle Mode
    ipcRenderer.on('toggle-edit-mode', () => toggleEditMode());
    
    // Close Button
    closeEditBtn.onclick = (e) => {
        e.stopPropagation();
        toggleEditMode(false);
    };

    // Overlay Click Handling
    editOverlay.addEventListener('click', (e) => {
        // Prevent default browser behavior if needed
        // e.preventDefault();
        
        // Debug target
        console.log('Overlay click target:', e.target);

        // CASE 1: Clicked on the backdrop (the semi-transparent part)
        if (e.target.classList.contains('edit-backdrop')) {
            toggleEditMode(false);
            return;
        }

        // CASE 2: Clicked on the overlay container itself (empty space not covered by panel)
        if (e.target === editOverlay) {
            toggleEditMode(false);
            return;
        }
    });

    // Prevent any click inside the panel from reaching the overlay
    const panel = document.getElementById('component-panel');
    if (panel) {
        panel.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

    // Prevent any click inside the status bar from reaching the overlay (important in Edit Mode)
    statusBar.addEventListener('click', (e) => {
        if (isEditMode) {
            e.stopPropagation();
        }
    });

    // Drag & Drop
    setupDragAndDrop();
}

function setupDragAndDrop() {
    // Helper to ensure we allow dropping on the widgets area too
    const handleDragOver = (e) => {
        if (!isEditMode) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        statusBar.style.borderColor = '#007bff';
        statusBar.style.background = 'rgba(50, 50, 50, 0.95)';
    };
    
    // Bind to both container and inner area to ensure no gaps
    statusBar.addEventListener('dragover', handleDragOver);
    widgetsArea.addEventListener('dragover', handleDragOver);

    const handleDragLeave = (e) => {
        if (!isEditMode) return;
        // Only reset if we are leaving the main container
        if (e.target === statusBar || e.target === widgetsArea) {
             // Maybe debounce or check relatedTarget? 
             // Simplification: just reset style, if re-enter it will set again
             statusBar.style.borderColor = 'rgba(255, 255, 255, 0.3)';
             statusBar.style.background = 'rgba(40, 40, 40, 0.95)';
        }
    };

    statusBar.addEventListener('dragleave', handleDragLeave);

    const handleDrop = (e) => {
        if (!isEditMode) return;
        e.preventDefault();
        e.stopPropagation(); // Stop bubbling
        
        statusBar.style.borderColor = 'rgba(255, 255, 255, 0.3)';
        
        const componentId = e.dataTransfer.getData('text/plain');
        if (componentId) {
            addWidget(componentId);
        }
    };

    statusBar.addEventListener('drop', handleDrop);
    widgetsArea.addEventListener('drop', handleDrop);
}

function toggleEditMode(forceState) {
    if (typeof forceState !== 'undefined') {
        isEditMode = forceState;
    } else {
        isEditMode = !isEditMode;
    }
    
    // Notify Main Process
    ipcRenderer.send('sidebar-status:set-mode', isEditMode ? 'edit' : 'view');

    if (isEditMode) {
        editOverlay.style.display = 'block'; // Or flex, controlled by CSS? 
        // In CSS we handle display logic usually, but here simple toggle
        document.body.classList.add('edit-mode');
        renderComponentPanel(); // Refresh list
    } else {
        editOverlay.style.display = 'none';
        document.body.classList.remove('edit-mode');
    }
    
    renderWidgets(); // Re-render to show/hide remove buttons
}

function renderComponentPanel() {
    componentList.innerHTML = '';
    
    if (availableComponents.length === 0) {
        componentList.innerHTML = '<div style="color:#888; text-align:center; grid-column: 1/-1;">暂无可用组件<br>No components found</div>';
        return;
    }

    availableComponents.forEach(comp => {
        const item = document.createElement('div');
        item.className = 'comp-lib-item';
        item.draggable = true;
        
        // Icon handling
        let iconHtml = '<i class="ri-puzzle-line comp-lib-item-icon"></i>';
        if (comp.icon) {
             if (comp.icon.startsWith('http') || comp.icon.startsWith('data:')) {
                 iconHtml = `<img src="${comp.icon}" style="width:24px;height:24px;margin-bottom:8px;">`;
             } else {
                 iconHtml = `<i class="${comp.icon} comp-lib-item-icon"></i>`;
             }
        }

        item.innerHTML = `
            ${iconHtml}
            <span class="comp-lib-item-name">${comp.name}</span>
        `;
        
        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', comp.id);
        });

        // Click to add
        item.addEventListener('click', (e) => {
            e.stopPropagation(); // FIX: Prevent bubbling to backdrop or other closers
            addWidget(comp.id);
        });
        
        componentList.appendChild(item);
    });
}

function getComponentById(id) {
    return availableComponents.find(c => c.id === id);
}

function addWidget(componentId) {
    const comp = getComponentById(componentId);
    if (!comp) {
        console.warn('Component not found:', componentId);
        return;
    }

    const widget = {
        id: `${componentId}-${Date.now()}`,
        componentId: componentId,
        config: {}
    };
    
    // Load defaults
    if (comp.configSchema) {
        Object.keys(comp.configSchema).forEach(key => {
            if (comp.configSchema[key].default !== undefined) {
                widget.config[key] = comp.configSchema[key].default;
            }
        });
    }

    widgets.push(widget);
    saveConfig();
    renderWidgets();
}

function removeWidget(id) {
    widgets = widgets.filter(w => w.id !== id);
    saveConfig();
    renderWidgets();
}

function saveConfig() {
    ipcRenderer.invoke('sidebar-status:save-config', { widgets });
    
    // Update bar width
    setTimeout(() => {
        const width = widgetsArea.scrollWidth + 40;
        ipcRenderer.send('sidebar-status:update-bounds', { width: Math.max(200, width) });
    }, 100);
}

function renderWidgets() {
    widgetsArea.innerHTML = '';
    
    // Clear old listeners
    const containerEl = document.getElementById('status-bar-container');
    // We can't easily clear specific listeners but we can ensure we only bind once or manage state.
    // For now, let's rely on event bubbling.

    widgets.forEach(widget => {
        const comp = getComponentById(widget.componentId);
        
        const container = document.createElement('div');
        container.className = 'widget-item';
        // Add event listeners for mouse interaction (click-through management)
        container.addEventListener('mouseenter', () => {
            if (!isEditMode) {
                // Standalone mode: we can control ignoreMouseEvents.
                // If we want to interact with widgets (e.g. click), we must set ignore to false.
                // But the requirement is "Need pass-through... on hover make semi-transparent".
                // If we set ignore=false, we block clicks to background.
                // If the user wants to click the widget, we need ignore=false.
                // If the user wants to click THROUGH the widget, we keep ignore=true.
                
                // Assuming "pass-through" means click-through.
                // But usually widgets like clocks might have settings on click?
                // The previous behavior (before service-toplayer attempt) was: 
                // mouseenter -> ignore=false (capture)
                // mouseleave -> ignore=true (pass-through)
                
                // User said: "不需要选择" (no selection needed) "仅需要穿透时接受一个信号将组件半透明即可".
                // This strongly implies: NO CLICK INTERACTION in view mode. Just visual feedback.
                // So we do NOT send 'set-ignore-mouse' false.
                // We just let the CSS hover effect handle the visual part.
                
                // However, if we want to drag/move widgets, we need Edit Mode.
                // So in View Mode, it is purely a display layer.
                // Therefore, we do NOTHING here regarding IPC.
                
                container.style.opacity = '0.5';
            }
        });
        container.addEventListener('mouseleave', () => {
            if (!isEditMode) {
                container.style.opacity = '1';
            }
        });

        // Set dynamic width
        let width = 120;
        if (comp && comp.recommendedSize && comp.recommendedSize.width) {
            width = comp.recommendedSize.width; 
        }
        container.style.width = `${width}px`; // Apply width

        
        if (comp) {
             const webview = document.createElement('webview');
             
             // Ensure URL is absolute if provided by plugin system, OR resolve relative if local
             // Actually pluginApi.components.list() should return absolute paths if handled by main process correctly.
             // But if not, we rely on the fact that if it's our own component, we know where it is.
             // If comp.url is missing, it might be a problem if path is relative.
             // However, for this plugin's OWN components defined in plugin.json, the system might not have fully resolved them yet 
             // if we are just running this code. 
             // But let's assume `res` from `sidebar-status:get-components` returns what the PluginManager provides.
             // If it's `entry: "components/clock.html"`, we might need to prepend plugin path.
             // BUT, we don't know our own plugin path easily here unless passed.
             // Wait, `comp.url` should be the `file://` url.
             
             let src = comp.url || comp.entry;
             // Fix for local components if URL is missing (fallback)
             if (!src.startsWith('http') && !src.startsWith('file:') && !src.startsWith('data:')) {
                 // It's a relative path? Or just a filename?
                 // If it is OUR component 'sidebar-clock', we know it is in components/clock.html relative to THIS file's directory (parent of).
                 // Actually renderer.js is in root of plugin. components/ is subdir.
                 // So `components/clock.html` is correct relative path.
                 // Webview src relative path is relative to the page loading it (index.html).
                 // index.html is in root. So `components/clock.html` works!
             }

             // Debug log (can be seen in DevTools if opened)
             console.log('Loading widget:', comp.id, src);

             webview.src = src;
             webview.setAttribute('nodeintegration', 'true');
             webview.setAttribute('webpreferences', 'contextIsolation=no, nodeIntegration=true');
             webview.style.width = '100%';
             webview.style.height = '100%';
             webview.style.background = 'transparent';
             
             // Inject styles to make body transparent and fit
             webview.addEventListener('dom-ready', () => {
                 // Send config
                 webview.send('config-updated', widget.config || {});
                 
                 // Inject CSS for transparent background
                 webview.insertCSS(`
                     body { background: transparent !important; overflow: hidden !important; }
                     #app, .container { display: flex; align-items: center; justify-content: center; height: 100%; }
                 `);
             });
             
             container.appendChild(webview);
        } else {
            container.innerHTML = '<span style="font-size:10px;color:red;">Missing</span>';
            container.style.width = '50px';
        }

        // Edit Controls
        if (isEditMode) {
            const removeBtn = document.createElement('div');
            removeBtn.className = 'widget-controls';
            removeBtn.innerHTML = '<i class="ri-close-line"></i>';
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                removeWidget(widget.id);
            };
            container.appendChild(removeBtn);
        }

        widgetsArea.appendChild(container);
    });
    
    // In View mode, we want to be pass-through.
    // However, since we are now hosted in service-toplayer, we can't easily control the window's ignoreMouse.
    // We rely on service-toplayer's shape calculation.
    // service-toplayer uses widget bounds. We are full width.
    // So we block mouse everywhere.
    // Unless we update our widget bounds to 0x0 or off-screen? No.
    
    // We need a way to tell service-toplayer to ignore our shape contribution.
    // Currently not supported.
    
    // For now, removing the IPC call that was failing or useless.
    if (!isEditMode && widgets.length === 0) {
        // ipcRenderer.send('sidebar-status:set-ignore-mouse', true);
    }
}

// Start
init();
