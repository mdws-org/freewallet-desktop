/*
 * FreeWallet at-rest encryption (format v2).
 *
 * Replaces the original scheme, in which a wallet was encrypted with
 * CryptoJS.AES.encrypt(data, passphrase) -- OpenSSL "Salted__" with a single
 * round of MD5 -- and the passphrase itself was written to localStorage next to
 * the ciphertext (as AES(password, password) when a user password was set, or
 * in cleartext for the default no-password wallet). Anyone with read access to
 * localStorage could recover the password offline with no work factor.
 *
 * v2 derives an AES key from the user's password with PBKDF2-SHA256 and a
 * per-wallet random salt, encrypts with AES-CBC under that derived key and a
 * random IV, and stores only a verifier that proves a password without storing
 * it or anything decryptable back into it.
 *
 * Key derivation produces 512 bits: the first 256 are the AES key (never
 * stored), the second 256 are hashed with SHA-256 to form the stored verifier.
 * The two halves are independent outputs of the KDF, so the verifier reveals
 * nothing about the encryption key beyond what brute-forcing the password would.
 *
 * Iterations are stored per wallet (walletCrypto.iter) so the work factor can be
 * raised on a later re-encryption without locking out existing wallets. The
 * default is a compromise: pure-JS PBKDF2 cannot reach OWASP's 600k for SHA-256
 * without an unlock time that runs to many seconds on ordinary hardware. See
 * PBKDF2_ITERATIONS.
 */
(function (root, factory) {
  var C = (typeof require === 'function') ? require('crypto-js') : root.CryptoJS;
  var mod = factory(C);
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.WalletCrypto = mod;
  }
})(typeof self !== 'undefined' ? self : this, function (CryptoJS) {
  'use strict';

  // Measured pure-JS crypto-js PBKDF2-SHA256 cost (Apple Silicon, Node): ~1.6s
  // at 310k, ~3.2s at 600k, and 2-4x slower again inside NW.js on slower client
  // hardware. 310k keeps a cold unlock near a second on fast machines and a few
  // seconds on slow ones, while being ~5 orders of magnitude more expensive per
  // guess than the single MD5 round it replaces. Stored per wallet so it can be
  // raised later; a hardware-native WebCrypto path at 600k is future work.
  var PBKDF2_ITERATIONS = 310000;
  var SALT_BYTES = 16;
  var IV_BYTES = 16;
  var KDF_BITS = 512; // 256-bit AES key || 256-bit verifier source

  function randomHex(bytes) {
    return CryptoJS.lib.WordArray.random(bytes).toString(CryptoJS.enc.Hex);
  }

  // Derive the AES key and the verifier from a password and stored KDF params.
  // Returns WordArrays plus the hex verifier. The password never leaves here.
  function deriveKeys(password, saltHex, iterations) {
    var salt = CryptoJS.enc.Hex.parse(saltHex);
    var dk = CryptoJS.PBKDF2(password, salt, {
      keySize: KDF_BITS / 32,
      iterations: iterations,
      hasher: CryptoJS.algo.SHA256
    });
    var words = dk.words;
    var encKey = CryptoJS.lib.WordArray.create(words.slice(0, 8));      // first 256 bits
    var verifierSrc = CryptoJS.lib.WordArray.create(words.slice(8, 16)); // second 256 bits
    var verifier = CryptoJS.SHA256(verifierSrc).toString(CryptoJS.enc.Hex);
    return { encKey: encKey, verifier: verifier };
  }

  // Build a fresh KDF descriptor for a new password. Returns the descriptor to
  // store (walletCrypto) and the live encryption key to use this session.
  function makeCrypto(password, iterations) {
    var iter = iterations || PBKDF2_ITERATIONS;
    var saltHex = randomHex(SALT_BYTES);
    var d = deriveKeys(password, saltHex, iter);
    return {
      descriptor: { v: 2, kdf: 'pbkdf2-sha256', iter: iter, salt: saltHex, verifier: d.verifier },
      encKey: d.encKey
    };
  }

  // Constant-time-ish comparison of two equal-length hex strings.
  function hexEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  // Check a password against a stored walletCrypto descriptor. On success returns
  // the live encryption key; on failure returns null. No throw, no oracle.
  function verifyPassword(password, descriptor) {
    if (!descriptor || descriptor.v !== 2) return null;
    var d = deriveKeys(password, descriptor.salt, descriptor.iter);
    return hexEqual(d.verifier, descriptor.verifier) ? d.encKey : null;
  }

  // Encrypt a UTF-8 string under a derived key. Returns a self-describing blob.
  function encrypt(plaintext, encKey) {
    var iv = CryptoJS.lib.WordArray.random(IV_BYTES);
    var ct = CryptoJS.AES.encrypt(plaintext, encKey, {
      iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7
    });
    return JSON.stringify({ v: 2, iv: iv.toString(CryptoJS.enc.Hex), ct: ct.ciphertext.toString(CryptoJS.enc.Base64) });
  }

  // Decrypt a v2 blob. Returns the UTF-8 string, or null if the key is wrong or
  // the blob is malformed (wrong key surfaces as an empty/garbage decrypt).
  function decrypt(blob, encKey) {
    try {
      var o = (typeof blob === 'string') ? JSON.parse(blob) : blob;
      if (!o || o.v !== 2 || !o.iv || !o.ct) return null;
      var params = CryptoJS.lib.CipherParams.create({
        ciphertext: CryptoJS.enc.Base64.parse(o.ct)
      });
      var pt = CryptoJS.AES.decrypt(params, encKey, {
        iv: CryptoJS.enc.Hex.parse(o.iv), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7
      });
      var s = pt.toString(CryptoJS.enc.Utf8);
      return s.length ? s : null;
    } catch (e) {
      return null;
    }
  }

  function isV2Blob(blob) {
    if (typeof blob !== 'string') return false;
    if (blob.charAt(0) !== '{') return false;
    try { var o = JSON.parse(blob); return o && o.v === 2 && !!o.iv && !!o.ct; } catch (e) { return false; }
  }

  // --- v1 (legacy) read path, used only during migration -------------------

  // Decrypt a legacy CryptoJS.AES.encrypt(data, passphrase) string.
  function decryptV1(cipher, password) {
    try {
      var pt = CryptoJS.AES.decrypt(cipher, String(password)).toString(CryptoJS.enc.Utf8);
      return pt.length ? pt : null;
    } catch (e) {
      return null;
    }
  }

  // A convenience wallet (walletEncrypted=0) stored its auto-generated password
  // in cleartext, so migration can read it directly with no user prompt.
  function legacyConveniencePassword(storedWalletPassword) {
    return storedWalletPassword;
  }

  // A user-encrypted wallet (walletEncrypted=1) stored AES(password, password)
  // and nothing that recovers the password on its own -- the user must type it.
  // This mirrors the original isValidWalletPassword: decrypt the stored blob
  // with the candidate and check that it round-trips to the candidate.
  function legacyVerify(candidate, storedWalletPassword) {
    return decryptV1(storedWalletPassword, candidate) === candidate;
  }

  return {
    PBKDF2_ITERATIONS: PBKDF2_ITERATIONS,
    deriveKeys: deriveKeys,
    makeCrypto: makeCrypto,
    verifyPassword: verifyPassword,
    encrypt: encrypt,
    decrypt: decrypt,
    isV2Blob: isV2Blob,
    decryptV1: decryptV1,
    legacyConveniencePassword: legacyConveniencePassword,
    legacyVerify: legacyVerify,
    hexEqual: hexEqual
  };
});
