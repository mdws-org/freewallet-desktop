#!/usr/bin/env node
/*
 * Validator for js/wallet-crypto.js (format v2) and the v1->v2 migration.
 * Run: node tools/test-wallet-crypto.js
 * Uses a reduced iteration count for speed; production uses WC.PBKDF2_ITERATIONS.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('crypto-js');
// Load the UMD source into a CommonJS context so the test exercises the exact
// file the app ships (package.json is type:module, so a plain require of the
// .js file is treated as ESM and rejected).
const WC = (function () {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'wallet-crypto.js'), 'utf8');
  const m = { exports: {} };
  new Function('module', 'exports', 'require', src)(m, m.exports, require);
  return m.exports;
})();

const ITER = 50000; // the minimum the production validator accepts; correctness is iteration-independent
let n = 0;
function ok(name) { n++; console.log('  ok', name); }

// --- round trip -----------------------------------------------------------
(function () {
  const pw = 'correct horse 7';
  const wallet = 'deadbeefcafe0123456789abcdef'; // stand-in HD wallet hex
  const keys = JSON.stringify({ '1abc': 'Kx...priv', '1def': 'L2...priv' });

  const made = WC.makeCrypto(pw, ITER);
  const encWallet = WC.encrypt(wallet, made.keyset);
  const encKeys = WC.encrypt(keys, made.keyset);

  assert.strictEqual(WC.decrypt(encWallet, made.keyset), wallet);
  assert.strictEqual(WC.decrypt(encKeys, made.keyset), keys);
  ok('round-trip wallet + keys');

  // verifier proves the password
  const good = WC.verifyPassword(pw, made.descriptor);
  assert.ok(good && good.enc && good.mac, 'correct password verifies to a keyset');
  assert.strictEqual(WC.decrypt(encWallet, good), wallet);
  ok('verifyPassword returns a working keyset');

  // wrong password: no verify, and a forced decrypt with a wrong keyset is null
  assert.strictEqual(WC.verifyPassword('wrong 7', made.descriptor), null);
  const wrong = WC.deriveKeys('wrong 7', made.descriptor.salt, made.descriptor.iter);
  assert.strictEqual(WC.decrypt(encWallet, { enc: wrong.enc, mac: wrong.mac }), null);
  ok('wrong password rejected, wrong-keyset decrypt is null');

  // authentication: a tampered ciphertext or IV is rejected by the MAC
  const blob = JSON.parse(encWallet);
  const flip = (s) => s.slice(0, -2) + (s.slice(-2) === 'AA' ? 'AB' : 'AA');
  assert.strictEqual(WC.decrypt(JSON.stringify({ ...blob, ct: flip(blob.ct) }), made.keyset), null);
  assert.strictEqual(WC.decrypt(JSON.stringify({ ...blob, mac: flip(blob.mac) }), made.keyset), null);
  // a valid enc key but a wrong mac key must still be rejected before decrypt
  assert.strictEqual(WC.decrypt(encWallet, { enc: made.keyset.enc, mac: wrong.mac }), null);
  ok('tampered ct / tampered mac / wrong mac-key all rejected (encrypt-then-MAC)');
})();

// --- the stored descriptor leaks nothing decryptable ----------------------
(function () {
  const pw = 'another pass 9';
  const made = WC.makeCrypto(pw, ITER);
  const d = made.descriptor;
  // descriptor must not contain the password or the AES key in any field
  const blob = JSON.stringify(d);
  assert.ok(blob.indexOf(pw) === -1, 'descriptor does not contain password');
  const encKeyHex = made.keyset.enc.toString(C.enc.Hex);
  const macKeyHex = made.keyset.mac.toString(C.enc.Hex);
  assert.ok(blob.indexOf(encKeyHex) === -1, 'descriptor does not contain the AES key');
  assert.ok(blob.indexOf(macKeyHex) === -1, 'descriptor does not contain the MAC key');
  // verifier is SHA256 of the *third* KDF segment; it is neither key
  assert.notStrictEqual(d.verifier, encKeyHex);
  assert.notStrictEqual(d.verifier, macKeyHex);
  ok('descriptor leaks neither password nor either key');

  // read-path parameters are range-checked: a hostile blob cannot force an
  // unbounded PBKDF2 stall, and malformed params are a clean reject, not a throw
  const base = WC.makeCrypto('bounds pw 3', ITER).descriptor;
  assert.strictEqual(WC.verifyPassword('bounds pw 3', { ...base, iter: 1e12 }), null, 'absurd iter rejected');
  assert.strictEqual(WC.verifyPassword('bounds pw 3', { ...base, iter: -1 }), null, 'negative iter rejected');
  assert.strictEqual(WC.verifyPassword('bounds pw 3', { ...base, iter: 3.5 }), null, 'non-integer iter rejected');
  assert.strictEqual(WC.verifyPassword('bounds pw 3', { ...base, salt: 'zz' }), null, 'malformed salt rejected');
  assert.strictEqual(WC.verifyPassword('bounds pw 3', { ...base, v: 1 }), null, 'wrong version rejected');
  ok('malicious/malformed KDF params rejected without deriving');
})();

// --- legacy v1 formats decrypt (what migration reads) ---------------------
(function () {
  // convenience wallet: password stored cleartext, walletEncrypted=0
  const cpw = C.lib.WordArray.random(8).toString(C.enc.Base64).substring(3);
  const wallet = 'aaaabbbbccccdddd';
  const encWalletV1 = C.AES.encrypt(wallet, String(cpw)).toString();
  assert.strictEqual(WC.legacyConveniencePassword(cpw), cpw, 'convenience: cleartext password used as-is');
  assert.strictEqual(WC.decryptV1(encWalletV1, cpw), wallet);
  ok('legacy convenience wallet decrypts');

  // user-encrypted wallet: walletPassword = AES(password, password), encrypted=1.
  // The password is not recoverable from disk; the user types it and we verify.
  const upw = 'my real password 3';
  const storedPw = C.AES.encrypt(upw, String(upw)).toString();
  assert.strictEqual(WC.legacyVerify(upw, storedPw), true, 'correct entered password verifies against legacy oracle');
  assert.strictEqual(WC.legacyVerify('nope 1', storedPw), false, 'wrong entered password rejected');
  const encWalletV1b = C.AES.encrypt(wallet, String(upw)).toString();
  assert.strictEqual(WC.decryptV1(encWalletV1b, upw), wallet);
  ok('legacy user-encrypted wallet: entered password verified and decrypts');
})();

// --- full migrate-on-unlock with backup/verify/discard --------------------
// Simulate localStorage as a plain object and run the migration algorithm the
// app will use, asserting the safety property: the old blob is only discarded
// after the new one is verified to decrypt back to the identical plaintext.
(function () {
  // Mirrors the app: migration writes ONE atomic walletVault record and leaves
  // the legacy v1 keys (wallet/walletKeys/walletPassword) in place as the backup;
  // a successful v2 unlock removes them.
  function migrate(store, enteredPassword, newPasswordForConvenience) {
    const wasEncrypted = parseInt(store.walletEncrypted) === 1;
    if (wasEncrypted) {
      if (!WC.legacyVerify(enteredPassword, store.walletPassword)) return { error: 'bad password' };
    }
    const v1pw = wasEncrypted ? enteredPassword : WC.legacyConveniencePassword(store.walletPassword);
    const wallet = WC.decryptV1(store.wallet, v1pw);
    const keys = WC.decryptV1(store.walletKeys, v1pw);
    if (wallet === null || keys === null) return { error: 'v1 decrypt failed' };

    const newPw = wasEncrypted ? enteredPassword : newPasswordForConvenience;
    const made = WC.makeCrypto(newPw, ITER);
    const encWallet = WC.encrypt(wallet, made.keyset);
    const encKeys = WC.encrypt(keys, made.keyset);
    // verify the new blobs BEFORE writing anything
    if (WC.decrypt(encWallet, made.keyset) !== wallet) return { error: 'verify wallet failed' };
    if (WC.decrypt(encKeys, made.keyset) !== keys) return { error: 'verify keys failed' };

    // one atomic write; legacy keys untouched (the backup)
    store.walletVault = JSON.stringify({ v: 2, crypto: made.descriptor, wallet: encWallet, keys: encKeys });
    return { ok: true, plaintext: { wallet, keys } };
  }

  function unlockV2(store, password) {
    const v = JSON.parse(store.walletVault);
    const key = WC.verifyPassword(password, v.crypto);
    if (!key) return { error: 'bad password' };
    const wallet = WC.decrypt(v.wallet, key);
    const keys = WC.decrypt(v.keys, key);
    if (wallet === null || keys === null) return { error: 'vault decrypt failed' };
    // safe to discard the legacy backup now that a v2 unlock succeeded
    delete store.wallet; delete store.walletKeys; delete store.walletPassword;
    return { ok: true, wallet, keys };
  }

  // Case A: convenience wallet -> user sets a new password on first unlock
  {
    const cpw = 'conv-generated-xyz';
    const wallet = 'HDWALLETHEX-A';
    const keys = JSON.stringify({ '1a': 'privA' });
    const store = {
      wallet: C.AES.encrypt(wallet, cpw).toString(),
      walletKeys: C.AES.encrypt(keys, cpw).toString(),
      walletPassword: cpw,           // cleartext == the vulnerability
      walletEncrypted: 0
    };
    const m = migrate(store, null, 'chosen new pw 5');
    assert.ok(m.ok, 'convenience migrate ok');
    assert.ok(WC.isV2Blob(JSON.parse(store.walletVault).wallet), 'vault holds a v2 blob');
    assert.ok(store.wallet && store.walletPassword, 'legacy backup retained until next unlock');
    // old password no longer opens the vault; the new one does
    assert.strictEqual(WC.verifyPassword(cpw, JSON.parse(store.walletVault).crypto), null);
    const u = unlockV2(store, 'chosen new pw 5');
    assert.strictEqual(u.wallet, wallet);
    assert.strictEqual(u.keys, keys);
    assert.strictEqual(store.wallet, undefined, 'legacy backup discarded after successful v2 unlock');
    assert.strictEqual(store.walletPassword, undefined, 'cleartext password gone after unlock');
    ok('convenience wallet migrated (atomic vault), backup discarded after verified unlock');
  }

  // Case B: already user-encrypted wallet keeps its password
  {
    const upw = 'existing pw 8';
    const wallet = 'HDWALLETHEX-B';
    const keys = JSON.stringify({ '1b': 'privB' });
    const store = {
      wallet: C.AES.encrypt(wallet, upw).toString(),
      walletKeys: C.AES.encrypt(keys, upw).toString(),
      walletPassword: C.AES.encrypt(upw, upw).toString(),
      walletEncrypted: 1
    };
    assert.deepStrictEqual(migrate(store, 'WRONG', null), { error: 'bad password' });
    assert.strictEqual(store.walletVault, undefined, 'failed migrate wrote no vault');
    const m = migrate(store, upw, null);
    assert.ok(m.ok, 'encrypted migrate ok with correct password');
    const u = unlockV2(store, upw);
    assert.strictEqual(u.wallet, wallet);
    ok('user-encrypted wallet migrated (atomic vault), same password still opens it');
  }

  // Case C: a corrupted new blob aborts BEFORE any vault is written (safety)
  {
    const store = {
      wallet: C.AES.encrypt('X', 'p9').toString(),
      walletKeys: C.AES.encrypt('{}', 'p9').toString(),
      walletPassword: 'p9', walletEncrypted: 0
    };
    const before = store.wallet;
    const realEncrypt = WC.encrypt;
    WC.encrypt = () => JSON.stringify({ v: 2, iv: '00', ct: 'AAAA', mac: '00' });
    const m = migrate(store, null, 'newpw 1');
    WC.encrypt = realEncrypt;
    assert.ok(m.error, 'corrupted new blob aborts migration');
    assert.strictEqual(store.wallet, before, 'legacy wallet blob preserved on failed verify');
    assert.strictEqual(store.walletVault, undefined, 'no vault written on aborted migration');
    ok('migration aborts and preserves v1 when the new blob fails verification');
  }

  // Case D: atomicity -- the whole vault is one record, so a change to the
  // password can never leave the descriptor and ciphertext out of sync.
  {
    const wallet = 'HDWALLETHEX-D';
    const made = WC.makeCrypto('first pw 1', ITER);
    let store = { walletVault: JSON.stringify({ v: 2, crypto: made.descriptor,
      wallet: WC.encrypt(wallet, made.keyset), keys: WC.encrypt('{}', made.keyset) }) };
    // change password = build a brand-new vault object and assign in one step
    const mk2 = WC.makeCrypto('second pw 2', ITER);
    const newVault = JSON.stringify({ v: 2, crypto: mk2.descriptor,
      wallet: WC.encrypt(wallet, mk2.keyset), keys: WC.encrypt('{}', mk2.keyset) });
    store.walletVault = newVault; // single assignment == atomic setItem
    const parsed = JSON.parse(store.walletVault);
    // descriptor and ciphertext are from the same key: new password verifies AND decrypts
    const key = WC.verifyPassword('second pw 2', parsed.crypto);
    assert.ok(key, 'new password verifies against the record it was written with');
    assert.strictEqual(WC.decrypt(parsed.wallet, key), wallet, 'and decrypts the ciphertext in the same record');
    assert.strictEqual(WC.verifyPassword('first pw 1', parsed.crypto), null, 'old password no longer verifies');
    ok('password change is a single atomic record: descriptor and ciphertext never drift');
  }
})();

console.log(`\n${n} checks passed`);
