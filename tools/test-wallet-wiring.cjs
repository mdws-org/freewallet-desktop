#!/usr/bin/env node
/*
 * Integration test for the format-v2 wallet WIRING in js/freewallet-desktop.js.
 *
 * The crypto core is covered by test-wallet-crypto.cjs; this covers the app-level
 * wrappers that thread the in-memory key through localStorage: readVault,
 * writeVault, decryptWallet, persistWallet, changeWalletPassword,
 * migrateWalletToV2, discardV1Backup, isValidWalletPassword,
 * validateNewWalletPassword, getWallet, lockWallet. Those functions reference
 * only ls/ss/FW/WalletCrypto/JSON, so their real source is extracted from the
 * shipped file and run against mock storage -- this exercises the actual code
 * paths a real wallet takes on create, unlock, key import, password change, and
 * legacy migration, headless. The dialogs themselves are not run here; the rules
 * they apply live in the functions above so that they can be.
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
               'changeWalletPassword', 'migrateWalletToV2', 'recoverVaultFromV1Backup',
               'rebuildVaultFromV1', 'discardV1Backup', 'getWallet',
               'isValidWalletPassword', 'validateNewWalletPassword', 'lockWallet',
               'initWallet', 'checkBtcpayAuth', 'disableBtcpayAutopay',
               'dialogPassword', 'dialogMigrate', 'dialogEnableBtcpay'];
const extracted = names.map(n => extract(appSrc, n)).join('\n\n');

// Everything the extracted code reaches into that is not itself extracted is
// replaced by a recorder; `calls` lists them in order, with arguments. The three
// password dialogs ARE extracted: BootstrapDialog.show is replaced by a capture
// of the options object, and `$` by a stub that returns the values a test
// assigns to `fields` (keyed by selector), so each button's action handler runs
// the real code against mock storage.
const SPIES = ['dialogWelcome', 'checkUpdateWallet', 'setInterval', 'updateWalletOptions',
               'updateOracleList', 'updateDonationList', 'dialogMessage', 'dialogConfirm'];

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
  const FW = { WALLET_ENCKEY: null, WALLET_KEYS: {}, WALLET_ENCRYPTED: 0,
               BTCPAY_ORDERS: { mainnet: {}, testnet: {} } };
  const calls = [];
  const fields = {};
  // Enough of jQuery for the extracted code: $(selector).val()/append()/focus()
  // and $.each over arrays and plain objects.
  const $ = (sel) => ({
    val: () => (Object.prototype.hasOwnProperty.call(fields, sel) ? fields[sel] : ''),
    append() { return this; },
    focus() {},
  });
  $.each = (obj, fn) => { for (const k in obj) if (fn.call(obj[k], k, obj[k]) === false) break; };
  const BootstrapDialog = { show: (opts) => { sandbox.__dialog = opts; } };
  const sandbox = { ls, ss, FW, WalletCrypto, JSON, Error, console, $, calls, fields, BootstrapDialog };
  for (const s of SPIES) sandbox[s] = (...args) => { calls.push([s, ...args]); };
  vm.createContext(sandbox);
  vm.runInContext(extracted, sandbox);
  return sandbox;
}

// Open a dialog by running `open` (e.g. 'dialogPassword(false)'), fill its
// inputs, and press the button with the given label. Returns whether the
// handler closed the dialog and the messages it showed.
function pressDialog(env, open, label, inputs) {
  for (const k of Object.keys(env.fields)) delete env.fields[k];
  for (const [name, value] of Object.entries(inputs)) env.fields['[name="' + name + '"]'] = value;
  env.calls.length = 0;
  vm.runInContext(open, env);
  const opts = env.__dialog;
  const btn = opts.buttons.find(b => b.label === label);
  if (!btn) throw new Error('no button ' + label);
  let closed = false;
  btn.action({ close: () => { closed = true; } });
  const messages = env.calls.filter(c => c[0] === 'dialogMessage').map(c => ({ title: c[1], text: c[2], error: c[3] }));
  return { closed, messages };
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

// --- new-password rules apply when setting, never when unlocking ------------
(function () {
  const env = newEnv();
  const v = (pw, confirm) => vm.runInContext(
    'validateNewWalletPassword(' + JSON.stringify(pw) + (confirm === undefined ? '' : ',' + JSON.stringify(confirm)) + ')', env);
  assert.strictEqual(v('short pw 1'), 'Wallet password must be at least 12 characters long');
  assert.strictEqual(v('no digits in here'), 'Wallet password must contain at least 1 number');
  assert.strictEqual(v('long enough pw 1', 'long enough pw 2'), 'Password and Confirmation password do not match!');
  assert.strictEqual(v('long enough pw 1', 'long enough pw 1'), false, 'matching pair accepted');
  assert.strictEqual(v('long enough pw 1'), false, 'confirmation optional');

  // A legacy wallet migrated on a password the rules above would refuse: the
  // verifier alone decides an unlock, so that password keeps opening the vault.
  const seed = '0badc0de0badc0de0badc0de0badc0de';
  const legacyPw = 'seven77'; // upstream's minimum was 7 characters
  assert.ok(v(legacyPw), 'the legacy password would be refused as a NEW password');
  env.ls.setItem('wallet', C.AES.encrypt(seed, legacyPw).toString());
  env.ls.setItem('walletKeys', C.AES.encrypt('{}', legacyPw).toString());
  env.ls.setItem('walletPassword', C.AES.encrypt(legacyPw, legacyPw).toString());
  env.ls.setItem('walletEncrypted', 1);
  assert.strictEqual(vm.runInContext('migrateWalletToV2(' + JSON.stringify(legacyPw) + ', null)', env), true, 'migrates on the short password');
  env.FW.WALLET_ENCKEY = null; env.FW.WALLET_KEYS = {}; env.ss.removeItem('wallet');
  const key = vm.runInContext('isValidWalletPassword(' + JSON.stringify(legacyPw) + ')', env);
  assert.ok(key, 'short legacy password still verifies after migration');
  envWith(env, key);
  assert.strictEqual(vm.runInContext('decryptWallet(__key)', env), true, 'and still unlocks');
  assert.strictEqual(env.ss.getItem('wallet'), seed, 'seed recovered on the short password');
  ok('new-password rules: set paths refuse weak passwords; a migrated short password still unlocks');
})();

// --- a verified password whose vault will not decrypt: locked and untouched --
(function () {
  const env = newEnv();
  const pw = 'corrupt vault pw 8';
  const mk = WalletCrypto.makeCrypto(pw);
  env.FW.WALLET_ENCKEY = mk.keyset;
  env.ss.setItem('wallet', 'seedforcorruptiontest00');
  env.FW.WALLET_KEYS = { '1k': 'wifk' };
  vm.runInContext('writeVault(' + JSON.stringify(mk.descriptor) + ')', env);
  // Damage the wallet blob but leave the KDF descriptor (and so the verifier) intact.
  const vault = JSON.parse(env.ls.getItem('walletVault'));
  vault.wallet = vault.wallet.slice(0, -8) + 'AAAAAAAA';
  env.ls.setItem('walletVault', JSON.stringify(vault));
  env.FW.WALLET_ENCKEY = null; env.FW.WALLET_KEYS = {}; env.ss.removeItem('wallet');
  const key = vm.runInContext('isValidWalletPassword(' + JSON.stringify(pw) + ')', env);
  assert.ok(key, 'password still verifies (the verifier is separate from the blob)');
  envWith(env, key);
  assert.strictEqual(vm.runInContext('decryptWallet(__key)', env), false, 'decryptWallet reports the failure');
  assert.strictEqual(env.FW.WALLET_ENCKEY, null, 'no key retained on failure');
  assert.strictEqual(env.ss.getItem('wallet'), null, 'nothing decrypted into session on failure');
  assert.strictEqual(Object.keys(env.FW.WALLET_KEYS).length, 0, 'no keys loaded on failure');
  ok('decryptWallet returns false on a damaged vault and leaves the wallet locked');
})();

// --- lock keeps the Auto-BTCpay stash (deliberate: auto-pay after autolock) --
(function () {
  const env = newEnv();
  const mk = WalletCrypto.makeCrypto('autopay stash pw 6');
  env.FW.WALLET_ENCKEY = mk.keyset;
  env.ss.setItem('wallet', 'seedforautopay0000');
  env.FW.WALLET_KEYS = { '1imp': 'impwif' };
  vm.runInContext('writeVault(' + JSON.stringify(mk.descriptor) + ')', env);
  // What dialogEnableBtcpay stores before it re-locks.
  env.ss.setItem('btcpayWallet', env.ss.getItem('wallet'));
  env.ss.setItem('btcpayKeys', JSON.stringify(env.FW.WALLET_KEYS));
  vm.runInContext('lockWallet()', env);
  assert.strictEqual(env.ss.getItem('wallet'), null, 'session seed cleared by lock');
  assert.strictEqual(Object.keys(env.FW.WALLET_KEYS).length, 0, 'in-memory keys cleared by lock');
  assert.strictEqual(env.ss.getItem('btcpayWallet'), 'seedforautopay0000', 'auto-pay seed stash survives lock');
  assert.strictEqual(env.ss.getItem('btcpayKeys'), JSON.stringify({ '1imp': 'impwif' }), 'auto-pay key stash survives lock with it');
  ok('lockWallet keeps the Auto-BTCpay seed and key stash together (same lifecycle)');

  // A live stash tracks later key changes; disabling auto-pay removes it and
  // zeroes every order's flag.
  vm.runInContext('decryptWallet(isValidWalletPassword("autopay stash pw 6"))', env);
  env.FW.WALLET_KEYS['1new'] = 'newwif';
  assert.strictEqual(vm.runInContext('persistWallet()', env), true);
  assert.strictEqual(env.ss.getItem('btcpayKeys'), JSON.stringify({ '1imp': 'impwif', '1new': 'newwif' }), 'stash refreshed by the vault write');
  env.FW.BTCPAY_ORDERS.mainnet['1addr'] = { 'orderhash1': 1, 'orderhash2': 0 };
  vm.runInContext('disableBtcpayAutopay()', env);
  assert.strictEqual(env.FW.BTCPAY_ORDERS.mainnet['1addr']['orderhash1'], 0, 'auto-pay flag cleared');
  assert.strictEqual(env.ls.getItem('btcpayOrders'), JSON.stringify(env.FW.BTCPAY_ORDERS), 'cleared flags saved');
  assert.strictEqual(env.ss.getItem('btcpayWallet'), null, 'seed stash removed on disable');
  assert.strictEqual(env.ss.getItem('btcpayKeys'), null, 'key stash removed on disable');
  ok('a live key stash follows vault writes; disableBtcpayAutopay clears flags and stash');
})();

// --- decryptWallet: keys that decrypt but do not parse leave no state -------
(function () {
  const env = newEnv();
  const pw = 'bad keys blob pw 3';
  const mk = WalletCrypto.makeCrypto(pw);
  env.FW.WALLET_ENCKEY = mk.keyset;
  env.ss.setItem('wallet', 'seedforbadkeys000000');
  vm.runInContext('writeVault(' + JSON.stringify(mk.descriptor) + ')', env);
  const vault = JSON.parse(env.ls.getItem('walletVault'));
  vault.keys = WalletCrypto.encrypt('this is not json', mk.keyset);
  env.ls.setItem('walletVault', JSON.stringify(vault));
  env.FW.WALLET_ENCKEY = null; env.FW.WALLET_KEYS = {}; env.ss.removeItem('wallet');
  const key = vm.runInContext('isValidWalletPassword(' + JSON.stringify(pw) + ')', env);
  assert.ok(key, 'password verifies');
  envWith(env, key);
  assert.strictEqual(vm.runInContext('decryptWallet(__key)', env), false, 'unparseable keys reported as a failed decrypt, not thrown');
  assert.strictEqual(env.FW.WALLET_ENCKEY, null, 'no key retained');
  assert.strictEqual(env.ss.getItem('wallet'), null, 'seed not left in session');
  ok('decryptWallet returns false (no partial unlock) when the keys blob is not JSON');
})();

// --- initWallet routes on record presence, never on parseability -----------
(function () {
  const route = (setup) => {
    const env = newEnv();
    // Only the routing is under test here: replace the real dialogs with recorders.
    for (const d of ['dialogPassword', 'dialogMigrate']) env[d] = (...args) => { env.calls.push([d, ...args]); };
    setup(env);
    env.ss.setItem('wallet', 'stale-copy-from-a-previous-load');
    vm.runInContext('initWallet()', env);
    return { env, dialogs: env.calls.filter(c => c[0].startsWith('dialog')) };
  };
  // v2 vault: unlock, with the Auto-BTCpay check on both answers
  let r = route(env => env.ls.setItem('walletVault', '{"v":2,"crypto":{}}'));
  assert.strictEqual(r.dialogs.length, 1);
  assert.strictEqual(r.dialogs[0][0], 'dialogPassword');
  assert.strictEqual(r.dialogs[0][1], false, 'unlock, not change');
  assert.strictEqual(typeof r.dialogs[0][2], 'function', 'success callback set');
  assert.strictEqual(typeof r.dialogs[0][3], 'function', 'cancel callback set');
  assert.strictEqual(r.env.ss.getItem('wallet'), null, 'stale session copy cleared');
  // damaged v2 record: still the unlock dialog, never the create-wallet flow
  r = route(env => env.ls.setItem('walletVault', '{"v":2,"cry'));
  assert.strictEqual(r.dialogs[0][0], 'dialogPassword', 'a damaged vault is still a wallet');
  // legacy only: migrate, with the check on success only
  r = route(env => env.ls.setItem('wallet', 'U2FsdGVkX1legacyblob'));
  assert.strictEqual(r.dialogs[0][0], 'dialogMigrate');
  assert.strictEqual(typeof r.dialogs[0][1], 'function');
  // nothing on disk: welcome
  r = route(() => {});
  assert.strictEqual(r.dialogs[0][0], 'dialogWelcome');
  ok('initWallet: v2 -> unlock, damaged v2 -> unlock, v1 -> migrate, none -> welcome');
})();

// --- checkBtcpayAuth: silent stash when open, ask when locked ---------------
(function () {
  const env = newEnv();
  env.FW.BTCPAY_ORDERS.mainnet['1addr'] = { 'orderhash1': 1 };
  env.FW.WALLET_KEYS = { '1imp': 'impwif' };
  env.ss.setItem('wallet', 'seedopen0000000000');
  vm.runInContext('checkBtcpayAuth()', env);
  assert.strictEqual(env.ss.getItem('btcpayWallet'), 'seedopen0000000000', 'open wallet: seed stashed');
  assert.strictEqual(env.ss.getItem('btcpayKeys'), JSON.stringify({ '1imp': 'impwif' }), 'open wallet: keys stashed with it');
  assert.strictEqual(env.__dialog, undefined, 'open wallet: no dialog');

  const env2 = newEnv();
  env2.FW.BTCPAY_ORDERS.mainnet['1addr'] = { 'orderhash1': 1 };
  vm.runInContext('checkBtcpayAuth()', env2);
  assert.strictEqual(env2.ss.getItem('btcpayWallet'), null, 'locked wallet: nothing stashed');
  assert.ok(env2.__dialog && /Enable Auto-BTCpay/.test(env2.__dialog.title), 'locked wallet: asks');

  const env3 = newEnv();
  env3.FW.BTCPAY_ORDERS.mainnet['1addr'] = { 'orderhash1': 0 };
  env3.ss.setItem('wallet', 'seedopen0000000000');
  vm.runInContext('checkBtcpayAuth()', env3);
  assert.strictEqual(env3.ss.getItem('btcpayWallet'), null, 'no auto-pay order: nothing stashed');
  assert.strictEqual(env3.__dialog, undefined, 'no auto-pay order: no dialog');
  ok('checkBtcpayAuth stashes silently when open, asks when locked, does nothing without auto-pay orders');
})();

// --- the dialogs themselves: what each button applies to the password --------
(function () {
  // A legacy wallet on a 7-character password, migrated, reloaded.
  const seed = '5eed5eed5eed5eed5eed5eed5eed5eed';
  const legacyPw = 'seven77';
  const legacyEnv = () => {
    const env = newEnv();
    env.ls.setItem('wallet', C.AES.encrypt(seed, legacyPw).toString());
    env.ls.setItem('walletKeys', C.AES.encrypt(JSON.stringify({ '1imp': 'impwif' }), legacyPw).toString());
    env.ls.setItem('walletPassword', C.AES.encrypt(legacyPw, legacyPw).toString());
    env.ls.setItem('walletEncrypted', 1);
    return env;
  };

  // Migration dialog on an already-encrypted wallet: keeps the short password
  // and says so.
  let env = legacyEnv();
  let r = pressDialog(env, 'cbCount = 0; dialogMigrate(function(){ cbCount++; })', 'Ok', { wallet_password: legacyPw });
  assert.ok(r.closed, 'migrate dialog closes on the correct legacy password');
  assert.ok(env.ls.getItem('walletVault'), 'vault written');
  assert.ok(/does not meet the requirements/.test(r.messages[0].text), 'weak kept password is pointed out');
  assert.strictEqual(env.cbCount, 1, 'migrate callback ran on success');

  // Unlock dialog: the short password is verified, not measured.
  env.FW.WALLET_ENCKEY = null; env.FW.WALLET_KEYS = {}; env.ss.removeItem('wallet');
  r = pressDialog(env, 'cbCount = 0; cancelCount = 0; dialogPassword(false, function(){ cbCount++; }, function(){ cancelCount++; })', 'Ok', { wallet_password: 'wrong pw 123456' });
  assert.ok(!r.closed, 'wrong password keeps the dialog open');
  assert.strictEqual(r.messages[0].text, 'Invalid password');
  assert.strictEqual(env.cbCount, 0, 'no callback on a wrong password');
  r = pressDialog(env, 'cbCount = 0; cancelCount = 0; dialogPassword(false, function(){ cbCount++; }, function(){ cancelCount++; })', 'Ok', { wallet_password: legacyPw });
  assert.ok(r.closed, 'the 7-character migrated password unlocks through the dialog');
  assert.strictEqual(env.ss.getItem('wallet'), seed, 'seed in session');
  assert.strictEqual(env.cbCount, 1, 'callback ran once, on success');
  assert.strictEqual(env.cancelCount, 0);
  assert.strictEqual(env.ls.getItem('wallet'), null, 'legacy backup discarded after the first v2 unlock');
  // Cancel: no callback, the cancel hook instead.
  vm.runInContext('lockWallet()', env);
  r = pressDialog(env, 'cbCount = 0; cancelCount = 0; dialogPassword(false, function(){ cbCount++; }, function(){ cancelCount++; })', 'Cancel', {});
  assert.ok(r.closed && env.cbCount === 0 && env.cancelCount === 1, 'Cancel runs onCancel only');
  assert.strictEqual(env.ss.getItem('skipWalletAuth'), '1');
  ok('dialogs: migrate keeps a 7-char password; unlock verifies it; callback only on success; Cancel -> onCancel');

  // Enable-Auto-BTCpay dialog: same verify-only rule, then stash and re-lock.
  vm.runInContext('decryptWallet(isValidWalletPassword(' + JSON.stringify(legacyPw) + '))', env);
  vm.runInContext('lockWallet()', env);
  r = pressDialog(env, 'dialogEnableBtcpay()', 'Enable', { wallet_password: 'wrong pw 123456' });
  assert.ok(!r.closed && r.messages[0].text === 'Invalid password');
  assert.strictEqual(env.ss.getItem('btcpayWallet'), null, 'nothing stashed on a wrong password');
  r = pressDialog(env, 'dialogEnableBtcpay()', 'Enable', { wallet_password: legacyPw });
  assert.ok(r.closed, 'enable dialog accepts the 7-character password');
  assert.strictEqual(env.ss.getItem('btcpayWallet'), seed, 'seed stashed');
  assert.strictEqual(env.ss.getItem('btcpayKeys'), JSON.stringify({ '1imp': 'impwif' }), 'keys stashed with it');
  assert.strictEqual(env.ss.getItem('wallet'), null, 'wallet re-locked');
  assert.strictEqual(env.FW.WALLET_ENCKEY, null, 'no derived key kept');
  ok('dialogEnableBtcpay: verify-only, then stash seed + keys and re-lock');

  // Change-password dialog: the current password must verify; the new one must
  // meet the rules; then the vault is re-keyed.
  vm.runInContext('decryptWallet(isValidWalletPassword(' + JSON.stringify(legacyPw) + '))', env);
  const change = (inputs) => pressDialog(env, 'dialogPassword(true)', 'Ok', inputs);
  r = change({ wallet_current_password: 'not it 12345', wallet_password: 'a strong new pw 1', wallet_confirm_password: 'a strong new pw 1' });
  assert.ok(!r.closed && r.messages[0].text === 'Current password is not correct');
  assert.ok(vm.runInContext('isValidWalletPassword(' + JSON.stringify(legacyPw) + ')', env), 'vault untouched');
  r = change({ wallet_current_password: legacyPw, wallet_password: 'short 1', wallet_confirm_password: 'short 1' });
  assert.ok(!r.closed && /at least 12 characters/.test(r.messages[0].text), 'new password must meet the rules');
  r = change({ wallet_current_password: legacyPw, wallet_password: 'a strong new pw 1', wallet_confirm_password: 'a strong new pw 1' });
  assert.ok(r.closed, 'change succeeds');
  assert.strictEqual(vm.runInContext('isValidWalletPassword(' + JSON.stringify(legacyPw) + ')', env), false, 'old password rejected');
  assert.ok(vm.runInContext('isValidWalletPassword("a strong new pw 1")', env), 'new password verifies');
  ok('dialogPassword(true): current password verified, new one validated, vault re-keyed');

  // Unlock on a damaged record: named as such, and nothing changes.
  const env2 = newEnv();
  env2.ls.setItem('walletVault', '{"v":2,"cry');
  r = pressDialog(env2, 'dialogPassword(false)', 'Ok', { wallet_password: 'whatever pw 123' });
  assert.ok(!r.closed && /damaged and could not be read/.test(r.messages[0].text));
  assert.strictEqual(env2.ls.getItem('walletVault'), '{"v":2,"cry', 'record untouched');
  ok('unlock on an unreadable vault record reports the damage, not a wrong password');
})();

// --- a damaged vault is rebuilt from the legacy backup, never re-keyed blind --
(function () {
  const seed = 'bac4bac4bac4bac4bac4bac4bac4bac4';
  const damage = (env) => {
    const vault = JSON.parse(env.ls.getItem('walletVault'));
    vault.wallet = vault.wallet.slice(0, -8) + 'AAAAAAAA';
    env.ls.setItem('walletVault', JSON.stringify(vault));
    env.FW.WALLET_ENCKEY = null; env.FW.WALLET_KEYS = {}; env.ss.removeItem('wallet');
  };

  // Wallet that had a password before migration: same password opens the backup.
  const pw = 'kept legacy pw 4';
  let env = newEnv();
  env.ls.setItem('wallet', C.AES.encrypt(seed, pw).toString());
  env.ls.setItem('walletKeys', C.AES.encrypt(JSON.stringify({ '1k': 'wifk' }), pw).toString());
  env.ls.setItem('walletPassword', C.AES.encrypt(pw, pw).toString());
  env.ls.setItem('walletEncrypted', 1);
  assert.strictEqual(vm.runInContext('migrateWalletToV2(' + JSON.stringify(pw) + ', null)', env), true);
  damage(env);
  assert.strictEqual(vm.runInContext('decryptWallet(isValidWalletPassword(' + JSON.stringify(pw) + '))', env), false, 'damaged vault will not decrypt');
  assert.strictEqual(vm.runInContext('recoverVaultFromV1Backup("wrong pw 12345", true)', env), false, 'a wrong password rebuilds nothing');
  assert.ok(/AAAAAAAA/.test(JSON.parse(env.ls.getItem('walletVault')).wallet), 'damaged record untouched by the refused rebuild');
  assert.strictEqual(vm.runInContext('recoverVaultFromV1Backup(' + JSON.stringify(pw) + ', false)', env), true, 'rebuilt on the legacy check alone');
  assert.strictEqual(env.ss.getItem('wallet'), seed, 'unlocked after rebuild');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(env.FW.WALLET_KEYS)), { '1k': 'wifk' }, 'imported keys back');
  env.FW.WALLET_ENCKEY = null; env.FW.WALLET_KEYS = {}; env.ss.removeItem('wallet');
  assert.strictEqual(vm.runInContext('decryptWallet(isValidWalletPassword(' + JSON.stringify(pw) + '))', env), true, 'rebuilt vault opens normally');

  // Former no-password wallet: the legacy password is the stored one, so the
  // rebuild is allowed only once the v2 verifier has vouched for the password.
  const cpw = 'legacy-generated-pw', npw = 'chosen at migration 9';
  env = newEnv();
  env.ls.setItem('wallet', C.AES.encrypt(seed, cpw).toString());
  env.ls.setItem('walletKeys', C.AES.encrypt('{}', cpw).toString());
  env.ls.setItem('walletPassword', cpw);
  env.ls.setItem('walletEncrypted', 0);
  assert.strictEqual(vm.runInContext('migrateWalletToV2(null, ' + JSON.stringify(npw) + ')', env), true);
  damage(env);
  assert.strictEqual(vm.runInContext('recoverVaultFromV1Backup(' + JSON.stringify(npw) + ', false)', env), false, 'unproven password: refused');
  assert.strictEqual(vm.runInContext('recoverVaultFromV1Backup(' + JSON.stringify(npw) + ', true)', env), true, 'verifier-proven password: rebuilt');
  assert.strictEqual(env.ss.getItem('wallet'), seed);

  // Through the dialog: the damaged vault opens with a message saying so.
  env = newEnv();
  env.ls.setItem('wallet', C.AES.encrypt(seed, pw).toString());
  env.ls.setItem('walletKeys', C.AES.encrypt('{}', pw).toString());
  env.ls.setItem('walletPassword', C.AES.encrypt(pw, pw).toString());
  env.ls.setItem('walletEncrypted', 1);
  vm.runInContext('migrateWalletToV2(' + JSON.stringify(pw) + ', null)', env);
  damage(env);
  let r = pressDialog(env, 'dialogPassword(false)', 'Ok', { wallet_password: 'wrong pw 12345' });
  assert.ok(!r.closed && r.messages[0].text === 'Invalid password');
  r = pressDialog(env, 'dialogPassword(false)', 'Ok', { wallet_password: pw });
  assert.ok(r.closed && /rebuilt from the copy/.test(r.messages[0].text), 'dialog rebuilds and says so');
  assert.strictEqual(env.ss.getItem('wallet'), seed);
  // No backup left: the damaged vault stays locked and untouched.
  env.ls.removeItem('wallet'); env.ls.removeItem('walletKeys'); env.ls.removeItem('walletPassword');
  damage(env);
  r = pressDialog(env, 'dialogPassword(false)', 'Ok', { wallet_password: pw });
  assert.ok(!r.closed && /could not be decrypted/.test(r.messages[0].text), 'no backup: reported, locked');
  ok('damaged vault: rebuilt from the legacy backup on a proven password, refused otherwise');
})();

console.log(`\n${n} checks passed`);
