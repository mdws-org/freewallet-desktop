#!/usr/bin/env node
/*
 * Cross-shell check: the Tauri build derives the same addresses as the NW.js
 * build and imports a backup the NW.js build exported. Throwaway seeds and
 * profiles only; never point it at a real wallet.
 *
 *   node app-check.mjs nwjs <FreeWallet.app (NW.js)> <empty work dir> <out.json>
 *       Starts a copy of the NW.js build on a fresh profile in the work dir,
 *       creates a wallet from a fresh throwaway seed, derives m/0'/0/0..2,
 *       exports a backup of it, and writes all of that to out.json.
 *
 *   node app-check.mjs tauri <FreeWallet.app (Tauri, built with --features test-hooks)> <out.json>
 *       Starts the Tauri build with FW_TEST_SCRIPT, which derives the same
 *       addresses with the page's libraries, checks that the fs plugin refuses
 *       paths the user did not pick, saves the NW.js backup with
 *       BackupFileIO.save and reads it back with BackupFileIO.open (the test
 *       build's dialog stand-in picks FW_TEST_PICK and grants it the way a pick
 *       does), imports it with the app's own import code, reloads, unlocks with
 *       the wallet password, and compares. Exits 1 on any mismatch.
 *
 *   node app-check.mjs art <FreeWallet.app (Tauri, built with --features test-hooks)>
 *       Shows a remote image, a missing remote image and a plain-http image
 *       through the page's artwork code and checks, from webview snapshots,
 *       that the sandboxed viewer frame drew the first, left the second blank
 *       and that the third was never framed. Needs network access.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WALLET_PASS = 'throwaway wallet 1';
const BACKUP_PASS = 'throwaway backup 2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The test window is never in front, and App Nap would throttle its page timers.
const TAURI_ARGS = ['-NSAppSleepDisabled', 'YES'];
// On a locked build host the window is never visible, and WebKit can suspend a
// hidden page that sits idle for a few seconds (the test build's WebKit
// switches in test_hooks.rs do not always prevent it). A page with a running
// interval that calls into the app was never suspended in testing (an empty
// interval was), so each test script keeps one; its "hb" lines are dropped.
const HEARTBEAT = "setInterval(function () { window.__TAURI_INTERNALS__.invoke('test_report', { text: 'hb' }); }, 1000);";

function macosBinary(app) {
  const plist = readFileSync(join(app, 'Contents/Info.plist'), 'utf8');
  const exe = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)[1];
  return join(app, 'Contents/MacOS', exe);
}

// Runs in the NW.js page: a new wallet from a fresh seed, its first addresses,
// and a backup export, through the app's own functions.
const NW_EXPR = `(function(){
  var words = new Mnemonic(128).toWords().join(' ');
  resetWallet();
  createWallet(words, false, ${JSON.stringify(WALLET_PASS)});
  var bc = require('bitcore-lib'), net = bc.Networks.livenet;
  var root = bc.HDPrivateKey.fromSeed(Mnemonic.fromWords(words.split(' ')).toHex(), net);
  var addrs = [0, 1, 2].map(function(i){ return bc.Address(root.derive("m/0'/0/" + i).publicKey, net).toString(); });
  var backup = WalletBackup.create(WalletBackup.collect(ls), ${JSON.stringify(BACKUP_PASS)}, { app: backupAppVersion() });
  return JSON.stringify({ words: words, version: backupAppVersion(), isNwjs: is_nwjs(), addrs: addrs,
    walletAddress: ls.getItem('walletAddress'), backup: backup });
})()`;

async function nwjs(app, profile, out) {
  // The NW.js build has no test hook and its Chromium does not open a debugging
  // port, so a copy of the app gets one extra page script that runs NW_EXPR and
  // writes the result with Node's fs. The wallet code in the copy is untouched.
  const copy = join(profile, 'FreeWallet-check.app');
  rmSync(copy, { recursive: true, force: true });
  execFileSync('/bin/cp', ['-R', app, copy]);
  const page = join(copy, 'Contents/Resources/app.nw');
  writeFileSync(join(page, 'fw-check.js'), `setTimeout(function () {
  var fs = require('fs'), out = process.env.FW_NW_OUT;
  try { fs.writeFileSync(out, ${NW_EXPR}, { mode: 0o600 }); }
  catch (e) { fs.writeFileSync(out, JSON.stringify({ error: String(e) })); }
  nw.App.quit();
}, 5000);\n`);
  const index = join(page, 'index.html');
  writeFileSync(index, readFileSync(index, 'utf8').replace('</body>', '<script src="fw-check.js"></script>\n</body>'));
  rmSync(out, { force: true });
  const child = spawn(macosBinary(copy), [`--user-data-dir=${join(profile, 'data')}`], { stdio: 'ignore', env: { ...process.env, FW_NW_OUT: out } });
  try {
    for (let i = 0; i < 90 && !existsSync(out); i++) await sleep(1000);
    if (!existsSync(out)) throw new Error('the NW.js build wrote no result');
    await sleep(500);
  } finally {
    child.kill();
    rmSync(copy, { recursive: true, force: true });
  }
  const r = JSON.parse(readFileSync(out, 'utf8'));
  if (r.error) throw new Error(r.error);
  console.log(`nwjs version=${r.version} isNwjs=${r.isNwjs} addrs=${r.addrs.join(',')} selected=${r.walletAddress} backupBytes=${r.backup.length}`);
}

// Runs in the Tauri page after each load (FW_TEST_SCRIPT). Phase 1 checks and
// imports, then reloads the way the import dialog does; phase 2 unlocks.
function tauriScript(params) {
  return `(function (P) {
  function rep(t) { window.__TAURI_INTERNALS__.invoke('test_report', { text: String(t) }); }
  rep('load phase=' + sessionStorage.getItem('fwTestPhase'));
  ${HEARTBEAT}
  setTimeout(function () {
    try {
      if (sessionStorage.getItem('fwTestPhase') !== '2') {
        rep('ui title=' + document.title + ' isNwjs=' + is_nwjs() + ' host=' + (BackupFileIO.host() ? 'tauri' : 'none') + ' isNW=' + BackupFileIO.isNW() + ' version=' + nw.App.manifest.version);
        var bc = require('bitcore-lib'), net = bc.Networks.livenet;
        var root = bc.HDPrivateKey.fromSeed(Mnemonic.fromWords(P.words.split(' ')).toHex(), net);
        for (var i = 0; i < 3; i++) rep('addr ' + i + ' ' + bc.Address(root.derive("m/0'/0/" + i).publicKey, net).toString());
        var fs = window.__TAURI__.fs;
        Promise.allSettled([fs.writeTextFile(P.probe, 'x'), fs.readTextFile(P.probe), fs.readTextFile('/etc/hosts')]).then(function (r) {
          rep('scope write=' + r[0].status + ' read=' + r[1].status + ' readEtc=' + r[2].status);
          BackupFileIO.save(WalletBackup.fileName(), P.backup, function (e, where) {
            rep('saved ' + (e ? 'error ' + e.message : where));
            BackupFileIO.open(function (e, text, name) {
              if (e) { rep('error open ' + e.message); rep('done'); return; }
              var h = WalletBackup.readHeader(text);
              var res = WalletBackup.open(text, P.backupPass);
              rep('backup same=' + (text === P.backup) + ' header=' + h.ok + ' open=' + res.ok + ' hadWallet=' + WalletBackup.hasWallet(ls));
              sessionStorage.setItem('fwTestPhase', '2');
              try { importBackupEntries(res.entries); } catch (e) { rep('error import ' + e); }
              rep('reloading');
              setTimeout(function () { window.location.reload(); }, 1500);
            });
          });
        });
      } else {
        sessionStorage.removeItem('fwTestPhase');
        var key = isValidWalletPassword(P.walletPass);
        rep('unlock key=' + !!key + ' decrypt=' + (key ? decryptWallet(key) : false));
        rep('imported addr0=' + getWalletAddress(0) + ' selected=' + ls.getItem('walletAddress'));
        rep('done');
      }
    } catch (e) { rep('error ' + e); rep('done'); }
  }, 4000);
})(${JSON.stringify(params)});`;
}

async function tauri(app, nwResult) {
  const r = JSON.parse(readFileSync(nwResult, 'utf8'));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fw-app-check-')));
  const savePath = join(dir, 'freewallet-backup.json');
  let saved = null;
  const probe = join(dir, 'unpicked.txt');
  const script = join(dir, 'test.js');
  writeFileSync(script, tauriScript({ words: r.words, backup: r.backup, backupPass: BACKUP_PASS, walletPass: WALLET_PASS, probe }), { mode: 0o600 });
  const lines = [];
  const child = spawn(macosBinary(app), TAURI_ARGS, { env: { ...process.env, FW_TEST_SCRIPT: script, FW_TEST_PICK: savePath }, stdio: ['ignore', 'pipe', 'inherit'], detached: true });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out; got: ' + lines.join(' | '))), 90000);
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.startsWith('FWTEST ') || line === 'FWTEST hb') continue;
          lines.push(line.slice(7));
          console.log(line);
          if (line.startsWith('FWTEST saved /')) saved = line.slice('FWTEST saved '.length);
          if (line === 'FWTEST done') { clearTimeout(timer); resolve(); }
        }
      });
    });
    if (saved) lines.push('saved mode=' + (statSync(saved).mode & 0o777).toString(8) + ' samePath=' + (saved === savePath));
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
  const want = [
    ...r.addrs.map((a, i) => `addr ${i} ${a}`),
    'scope write=rejected read=rejected readEtc=rejected',
    'saved mode=600 samePath=true',
    'backup same=true header=true open=true hadWallet=false',
    'unlock key=true decrypt=true',
    `imported addr0=${r.addrs[0]} selected=${r.walletAddress}`,
  ];
  const missing = want.filter((w) => !lines.includes(w));
  if (!lines.some((l) => /^ui .* host=tauri isNW=false /.test(l))) missing.push('ui host=tauri isNW=false');
  if (missing.length) {
    console.log('FAIL, missing:\n  ' + missing.join('\n  '));
    process.exit(1);
  }
  console.log('PASS: same addresses as the NW.js build, backup imported, unpicked paths refused');
}

// Artwork check. A remote image, a missing remote image and a plain-http image
// go through the page's own showAssetArtwork() inside the artwork markup of
// html/balances.html. The page reports what it framed; the webview snapshots
// (test_snapshot) show what the sandboxed frame actually drew, which the page
// itself cannot see.
const ART_BASE = 'https://raw.githubusercontent.com/mdws-org/freewallet-desktop/master/images/';
const ART_FILE = 'freewallet-icon-180.png';

function artScript(params) {
  return `(function (P) {
  if (window.__fwArt) return; window.__fwArt = 1;
  var T = window.__TAURI_INTERNALS__;
  function rep(t) { T.invoke('test_report', { text: String(t) }); }
  rep("load");
  ${HEARTBEAT}
  function cip(url) { return { images: [{ type: 'large', data: url, name: 'fixture' }], audio: [], video: [], description: '' }; }
  setTimeout(function () {
    try {
      var box = $('<div id="fwtest-art" style="position:fixed;left:0;top:0;width:360px;background:#fff;z-index:2147483647"></div>').appendTo('body');
      FW.NFT_DATA = false;
      function run(name, url, next) {
        box.html(P.markup);
        showAssetArtwork(cip(url));
        var f = $('#artwork-frame iframe');
        rep(name + ' frames=' + f.length + (f.length ? ' sandbox=' + JSON.stringify(f.attr('sandbox')) + ' src=' + f.attr('src') : ''));
        if (!f.length) { next(); return; }
        var waited = 0;
        (function poll() {
          if ($('#artwork-loader').is(':visible') && waited < 20000) { waited += 250; setTimeout(poll, 250); return; }
          setTimeout(function () {
            var r = f[0].getBoundingClientRect();
            rep(name + ' loaded=' + !$('#artwork-loader').is(':visible') + ' rect=' + [r.left, r.top, r.width, r.height].map(Math.round).join(',') + ' inner=' + window.innerWidth);
            T.invoke('test_snapshot', { path: P.dir + '/' + name + '.tiff' }).then(
              function () { rep(name + ' snapshot'); next(); },
              function (e) { rep(name + ' snapshot error ' + e); next(); });
          }, 1500);
        })();
      }
      run('art', P.art, function () { run('missing', P.missing, function () { run('plain', P.plain, function () { rep('done'); }); }); });
    } catch (e) { rep('error ' + e); rep('done'); }
  }, 4000);
})(${JSON.stringify(params)});`;
}

// Pixels of an image file as {w, h, px(x, y) -> [r, g, b]}, via sips -> BMP.
function readPixels(file, dir) {
  const bmp = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.bmp`);
  execFileSync('/usr/bin/sips', ['-s', 'format', 'bmp', file, '--out', bmp], { stdio: 'ignore' });
  const b = readFileSync(bmp);
  const off = b.readUInt32LE(10), w = b.readInt32LE(18), hRaw = b.readInt32LE(22), bpp = b.readUInt16LE(28);
  const h = Math.abs(hRaw), bytes = bpp / 8, stride = Math.ceil((w * bytes) / 4) * 4;
  if (bpp !== 24 && bpp !== 32) throw new Error(`unexpected BMP depth ${bpp}`);
  return {
    w, h,
    px(x, y) {
      const row = hRaw > 0 ? h - 1 - y : y, i = off + row * stride + x * bytes;
      const a = bpp === 32 ? b[i + 3] / 255 : 1;
      // Composite on white, the way the page shows a transparent image.
      return [b[i + 2], b[i + 1], b[i]].map((c) => Math.round(c * a + 255 * (1 - a)));
    },
  };
}

// Mean colour and share of non-white pixels over the middle 80% of a box.
function regionStats(img, x0, y0, w, h) {
  let n = 0, ink = 0;
  const sum = [0, 0, 0];
  for (let y = Math.round(y0 + h * 0.1); y < y0 + h * 0.9; y++)
    for (let x = Math.round(x0 + w * 0.1); x < x0 + w * 0.9; x++) {
      const p = img.px(x, y);
      p.forEach((c, k) => (sum[k] += c));
      if (Math.max(...p.map((c) => 255 - c)) > 30) ink++;
      n++;
    }
  return { mean: sum.map((s) => Math.round(s / n)), ink: ink / n };
}

async function art(app) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fw-art-check-')));
  const lines = [];
  const results = [];
  try {
    const local = readFileSync(new URL(`../../images/${ART_FILE}`, import.meta.url));
    const remote = Buffer.from(await (await fetch(ART_BASE + ART_FILE)).arrayBuffer());
    if (!local.equals(remote)) throw new Error('the remote test image differs from images/' + ART_FILE);
    writeFileSync(join(dir, 'source.png'), local);
    const balances = readFileSync(new URL('../../html/balances.html', import.meta.url), 'utf8');
    const markup = balances.slice(balances.indexOf('<div id="digitalArtInfo"'), balances.indexOf('<!-- Extended Information from JSON -->'));
    if (!markup.includes('id="artwork-frame"')) throw new Error('no #artwork-frame in html/balances.html');
    const script = join(dir, 'test.js');
    writeFileSync(script, artScript({
      dir, markup,
      art: ART_BASE + ART_FILE,
      missing: ART_BASE + 'fw-art-check-missing.png',
      plain: ART_BASE.replace('https:', 'http:') + ART_FILE,
    }), { mode: 0o600 });
    const child = spawn(macosBinary(app), TAURI_ARGS, { env: { ...process.env, FW_TEST_SCRIPT: script }, stdio: ['ignore', 'pipe', 'inherit'], detached: true });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out; got: ' + lines.join(' | '))), 120000);
        let buf = '';
        child.stdout.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (!line.startsWith('FWTEST ') || line === 'FWTEST hb') continue;
            lines.push(line.slice(7));
            console.log(line);
            if (line === 'FWTEST done') { clearTimeout(timer); resolve(); }
          }
        });
      });
    } finally {
      child.kill();
    }
    const source = readPixels(join(dir, 'source.png'), dir);
    const want = regionStats(source, 0, 0, source.w, source.h);
    console.log(`source mean=${want.mean} ink=${want.ink.toFixed(3)}`);
    for (const name of ['art', 'missing']) {
      const m = lines.map((l) => new RegExp(`^${name} loaded=true rect=(\\d+),(\\d+),(\\d+),(\\d+) inner=(\\d+)$`).exec(l)).find(Boolean);
      if (!m || !lines.includes(`${name} snapshot`)) { results.push(`${name}: no load or no snapshot`); continue; }
      const shot = readPixels(join(dir, `${name}.tiff`), dir);
      const s = shot.w / Number(m[5]);
      const got = regionStats(shot, m[1] * s, m[2] * s, m[3] * s, m[4] * s);
      const diff = Math.max(...got.mean.map((c, k) => Math.abs(c - want.mean[k])));
      console.log(`${name} scale=${s} mean=${got.mean} ink=${got.ink.toFixed(3)} maxChannelDiff=${diff}`);
      if (name === 'art' && !(diff <= 20 && got.ink > want.ink * 0.8)) results.push(`art: the frame does not show the image (diff ${diff}, ink ${got.ink.toFixed(3)})`);
      if (name === 'missing' && !(got.ink < 0.01)) results.push(`missing: the frame is not blank (ink ${got.ink.toFixed(3)})`);
    }
    const viewer = 'fwart://localhost/view?src=' + encodeURIComponent(ART_BASE + ART_FILE);
    if (!lines.includes(`art frames=1 sandbox="" src=${viewer}`)) results.push('art: not framed through the viewer with an empty sandbox');
    if (!lines.includes('plain frames=0')) results.push('plain: an http image was framed');
  } catch (e) {
    results.push('error ' + e.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (results.length) {
    console.log('FAIL:\n  ' + results.join('\n  '));
    process.exit(1);
  }
  console.log('PASS: remote artwork drawn in the sandboxed viewer frame, missing image blank, http not framed');
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'nwjs') await nwjs(...args);
else if (cmd === 'tauri') await tauri(...args);
else if (cmd === 'art') await art(...args);
else { console.error('usage: app-check.mjs nwjs <app> <profile> <out.json> | tauri <app> <out.json> | art <app>'); process.exit(2); }
