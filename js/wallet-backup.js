/*
 * FreeWallet backup file (format "freewallet-backup", v1).
 *
 * A backup is a JSON file:
 *
 *   {"format":"freewallet-backup","v":1,"created":<ISO UTC>,"app":<version>,
 *    "kdf":<WalletCrypto descriptor>,"blob":<WalletCrypto.encrypt() output>}
 *
 * The blob is the JSON of a fixed set of localStorage entries (BACKUP_KEYS),
 * encrypted with WalletCrypto under a key derived from a backup password with a
 * fresh salt. The wallet record inside it (walletVault) is itself still
 * encrypted under the wallet password, so the seed is never written in
 * plaintext: restoring needs the backup password to open the file and the
 * wallet password to unlock the wallet afterwards.
 *
 * The kdf descriptor is covered implicitly: a changed salt or iteration count
 * derives different keys, so the verifier or the MAC rejects the file. The
 * "created" and "app" fields are informational and not authenticated.
 *
 * This module has no DOM dependency so it can be tested under Node; the dialogs
 * and the file save/open calls live in wallet-backup-ui.js.
 */
(function (root, factory) {
  var WC = (typeof require === 'function' && typeof module === 'object')
    ? require('./wallet-crypto.js') : root.WalletCrypto;
  var mod = factory(WC);
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.WalletBackup = mod;
  }
})(typeof self !== 'undefined' ? self : this, function (WalletCrypto) {
  'use strict';

  var FORMAT = 'freewallet-backup';
  var VERSION = 1;
  var MAX_FILE_BYTES = 5 * 1024 * 1024;

  // The localStorage entries a backup carries, and the only ones an import
  // will write. Caches the app refetches (balances, history, network info),
  // agreement flags, server and donation settings, and the Auto-BTCpay order
  // state are left out on purpose.
  var BACKUP_KEYS = [
    'walletVault',            // encrypted seed + imported keys + KDF descriptor
    'walletEncrypted',        // flag written beside the vault
    'walletFormat',           // 0 = Counterwallet words, 1 = BIP39
    'walletNetwork',          // 1 = mainnet, 2 = testnet
    'walletAddresses',        // address list: derivation index, type, label, imported addresses
    'walletAddress',          // selected address
    'walletAddressLabel',     // label of the selected address
    'walletBalanceOptions',   // balance list filters
    'walletMarkets',          // pinned markets
    'walletMarketOptions',    // market list filters
    'walletDispensers',       // pinned dispensers
    'walletDispenserOptions', // dispenser list filters
    'walletAutoLock',         // auto-lock minutes
    'feeMinimum',             // minimum transaction fee
    'unconfirmedUtxos',       // spend unconfirmed UTXOs or not
    'dustSizeRegular',        // custom dust output size
    'dustSizeMultisig'        // custom multisig dust output size
  ];

  // Entries that belong to the wallet currently on this device. An import
  // removes all of them before writing the backup's entries, so nothing of the
  // replaced wallet (legacy blobs, cached balances, pending Auto-BTCpay state)
  // is left mixed with the restored one. Mirrors resetWallet() in
  // freewallet-desktop.js.
  var WALLET_SCOPED_KEYS = [
    'walletVault', 'wallet', 'walletKeys', 'walletPassword', 'walletCrypto',
    'wallet.v1bak', 'walletKeys.v1bak', 'walletPassword.v1bak',
    'walletEncrypted', 'walletAddress', 'walletAddresses', 'walletAddressLabel',
    'walletBalances', 'walletBalanceOptions', 'walletFormat', 'walletHistory',
    'walletNetwork', 'walletMarkets', 'walletMarketOptions', 'walletDispensers',
    'walletDispenserOptions', 'btcpayOrders', 'btcpayMatches', 'btcpayQueue'
  ];

  // Entries whose value is JSON in localStorage.
  var JSON_KEYS = ['walletAddresses', 'walletBalanceOptions', 'walletMarkets',
    'walletMarketOptions', 'walletDispensers', 'walletDispenserOptions',
    'dustSizeRegular', 'dustSizeMultisig'];

  var HEADER_FIELDS = ['format', 'v', 'created', 'app', 'kdf', 'blob'];

  function fail(code, message) {
    return { ok: false, error: code, message: message };
  }

  function isPlainObject(o) {
    return !!o && typeof o === 'object' && !Array.isArray(o);
  }

  function has(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  // Read the backup's entries from a storage object (anything with getItem).
  function collect(storage) {
    var entries = {};
    BACKUP_KEYS.forEach(function (k) {
      var v = storage.getItem(k);
      if (v !== null && v !== undefined) entries[k] = String(v);
    });
    return entries;
  }

  // Check a set of entries against the allowlist and the shapes the app reads.
  // Returns an error message, or null when the entries are acceptable.
  function validateEntries(entries) {
    if (!isPlainObject(entries)) return 'The backup contents are not a set of entries';
    var keys = Object.keys(entries);
    for (var i = 0; i < keys.length; i++) {
      if (BACKUP_KEYS.indexOf(keys[i]) === -1) return 'The backup contains an entry this version does not accept: ' + keys[i];
      if (typeof entries[keys[i]] !== 'string') return 'The backup entry ' + keys[i] + ' is not text';
    }
    if (!has(entries, 'walletVault')) return 'The backup contains no wallet';
    var vault;
    try { vault = JSON.parse(entries.walletVault); } catch (e) { return 'The wallet record in the backup cannot be read'; }
    if (!isPlainObject(vault) || vault.v !== 2 || !WalletCrypto.validParams(vault.crypto) ||
        !WalletCrypto.isV2Blob(vault.wallet) || (vault.keys !== undefined && !WalletCrypto.isV2Blob(vault.keys)))
      return 'The wallet record in the backup is not a valid encrypted wallet';
    if (has(entries, 'walletEncrypted') && entries.walletEncrypted !== '1') return 'The backup entry walletEncrypted is not valid';
    if (has(entries, 'walletFormat') && !/^[01]$/.test(entries.walletFormat)) return 'The backup entry walletFormat is not valid';
    if (has(entries, 'walletNetwork') && !/^[12]$/.test(entries.walletNetwork)) return 'The backup entry walletNetwork is not valid';
    for (var j = 0; j < JSON_KEYS.length; j++) {
      var k = JSON_KEYS[j];
      if (!has(entries, k)) continue;
      try { JSON.parse(entries[k]); } catch (e) { return 'The backup entry ' + k + ' cannot be read'; }
    }
    if (has(entries, 'walletAddresses') && !Array.isArray(JSON.parse(entries.walletAddresses)))
      return 'The backup entry walletAddresses is not a list';
    return null;
  }

  // Build the backup file text. A new salt is drawn on every call (makeCrypto),
  // so two exports with the same password share no key material.
  function create(entries, password, opts) {
    opts = opts || {};
    if (typeof password !== 'string' || !password) throw new Error('create requires a backup password');
    var err = validateEntries(entries);
    if (err) throw new Error(err);
    var mk = WalletCrypto.makeCrypto(password);
    var file = {
      format: FORMAT,
      v: VERSION,
      created: (opts.now || new Date()).toISOString(),
      app: String(opts.app || ''),
      kdf: mk.descriptor,
      blob: WalletCrypto.encrypt(JSON.stringify(entries), mk.keyset)
    };
    return JSON.stringify(file, null, 2) + '\n';
  }

  // Parse and check the unauthenticated envelope. Needs no password, so a file
  // that is not a backup is refused before any key derivation.
  function readHeader(text) {
    if (typeof text !== 'string' || text.length > MAX_FILE_BYTES) return fail('format', 'This file is not a FreeWallet backup');
    var o;
    try { o = JSON.parse(text); } catch (e) { return fail('format', 'This file is not a FreeWallet backup'); }
    if (!isPlainObject(o) || o.format !== FORMAT) return fail('format', 'This file is not a FreeWallet backup');
    if (o.v !== VERSION) return fail('version', 'This backup was made by a newer or unknown version of FreeWallet (backup format ' + String(o.v) + ')');
    var extra = Object.keys(o).filter(function (k) { return HEADER_FIELDS.indexOf(k) === -1; });
    if (extra.length) return fail('format', 'This backup file has fields this version does not accept: ' + extra.join(', '));
    if (typeof o.blob !== 'string' || !WalletCrypto.isV2Blob(o.blob)) return fail('format', 'This backup file has no encrypted contents');
    if (!isPlainObject(o.kdf) || o.kdf.kdf !== 'pbkdf2-sha256' || !WalletCrypto.validParams(o.kdf))
      return fail('format', 'This backup file has invalid key derivation settings');
    if ((o.created !== undefined && typeof o.created !== 'string') || (o.app !== undefined && typeof o.app !== 'string'))
      return fail('format', 'This backup file has an invalid header');
    return { ok: true, header: o };
  }

  // Open a backup: envelope checks, then the password (verifier), then the MAC
  // (inside WalletCrypto.decrypt, before any decryption), then the allowlist and
  // entry shapes. Returns {ok:true, entries, created, app} or {ok:false, error,
  // message}; nothing is written anywhere.
  function open(text, password) {
    var h = readHeader(text);
    if (!h.ok) return h;
    var o = h.header;
    var keyset = WalletCrypto.verifyPassword(String(password || ''), o.kdf);
    if (!keyset) return fail('password', 'The backup password is not correct');
    var plain = WalletCrypto.decrypt(o.blob, keyset);
    if (plain === null) return fail('tampered', 'The backup file has been altered or damaged and cannot be opened');
    var entries;
    try { entries = JSON.parse(plain); } catch (e) { return fail('tampered', 'The backup contents cannot be read'); }
    var err = validateEntries(entries);
    if (err) return fail('keys', err);
    return { ok: true, entries: entries, created: o.created || '', app: o.app || '' };
  }

  // Entries currently in storage that an import of `entries` would remove or
  // overwrite.
  function replacedKeys(storage, entries) {
    var touched = WALLET_SCOPED_KEYS.concat(Object.keys(entries || {}));
    return touched.filter(function (k, i) {
      return touched.indexOf(k) === i && storage.getItem(k) !== null;
    });
  }

  // Whether storage holds a wallet (current or legacy layout).
  function hasWallet(storage) {
    return storage.getItem('walletVault') !== null || storage.getItem('wallet') !== null;
  }

  // Replace the device's wallet entries with the backup's. Entries are
  // re-validated here so no caller can write outside the allowlist. If any
  // write throws (quota), every touched entry is put back as it was.
  function apply(storage, entries) {
    var err = validateEntries(entries);
    if (err) throw new Error(err);
    var touched = WALLET_SCOPED_KEYS.concat(Object.keys(entries));
    var before = {};
    touched.forEach(function (k) { before[k] = storage.getItem(k); });
    try {
      WALLET_SCOPED_KEYS.forEach(function (k) { storage.removeItem(k); });
      Object.keys(entries).forEach(function (k) { storage.setItem(k, entries[k]); });
    } catch (e) {
      Object.keys(before).forEach(function (k) {
        try {
          if (before[k] === null) storage.removeItem(k); else storage.setItem(k, before[k]);
        } catch (e2) { /* best effort: the original error is rethrown below */ }
      });
      throw e;
    }
  }

  // Suggested file name: freewallet-backup-YYYY-MM-DD.json (UTC date).
  function fileName(now) {
    return 'freewallet-backup-' + (now || new Date()).toISOString().slice(0, 10) + '.json';
  }

  return {
    FORMAT: FORMAT,
    VERSION: VERSION,
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    BACKUP_KEYS: BACKUP_KEYS.slice(),
    WALLET_SCOPED_KEYS: WALLET_SCOPED_KEYS.slice(),
    collect: collect,
    validateEntries: validateEntries,
    create: create,
    readHeader: readHeader,
    open: open,
    replacedKeys: replacedKeys,
    hasWallet: hasWallet,
    apply: apply,
    fileName: fileName
  };
});
