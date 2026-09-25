# Runtime pass (2026-09-25, Auto-BTCpay follow-ups)

Same setup as the previous round: the app staged by `node build.js`, packaged with the NW.js SDK flavor under `/tmp`, driven over the DevTools protocol with a throwaway `--user-data-dir`. After the guard was changed from a DOM query to BootstrapDialog's registry, the patched script was copied into the running bundle and the page reloaded, so the last three rows ran on the final code.

| Step | Observed |
|---|---|
| Hot-swap state, by hand | Wallet created and locked from the icon (icon shows locked). The seed put back into `ss.wallet` with `FW.WALLET_ENCKEY` null, which is what `autoBtcpay()` does for a locked wallet, then `updateWalletOptions()`: `isWalletUnlocked()` false, icon still locked, `dialogCheckLocked('send funds')` returns true with "You will need to unlock your wallet before you can send funds", `dialogViewPrivateKey()` and `dialogPassphrase()` show their locked notices, and the lock icon opens "Enter wallet password" rather than locking. |
| Queued manual match, DOM guard (first attempt) | One match with `autopay: 0` in `btcpayQueue`, reload: the unlock dialog and, beside it, an "Error" notice ("... before you can make a payment") already present at launch. Later ticks were held correctly. Cause measured in the app: after `BootstrapDialog.show()` the modal element is absent at 0 and 50 ms and present at 450 ms (Bootstrap appends it after the backdrop fade), while `initWallet()` runs the first queue check synchronously. |
| Guard timing, registry | `dialogPassword(false)` then `isPasswordDialogOpen()` in the same tick: true. After Cancel and the hide transition: false. |
| Queued manual match, registry guard | Reload with the match still queued: only "Enter wallet password" (no notice). A forced `processBtcpayQueue()` while it is up: no new dialog. Cancel, then open the unlock dialog from the lock icon and force a tick: no new dialog. Close it and force a tick: "You will need to unlock your wallet before you can make a payment", the reminder. |

Not covered live: a real `autoBtcpay()` signing call (needs a funded order match), so the hot-swap was reproduced by writing its two effects directly.
