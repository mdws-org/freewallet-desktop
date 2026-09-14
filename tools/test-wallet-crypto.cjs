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

const ITER = 2000; // fast for tests; correctness is iteration-independent
let n = 0;
function ok(name) { n++; console.log('  ok', name); }

// --- round trip -----------------------------------------------------------
(function () {
  const pw = 'correct horse 7';
  const wallet = 'deadbeefcafe0123456789abcdef'; // stand-in HD wallet hex
  const keys = JSON.stringify({ '1abc': 'Kx...priv', '1def': 'L2...priv' });

  const made = WC.makeCrypto(pw, ITER);
  const encWallet = WC.encrypt(wallet, made.encKey);
  const encKeys = WC.encrypt(keys, made.encKey);

  assert.strictEqual(WC.decrypt(encWallet, made.encKey), wallet);
  assert.strictEqual(WC.decrypt(encKeys, made.encKey), keys);
  ok('round-trip wallet + keys');

  // verifier proves the password
  const good = WC.verifyPassword(pw, made.descriptor);
  assert.ok(good, 'correct password verifies');
  assert.strictEqual(WC.decrypt(encWallet, good), wallet);
  ok('verifyPassword returns a working key');

  // wrong password: no verify, and even a forced decrypt yields null
  assert.strictEqual(WC.verifyPassword('wrong 7', made.descriptor), null);
  const wrongKey = WC.deriveKeys('wrong 7', made.descriptor.salt, made.descriptor.iter).encKey;
  assert.strictEqual(WC.decrypt(encWallet, wrongKey), null);
  ok('wrong password rejected, wrong-key decrypt is null');
})();

// --- the stored descriptor leaks nothing decryptable ----------------------
(function () {
  const pw = 'another pass 9';
  const made = WC.makeCrypto(pw, ITER);
  const d = made.descriptor;
  // descriptor must not contain the password or the AES key in any field
  const blob = JSON.stringify(d);
  assert.ok(blob.indexOf(pw) === -1, 'descriptor does not contain password');
  const encKeyHex = made.encKey.toString(C.enc.Hex);
  assert.ok(blob.indexOf(encKeyHex) === -1, 'descriptor does not contain the AES key');
  // verifier is SHA256 of the *second* KDF half; it is not the enc key
  assert.notStrictEqual(d.verifier, encKeyHex);
  ok('descriptor leaks neither password nor encryption key');
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
  function migrate(store, enteredPassword, newPasswordForConvenience) {
    const wasEncrypted = parseInt(store.walletEncrypted) === 1;
    // 1. recover the plaintext from v1
    if (wasEncrypted) {
      // verify the entered password against the legacy oracle before trusting it
      if (!WC.legacyVerify(enteredPassword, store.walletPassword)) return { error: 'bad password' };
    }
    const v1pw = wasEncrypted ? enteredPassword : WC.legacyConveniencePassword(store.walletPassword);
    const wallet = WC.decryptV1(store.wallet, v1pw);
    const keys = WC.decryptV1(store.walletKeys, v1pw);
    if (wallet === null || keys === null) return { error: 'v1 decrypt failed' };

    // 2. the new password: existing one if already encrypted, else user's new one
    const newPw = wasEncrypted ? enteredPassword : newPasswordForConvenience;
    const made = WC.makeCrypto(newPw, ITER);
    const encWallet = WC.encrypt(wallet, made.encKey);
    const encKeys = WC.encrypt(keys, made.encKey);

    // 3. verify the new blobs BEFORE touching the old ones
    if (WC.decrypt(encWallet, made.encKey) !== wallet) return { error: 'verify wallet failed' };
    if (WC.decrypt(encKeys, made.encKey) !== keys) return { error: 'verify keys failed' };

    // 4. back up v1, write v2, drop the cleartext password
    store['wallet.v1bak'] = store.wallet;
    store['walletKeys.v1bak'] = store.walletKeys;
    store['walletPassword.v1bak'] = store.walletPassword;
    store.wallet = encWallet;
    store.walletKeys = encKeys;
    store.walletCrypto = JSON.stringify(made.descriptor);
    store.walletEncrypted = 1;
    delete store.walletPassword;
    return { ok: true, plaintext: { wallet, keys } };
  }

  function unlockV2(store, password) {
    const desc = JSON.parse(store.walletCrypto);
    const key = WC.verifyPassword(password, desc);
    if (!key) return { error: 'bad password' };
    const wallet = WC.decrypt(store.wallet, key);
    const keys = WC.decrypt(store.walletKeys, key);
    // safe to discard backups now that a v2 unlock succeeded
    delete store['wallet.v1bak'];
    delete store['walletKeys.v1bak'];
    delete store['walletPassword.v1bak'];
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
    assert.strictEqual(store.walletPassword, undefined, 'cleartext password removed');
    assert.ok(WC.isV2Blob(store.wallet), 'wallet now v2');
    assert.ok(store['wallet.v1bak'], 'v1 backup retained until next unlock');
    // old password no longer opens it; the new one does
    assert.strictEqual(WC.verifyPassword(cpw, JSON.parse(store.walletCrypto)), null);
    const u = unlockV2(store, 'chosen new pw 5');
    assert.strictEqual(u.wallet, wallet);
    assert.strictEqual(u.keys, keys);
    assert.strictEqual(store['wallet.v1bak'], undefined, 'backup discarded after successful v2 unlock');
    ok('convenience wallet migrated, backup discarded after verified unlock');
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
    assert.ok(store.walletCrypto === undefined, 'failed migrate left wallet untouched');
    const m = migrate(store, upw, null);
    assert.ok(m.ok, 'encrypted migrate ok with correct password');
    const u = unlockV2(store, upw);
    assert.strictEqual(u.wallet, wallet);
    ok('user-encrypted wallet migrated, same password still opens it');
  }

  // Case C: a corrupted new blob would abort BEFORE discarding v1 (safety)
  {
    // simulate by verifying the guard: if verify fails, old blobs stay.
    const store = {
      wallet: C.AES.encrypt('X', 'p9').toString(),
      walletKeys: C.AES.encrypt('{}', 'p9').toString(),
      walletPassword: 'p9', walletEncrypted: 0
    };
    const before = store.wallet;
    // monkeypatch encrypt to corrupt output, proving the guard trips
    const realEncrypt = WC.encrypt;
    WC.encrypt = () => JSON.stringify({ v: 2, iv: '00', ct: 'AAAA' });
    const m = migrate(store, null, 'newpw 1');
    WC.encrypt = realEncrypt;
    assert.ok(m.error, 'corrupted new blob aborts migration');
    assert.strictEqual(store.wallet, before, 'old wallet blob preserved on failed verify');
    assert.strictEqual(store['wallet.v1bak'], undefined, 'no backup written on aborted migration');
    ok('migration aborts and preserves v1 when the new blob fails verification');
  }
})();

console.log(`\n${n} checks passed`);
