<details><summary>Thinking</summary>

Hmmm...



**Analyzing JSON Decryption Issues**

I’m looking into the complications with JSON parsing and decryption. It seems like if a blob is damaged, it could lead to odd behaviors like exceptions when dealing with invalid JSON. There’s also the aspect of changing passwords — the current password check is important for protecting sessions that might be briefly unlocked. This helps prevent misuse if someone has access to an unlocked desktop app. Overall, keeping these security measures in mind is crucial!Hmmm...

Hmmm...

Hmmm...

Hmmm...

Hmmm...

Hmmm...

Hmmm...

Hmmm...

</details>

## Findings, ranked by expected impact

1. **High: damaged v2 vault can strand a recoverable legacy wallet.** The decrypt-failure path leaves the wallet locked, but its advice to restore from the passphrase is incomplete when migration backups still exist. Concrete state: `walletVault` has a valid verifier but a damaged wallet blob; legacy `wallet`, `walletKeys`, and `walletPassword` remain from migration. `decryptWallet()` returns false before `discardV1Backup()` (context-functions.txt, lines 539–555), so the backups remain, but startup treats the vault as v2 and offers no recovery from them. The new message at `freewallet-desktop.js:4326–4327` should distinguish this state and provide a recovery path rather than imply the passphrase is the only option.

2. **High: password change is gated by session state, not proof of the current password.** The Settings button checks only `ss.wallet` (`settings.html`, patch lines 25–31; `freewallet-desktop.js:4508–4512`). A user who can interact with the unlocked app can change the encryption password without reauthenticating. This chiefly protects against an opportunistic user changing the credential and locking out the wallet owner; it is not a strong funds boundary if that user can view the 12-word passphrase in the same tab. There is also a concrete false-unlocked state: while locked, `autoBtcpay()` temporarily puts the stashed seed in `ss.wallet` (`freewallet-desktop.js:1283–1296`). During that interval the Settings gate passes, and `changeWalletPassword()` can re-encrypt the vault without the current password (`574–579`). Require an explicit authenticated-unlocked state, not merely a non-null session seed; current-password verification would also prevent that credential replacement.

3. **Medium-high: the callback change delays Auto-BTCpay setup, but does not stop an existing stash from paying on the first tick.** The `processURIData` callback is described as a retry, so invoking it after failed authentication would not be a valid dependency; success-only invocation is appropriate. Cancellation now skips the retry, so whether a URI operation is lost depends on whether `processURIData` retains it; that caller’s body is not in the attached context. `initWallet()` still calls `checkUpdateWallet()` immediately while the unlock/migration dialog is open (`freewallet-desktop.js:304–334`). If `btcpayWallet` already exists, the first queue tick can still call `autoBtcpay()` using it (`1243–1255`, `1273–1296`). If no stash exists, the tick falls back to a manual payment dialog; later, the successful unlock callback stashes the wallet but does not itself reprocess the queue (`1073–1095`). Autopay then waits for another update tick, and the manual dialog may remain open.

4. **Medium: lock-icon gate is correct for ordinary v2 wallets, but not all wallet states.** `readVault()` accepts any successfully parsed JSON (`freewallet-desktop.js:505–511`), not a validated v2 vault. A malformed-but-parseable vault therefore makes the icon open the password dialog, although `isValidWalletPassword()` will reject a missing `crypto` field (`854–859`); if intact v1 backups coexist, the icon still offers no backup recovery. A v1-only wallet has `readVault() === null`, so the icon itself does nothing, although startup opens the non-cancelable migration dialog. With no wallet, doing nothing is appropriate; during a normal migration the icon is not a useful recovery route.

5. **Medium: decrypt failure handling is improved, but not fully failure-safe.** For ordinary ciphertext corruption, checking `decryptWallet()` and refusing to report success closes the false-unlock issue (`freewallet-desktop.js:4323–4333`, `4916–4934`). However, `decryptWallet()` parses decrypted keys after setting the session seed and key (`548–550`). If the keys blob decrypts to invalid JSON, `JSON.parse()` throws after partially populating unlocked state rather than returning false. The dialog does not catch that exception. Treat malformed decrypted keys as a failed decrypt and clear partial state.

6. **Low: the six fixes are not covered end-to-end by the wiring tests.** The tests exercise extracted storage functions, not dialogs, `initWallet()`, callbacks, queue processing, or HTML click handlers (`test-wallet-wiring.cjs:5–14, 44–48`). The “short password still unlocks” case directly calls the verifier and decrypt functions; it does not prove the unlock dialog accepts it. The stash test manually writes both stash entries rather than running `dialogEnableBtcpay()`. Thus the harness would miss the callback/first-tick interaction, the Settings gate during Auto-BTCpay’s temporary wallet swap, and the malformed-decrypted-keys partial-unlock case.
