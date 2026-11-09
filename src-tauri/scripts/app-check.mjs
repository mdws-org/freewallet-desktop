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
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WALLET_PASS = 'throwaway wallet 1';
const BACKUP_PASS = 'throwaway backup 2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const child = spawn(macosBinary(app), [], { env: { ...process.env, FW_TEST_SCRIPT: script, FW_TEST_PICK: savePath }, stdio: ['ignore', 'pipe', 'inherit'] });
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
          if (!line.startsWith('FWTEST ')) continue;
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

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'nwjs') await nwjs(...args);
else if (cmd === 'tauri') await tauri(...args);
else { console.error('usage: app-check.mjs nwjs <app> <profile> <out.json> | tauri <app> <out.json>'); process.exit(2); }
