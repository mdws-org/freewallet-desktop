I'll read all four files first.I need the remainder of the diff and the context file.Now let me examine the full patched source for the callers the review hinges on.Let me check a few more call sites before writing the review.## Findings, ranked by impact

### 1. The fix for the Auto-BTCpay stash is defeated by its own reachability change — the disclosure is dead code and the stash is created silently elsewhere

`dialogEnableBtcpay()` (freewallet-desktop.js:4882) gained the disclosure paragraph, but after this patch it is unreachable. Its only caller is `checkBtcpayAuth()` (:1093), which is now only invoked as the success callback of `dialogPassword`/`dialogMigrate` (:322,:325). Both fire only when `ss.wallet` is set, so in `checkBtcpayAuth` the `b==null` branch that opens the dialog can never run — the `a==null && b` branch silently writes `btcpayWallet`/`btcpayKeys` (:1089-1091) with no disclosure.

Worse, there is a third stash site the patch missed: order creation. `html/exchange/order.html:224-227` writes `btcpayWallet` for **any** BTC `give_asset` order — including `autopay=N` — and never writes `btcpayKeys`. Consequences:

- A user who creates a BTC order with an **imported** source address gets `btcpayWallet` stashed but `btcpayKeys` left null. After auto-lock, `autoBtcpay` (:1288-1295) hot-swaps the seed, finds `bk==null`, leaves `FW.WALLET_KEYS={}` — the imported-address order cannot be signed, `tx` is falsy, the match sits in the queue until the 20-block window dies. The "seed and keys on one lifecycle" fix is incomplete: two of three writers were updated.
- The seed is stashed on lock for users who explicitly chose manual payment — no opt-in, no disclosure. `lockWallet`'s comment (:660-663) claiming "the enable dialog says so before the user opts in" is false on both counts.

### 2. Issue #3 only partially closed — `processBtcpayQueue` still stacks a modal on the unlock/migrate dialog

`initWallet` calls `checkUpdateWallet()` (:331) immediately and unconditionally. `checkBtcpayTransactions` → `processBtcpayQueue()` (:1160) runs synchronously whenever `btcpayLastUpdated` is under 5 minutes old. Concrete state: v2 wallet, `btcpayQueue` in localStorage holds a match with `autopay:1`, fresh session so `ss.wallet`/`ss.btcpayWallet` are null. At :1253 `o.autopay && (a||b)` fails, the order falls into the manual branch, `dialogBTCpay(false)` → `dialogCheckLocked` (:4772) → a "Wallet Locked!" modal opens on top of `dialogPassword`/`dialogMigrate`, and repeats every 60 s tick. The password-prompt collision is gone; modal stacking during startup is not.

### 3. Damaged vault + intact v1 backup: the advised recovery path destroys the backup

State: `walletVault` parses and the verifier is intact, but `wallet`/`keys` ciphertext is corrupt; `ls.wallet`/`walletKeys`/`walletPassword` still present (pre-`discardV1Backup`). `decryptWallet` returns false (:545-547) and the dialog tells the user to "restore the wallet from its passphrase" (:4327). But `migrateWalletToV2(enteredPassword)` could rebuild the vault from the v1 blobs — the password is already in hand. `initWallet` only offers `dialogMigrate` when `hasV2` is false (:305,:319-325), so re-migration is never offered; and if the user follows the advice via `resetWallet` (:342), the surviving v1 backup is wiped along with the vault. "Leave locked" is right; "passphrase is your only option" is wrong in exactly the state where the backup exists to help.

### 4. Lock icon gating on `readVault()` misclassifies two states

- `walletVault` present but unparseable → `readVault()`→null (:506-510): locked wallet + dead icon (no error, no dialog), and `initWallet` treats it as no-v2 → `dialogWelcome` → create/restore can overwrite the damaged vault silently (:523).
- V1-only wallet: unreachable in practice since `dialogMigrate` has no Cancel and `closable:false` (:4203-4204) — the forced-migration trap, not the icon gate, is what saves it.
- No wallet: dead icon with an "Unlock Wallet" tooltip (:917-919). Cosmetic.
- During `autoBtcpay`'s hot-swap (:1288), `ss.wallet` is transiently set on a nominally locked wallet: the icon offers "Lock" and `dialogCheckLocked` passes everywhere else during that window, including the new Settings change-password path — `changeWalletPassword` (:574-580) self-supplies `FW.WALLET_ENCKEY`, so the password can be rotated mid-swap without the old password. Marginal, but "ss.wallet set" is not a reliable proxy for "user authenticated."

### 5. Callback semantics change — safe, but note what each change did

Callers passing callbacks: `initWallet` (checkBtcpayAuth) and `processURIData` (:5338). Under the old code the callback fired even after a failed verifier check — for `processURIData` that meant a wrong password re-entered `processURIData` → `dialogCheckLocked` → re-prompt loop. Firing only on success is strictly better; cancel correctly drops the URI action. No caller depended on the broken behavior. `dialogEnableBtcpay`'s `callback` was dead code (no such parameter); removing it is fine — moot, since the dialog is dead anyway (finding 1).

### 6. Change-password without the current password — acceptable gate, wrong reasoning to rely on

`dialogCheckLocked` (settings.html:556-560) is sufficient because an unlocked session already exposes everything stronger: the 12-word passphrase via the same tab (settings.html:24-26) and all signing. Requiring the current password would only deter a walk-up attacker rotating the password — a DoS recoverable via the passphrase — while that same attacker can already exfiltrate the seed. The real weakness is the hot-swap window in finding 4, not the missing prompt.

### 7. Fix-by-fix verdict and test gap

#1 closed (verifier-only unlock, :4323). #2 not closed (disclosure unreachable; order.html undisclosed). #3 partially closed (finding 2). #4 closed. #5 closed mechanically; recovery gap in finding 3. #6 closed.

The harness extracts only storage-level functions; every defect left by this patch lives in dialog bodies and callers it cannot reach. Missing coverage that would have caught real defects: which check each dialog path applies (a re-introduced length check on unlock would pass all 25), callback-only-on-success, `decryptWallet` with intact `wallet` but corrupt `keys` blob (:546-547), and the `readVault`-returns-null-on-garbage state. `order.html`'s stash site is outside the extraction model entirely.
