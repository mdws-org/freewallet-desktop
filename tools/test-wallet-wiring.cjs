#!/usr/bin/env node
/*
 * Integration test for the format-v2 wallet WIRING in js/freewallet-desktop.js.
 *
 * The crypto core is covered by test-wallet-crypto.cjs; this covers the app-level
 * wrappers that thread the in-memory key through localStorage: readVault,
 * writeVault, decryptWallet, persistWallet, changeWalletPassword,
 * migrateWalletToV2, discardV1Backup, isValidWalletPassword, getWallet,
 * lockWallet. Those functions reference only ls/ss/FW/WalletCrypto/JSON, so their
 * real source is extracted from the shipped file and run against mock storage --
 * this exercises the actual code paths a real wallet takes on create, unlock,
 * key import, password change, and legacy migration, headless.
 *
 * Run: node tools/test-wallet-wiring.cjs
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const C = require('crypto-js');

// Load the real WalletCrypto (UMD) into a CommonJS context.
const WalletCrypto = (function () {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'wallet-crypto.js'), 'utf8');
  const m = { exports: {} };
  new Function('module', 'exports', 'require', src)(m, m.exports, require);
  return m.exports;
})();

// Extract a top-level `function name(...) { ... }` from the source by matching
// its opening line and reading to the first line that is exactly "}".
function extract(src, name) {
  const lines = src.split('\n');
  const start = lines.findIndex(l => new RegExp('^function ' + name + '\\s*\\(').test(l));
  if (start === -1) throw new Error('function not found: ' + name);
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error('no closing brace for: ' + name);
}

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'freewallet-desktop.js'), 'utf8');
const names = ['readVault', 'writeVault', 'decryptWallet', 'persistWallet', 'encryptWallet',
               'changeWalletPassword', 'migrateWalletToV2', 'discardV1Backup', 'getWallet',
               'isValidWalletPassword', 'lockWallet'];
const extracted = names.map(n => extract(appSrc, n)).join('\n\n');

// A mock Web Storage: get/set/removeItem over a plain object, values stringified
// like the browser does.
function mockStorage() {
  const o = {};
  return {
    _o: o,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null),
    setItem: (k, v) => { o[k] = String(v); },
    removeItem: (k) => { delete o[k]; },
  };
}

let n = 0;
const ok = (m) => { n++; console.log('  ok', m); };

// Build a fresh sandbox with the real functions and mock globals for each case.
function newEnv() {
  const ls = mockStorage(), ss = mockStorage();
  const FW = { WALLET_ENCKEY: null, WALLET_KEYS: {}, WALLET_ENCRYPTED: 0 };
  const sandbox = { ls, ss, FW, WalletCrypto, JSON, Error, console };
  vm.createContext(sandbox);
  vm.runInContext(extracted, sandbox);
  return sandbox;
}

// --- create -> unlock round trip (writeVault is what createWallet calls) ----
(function () {
  const env = newEnv();
  const seed = 'deadbeefcafefeed0011223344556677';
  const pw = 'unlock me please 9';
  const mk = WalletCrypto.makeCrypto(pw);
  // What createWallet does after deriving the key:
  env.FW.WALLET_ENCKEY = mk.keyset;
  env.ss.setItem('wallet', seed);
  env.FW.WALLET_KEYS = { '1imported': 'L1privkeywif' };
  const wrote = vm.runInContext('writeVault(' + JSON.stringify(mk.descriptor) + ')', env);
  assert.strictEqual(wrote, true);
  assert.ok(env.ls.getItem('walletVault'), 'vault written to storage');
  assert.strictEqual(env.ls.getItem('wallet'), null, 'no legacy plaintext key on disk');

  // Simulate a fresh load: memory cleared, session cleared.
  env.FW.WALLET_ENCKEY = null; env.FW.WALLET_KEYS = {}; env.ss.removeItem('wallet');
  const key = vm.runInContext('isValidWalletPassword(' + JSON.stringify(pw) + ')', env);
  assert.ok(key && key.enc && key.mac, 'password verifies to a keyset after reload');
  assert.strictEqual(vm.runInContext('isValidWalletPassword("wrong pw 1")', env), false, 'wrong password rejected');
  const unlocked = vm.runInContext('decryptWallet(' + inlineKey('k') + ')', envWith(env, key));
  assert.strictEqual(unlocked, true, 'decryptWallet succeeds with the verified keyset');
  assert.strictEqual(env.ss.getItem('wallet'), seed, 'seed restored to session');
  assert.deepStrictEqual(env.FW.WALLET_KEYS, { '1imported': 'L1privkeywif' }, 'imported keys restored');
  ok('create -> reload -> verify -> unlock restores seed and imported keys');
})();

// helper: inject the keyset object into the context and call with it
function envWith(env, key) { env.__key = key; return env; }
function inlineKey() { return '__key'; }

// --- persist after importing a key, then re-unlock ---------------------------
(function () {
  const env = newEnv();
  const seed = 'a1b2c3d4e5f600112233445566778899';
  const pw = 'another good pw 3';
  const mk = WalletCrypto.makeCrypto(pw);
  env.FW.WALLET_ENCKEY = mk.keyset;
  env.ss.setItem('wallet', seed);
  vm.runInContext('writeVault(' + JSON.stringify(mk.descriptor) + ')', env);
  // import a key and persist (what addPrivateKey does: mutate FW.WALLET_KEYS then persistWallet)
  env.FW.WALLET_KEYS = { '1abc': 'importedwif' };
  assert.strictEqual(vm.runInContext('persistWallet()', env), true, 'persistWallet writes');
  // reload + unlock
  env.FW.WALLET_ENCKEY = null; env.FW.WALLET_KEYS = {}; env.ss.removeItem('wallet');
  const key = vm.runInContext('isValidWalletPassword(' + JSON.stringify(pw) + ')', env);
  envWith(env, key);
  vm.runInContext('decryptWallet(__key)', env);
  assert.deepStrictEqual(env.FW.WALLET_KEYS, { '1abc': 'importedwif' }, 'imported key survived persist + reload');
  ok('persistWallet after key import round-trips through reload');
})();

// --- change password: old fails, new works, data intact, atomic vault --------
(function () {
  const env = newEnv();
  const seed = 'ffeeddccbbaa99887766554433221100';
  const mk = WalletCrypto.makeCrypto('first password 1');
  env.FW.WALLET_ENCKEY = mk.keyset;
  env.ss.setItem('wallet', seed);
  env.FW.WALLET_KEYS = { '1x': 'wifx' };
  vm.runInContext('writeVault(' + JSON.stringify(mk.descriptor) + ')', env);
  // change password (wallet is unlocked: ss.wallet set, FW.WALLET_ENCKEY set)
  assert.strictEqual(vm.runInContext('changeWalletPassword("second password 2")', env), true);
  // reload
  env.FW.WALLET_ENCKEY = null; env.FW.WALLET_KEYS = {}; env.ss.removeItem('wallet');
  assert.strictEqual(vm.runInContext('isValidWalletPassword("first password 1")', env), false, 'old password no longer unlocks');
  const key = vm.runInContext('isValidWalletPassword("second password 2")', env);
  assert.ok(key, 'new password unlocks');
  envWith(env, key);
  assert.strictEqual(vm.runInContext('decryptWallet(__key)', env), true);
  assert.strictEqual(env.ss.getItem('wallet'), seed, 'seed intact after password change');
  assert.deepStrictEqual(env.FW.WALLET_KEYS, { '1x': 'wifx' }, 'keys intact after password change');
  // the vault is a single record
  assert.ok(env.ls.getItem('walletVault'), 'single vault record present');
  ok('changeWalletPassword: old rejected, new works, data intact, one record');
})();

// --- lock clears the in-memory secret; persist then refuses ------------------
(function () {
  const env = newEnv();
  const mk = WalletCrypto.makeCrypto('lock test pw 4');
  env.FW.WALLET_ENCKEY = mk.keyset;
  env.ss.setItem('wallet', 'seedforlocktest0000');
  vm.runInContext('writeVault(' + JSON.stringify(mk.descriptor) + ')', env);
  vm.runInContext('lockWallet()', env);
  assert.strictEqual(env.FW.WALLET_ENCKEY, null, 'lock cleared the derived key');
  assert.strictEqual(env.ss.getItem('wallet'), null, 'lock cleared the session seed');
  assert.strictEqual(Object.keys(env.FW.WALLET_KEYS).length, 0, 'lock cleared the keys');
  let threw = false;
  try { vm.runInContext('persistWallet()', env); } catch (e) { threw = true; }
  assert.ok(threw, 'persistWallet refuses when locked (no vault key context) rather than corrupting');
  ok('lockWallet clears secrets; persistWallet refuses while locked');
})();

// --- legacy migration: convenience wallet, then encrypted wallet -------------
(function () {
  // convenience (walletEncrypted=0, cleartext password)
  const env = newEnv();
  const seed = '00112233445566778899aabbccddeeff';
  const cpw = 'legacy-generated-pw';
  env.ls.setItem('wallet', C.AES.encrypt(seed, cpw).toString());
  env.ls.setItem('walletKeys', C.AES.encrypt(JSON.stringify({ '1imp': 'legwif' }), cpw).toString());
  env.ls.setItem('walletPassword', cpw);
  env.ls.setItem('walletEncrypted', 0);
  const migrated = vm.runInContext('migrateWalletToV2(null, "brand new pw 7")', env);
  assert.strictEqual(migrated, true, 'convenience migration succeeds');
  assert.ok(env.ls.getItem('walletVault'), 'vault written');
  assert.ok(env.ls.getItem('wallet'), 'legacy blob retained as backup until first unlock');
  assert.strictEqual(env.ss.getItem('wallet'), seed, 'seed loaded into session post-migrate');
  // reload and unlock with the NEW password; legacy backup then discarded
  env.FW.WALLET_ENCKEY = null; env.FW.WALLET_KEYS = {}; env.ss.removeItem('wallet');
  const key = vm.runInContext('isValidWalletPassword("brand new pw 7")', env);
  assert.ok(key, 'new password unlocks the migrated vault');
  envWith(env, key);
  vm.runInContext('decryptWallet(__key)', env);
  assert.strictEqual(env.ss.getItem('wallet'), seed, 'seed recovered');
  assert.deepStrictEqual(env.FW.WALLET_KEYS, { '1imp': 'legwif' }, 'imported keys recovered');
  assert.strictEqual(env.ls.getItem('wallet'), null, 'legacy backup discarded after successful unlock');
  assert.strictEqual(env.ls.getItem('walletPassword'), null, 'cleartext password gone');
  ok('legacy convenience wallet migrates, unlocks with new password, backup discarded');

  // encrypted (walletEncrypted=1, stored AES(pw,pw)); wrong password rejected
  const env2 = newEnv();
  const seed2 = 'fedcba98765432100123456789abcdef';
  const upw = 'the real legacy pw 5';
  env2.ls.setItem('wallet', C.AES.encrypt(seed2, upw).toString());
  env2.ls.setItem('walletKeys', C.AES.encrypt('{}', upw).toString());
  env2.ls.setItem('walletPassword', C.AES.encrypt(upw, upw).toString());
  env2.ls.setItem('walletEncrypted', 1);
  assert.strictEqual(vm.runInContext('migrateWalletToV2("WRONG", null)', env2), false, 'wrong existing password rejected');
  assert.strictEqual(env2.ls.getItem('walletVault'), null, 'no vault written on failed migration');
  assert.strictEqual(vm.runInContext('migrateWalletToV2(' + JSON.stringify(upw) + ', null)', env2), true, 'correct existing password migrates');
  const key2 = vm.runInContext('isValidWalletPassword(' + JSON.stringify(upw) + ')', env2);
  assert.ok(key2, 'same password still unlocks after migration');
  ok('legacy encrypted wallet: wrong pw rejected (no write), correct pw migrates and still opens');
})();

console.log(`\n${n} checks passed`);
