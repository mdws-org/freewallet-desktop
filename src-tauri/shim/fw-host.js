/*
 * FreeWallet host adapter: the NW.js API surface the web app uses, provided on
 * top of Tauri v2. Injected by the shell into the main frame before any page
 * script, so index.html, html/ and js/ stay as upstream ships them.
 *
 *   NW.js                         here
 *   require('nw.gui')             returns this adapter (also window.nw)
 *   require('crypto-js')          window.CryptoJS (Node resolved it from node_modules)
 *   nw.Shell.openExternal(url)    opener plugin, http(s) only
 *   nw.Clipboard.get().set(t)     clipboard-manager plugin writeText
 *   nw.Menu / nw.MenuItem         native context menu (core menu API); items
 *                                 labelled Copy/Cut/Paste become the native edit
 *                                 actions, since WebKit refuses execCommand('paste')
 *   nw.App.manifest.version       app version from the shell
 *   nw.App.argv / on('open')      empty / never fires (URL schemes are not
 *                                 registered by this shell yet)
 *   nw.Window.get().showDevTools  no-op (devtools exist in debug builds only)
 *
 * It also exposes window.fwHost.files, which BackupFileIO (wallet-backup-ui.js)
 * uses in place of NW.js's <input nwsaveas> and Node's fs: a native save or
 * open dialog (dialog plugin), then a read or write of the one path the user
 * picked (fs plugin, whose scope holds only dialog-picked paths).
 *
 * The browserify bundles (bitcore-lib, bitcore-message) replace the global
 * require when they load, but fall back to the require that existed before them
 * for names they do not bundle, so 'nw.gui' and 'crypto-js' still land here.
 */
(function () {
  'use strict';
  if (window.top !== window) return;

  var boot = window.__FW_HOST_BOOT__ || {};

  function tauri() {
    if (!window.__TAURI__) throw new Error('Tauri API not available');
    return window.__TAURI__;
  }

  function report(what) {
    return function (err) { console.error('[fw-host] ' + what + ':', err); };
  }

  var EXTERNAL_RE = /^(https?:\/\/|mailto:)/i;

  function openExternal(url) {
    url = String(url);
    if (!EXTERNAL_RE.test(url)) {
      console.warn('[fw-host] not opening non-http(s) url:', url);
      return;
    }
    tauri().opener.openUrl(url).catch(report('openExternal'));
  }

  var clipboard = {
    set: function (data, type) {
      if (type && type !== 'text') return;
      tauri().clipboardManager.writeText(String(data)).catch(report('clipboard'));
    },
    get: function () {
      // NW.js returns synchronously; nothing in the app reads the clipboard.
      return '';
    },
    clear: function () {
      tauri().clipboardManager.clear().catch(report('clipboard'));
    }
  };

  var NATIVE_EDIT = { Copy: 'Copy', Cut: 'Cut', Paste: 'Paste', 'Select All': 'SelectAll' };

  function MenuItem(opts) {
    opts = opts || {};
    this.type = opts.type || 'normal';
    this.label = opts.label || '';
    this.enabled = opts.enabled !== false;
    this.click = opts.click;
  }

  function Menu() { this.items = []; }

  Menu.prototype.append = function (item) { this.items.push(item); };

  Menu.prototype.popup = function (x, y) {
    var api = tauri().menu, dpi = tauri().dpi;
    var made = this.items.map(function (it) {
      if (it.type === 'separator')
        return api.PredefinedMenuItem.new({ item: 'Separator' });
      if (NATIVE_EDIT[it.label])
        return api.PredefinedMenuItem.new({ item: NATIVE_EDIT[it.label] });
      return api.MenuItem.new({
        text: it.label,
        enabled: it.enabled,
        action: function () { if (typeof it.click === 'function') it.click(); }
      });
    });
    Promise.all(made)
      .then(function (items) { return api.Menu.new({ items: items }); })
      .then(function (menu) {
        return menu.popup(new dpi.LogicalPosition(x, y)).then(function () {
          // popup resolves once the menu closes; release the native resources.
          return menu.close();
        });
      })
      .catch(report('menu'));
  };

  var App = {
    manifest: { name: 'FreeWallet', version: boot.version || '0.0.0' },
    argv: [],
    on: function () {}
  };

  var JSON_FILTER = [{ name: 'FreeWallet backup', extensions: ['json'] }];

  var files = {
    // Resolves to the saved path, or null when the user cancels the dialog.
    // The file is written readable by its owner only, as the NW.js build does.
    saveText: function (defaultName, text) {
      var t = tauri();
      return t.dialog.save({ defaultPath: defaultName, filters: JSON_FILTER }).then(function (path) {
        if (!path) return null;
        return t.fs.writeTextFile(path, String(text), { mode: 384 /* 0o600 */ }).then(function () { return path; });
      });
    },
    // Resolves to { text, name }, or null when the user cancels the dialog.
    // Rejects without reading when the file is larger than maxBytes.
    openText: function (maxBytes) {
      var t = tauri();
      return t.dialog.open({ multiple: false, directory: false, filters: JSON_FILTER }).then(function (path) {
        if (!path) return null;
        return t.fs.stat(path).then(function (info) {
          if (maxBytes && info.size > maxBytes) {
            var err = new Error('too large');
            err.code = 'TOO_LARGE';
            throw err;
          }
          return t.fs.readTextFile(path);
        }).then(function (text) {
          return { text: text, name: String(path).split(/[\\/]/).pop() };
        });
      });
    }
  };

  var nw = {
    App: App,
    Shell: { openExternal: openExternal },
    Clipboard: { get: function () { return clipboard; } },
    Menu: Menu,
    MenuItem: MenuItem,
    Window: { get: function () { return { showDevTools: function () {} }; } }
  };

  function hostRequire(name) {
    if (name === 'nw.gui') return nw;
    if (name === 'crypto-js' && window.CryptoJS) return window.CryptoJS;
    var err = new Error("Cannot find module '" + name + "'");
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }

  window.nw = nw;
  Object.defineProperty(window, 'fwHost', { value: Object.freeze({ files: Object.freeze(files) }) });
  window.require = hostRequire;

  // A page-initiated window.open has nowhere to go in WKWebView; send it to the
  // system browser the way the NW.js build does.
  window.open = function (url) {
    if (url) openExternal(new URL(String(url), location.href).href);
    return null;
  };
})();
