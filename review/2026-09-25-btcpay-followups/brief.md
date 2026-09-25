# Review: freewallet-desktop, Auto-BTCpay follow-ups (issues #11 and #12)

You are reviewing a small patch to a desktop Bitcoin/Counterparty wallet (NW.js, jQuery, BootstrapDialog; one large script file). Real funds sit behind this code. Answer as a forensic reviewer of funds-handling software: mechanisms and line references, no compliments, do not restate the patch. Rank findings by expected impact. Under 700 words.

Read the listed files. Run nothing. Write nothing. Do not edit any files. Answer in your final message.

## Background

Auto-BTCpay lets the wallet pay matched DEX orders while locked: enabling it copies the seed (`ss.btcpayWallet`) and imported keys (`ss.btcpayKeys`) into sessionStorage. To sign, `autoBtcpay()` copies the stashed seed into `ss.wallet` for the length of the network call `cpBtcpay()` and removes it afterwards ("hot-swap"). The previous patch (#9) already made the completion callback skip that removal when the user unlocked during the swap (`FW.WALLET_ENCKEY` set), required the current password on a password change, and routed `checkBtcpayAuth()` through the launch dialog's callbacks.

Two issues remained:

- #12: every "is the wallet unlocked" gate tested `ss.getItem('wallet')` only, so during the hot-swap the whole interface treated a locked wallet as open (send, sign, view passphrase, change network; and the lock icon showed it open).
- #11: `initWallet()` calls `checkUpdateWallet()` immediately, which reaches `processBtcpayQueue()`; a queued match that needs manual payment opened `dialogBTCpay(false)`, whose first line is `dialogCheckLocked('make a payment')`, so a "Wallet Locked!" notice stacked on top of the launch unlock/migrate dialog, and again every 60 s tick.

## What the patch does

- Adds `isWalletUnlocked()`: `ss.wallet` present AND `FW.WALLET_ENCKEY` set. Used by `dialogCheckLocked`, `dialogViewPrivateKey`, `updateWalletOptions` (lock icon state), `checkAutoLock`, and index.html's lock-icon click handler. The hot-swap itself is unchanged.
- Adds `FW.LAUNCH_DIALOG_OPEN`, set by `initWallet()` before it opens the unlock or migrate dialog and cleared by a hook `afterLaunchDialog` that runs on unlock success, unlock Cancel, or migration success. The hook then runs `checkBtcpayAuth()` and `checkBtcpayTransactions()`. `processBtcpayQueue()` returns before opening the manual-payment dialog while the flag is set; the auto-pay branch (`o.autopay && (a||b)` then `autoBtcpay`) is not held back.
- `test/tools.test.js` puts the three `tools/*.cjs` scripts under `npm test`, which CI runs; before, CI ran only `test/embed-url.test.js`.
- The wiring harness gains two cases: a seed without a derived key is refused by `dialogCheckLocked`; `processBtcpayQueue` holds the manual prompt while the flag is up, still runs `autoBtcpay` for an auto-pay match with a stash, and shows the prompt after the hook.

## Attached

- `diff.patch`: the whole change.
- `context-functions.txt`: the touched functions and their neighbours from the patched `js/freewallet-desktop.js`, with line numbers.
- Full patched sources, if you can read by path: `/Users/bemeadows/Projects/freewallet-desktop/js/freewallet-desktop.js`, `/Users/bemeadows/Projects/freewallet-desktop/index.html`, `/Users/bemeadows/Projects/freewallet-desktop/tools/test-wallet-wiring.cjs`, `/Users/bemeadows/Projects/freewallet-desktop/test/tools.test.js`.

## Questions

1. **Gates.** With `isWalletUnlocked()` in the five places listed, is there a remaining path where a hot-swapped seed is treated as an authenticated session? Name any `ss.getItem('wallet')` or `getWallet()` reader that still decides an action on it, and whether it matters.
2. **Auto-lock during a swap.** `checkAutoLock()` now requires `isWalletUnlocked()`, so it no longer fires during a hot-swap. Is there a state where that keeps a genuinely unlocked wallet from auto-locking, or where the old behaviour (locking mid-swap, removing `ss.wallet` under a signing call) was actually relied upon?
3. **The launch flag.** Construct a state where `FW.LAUNCH_DIALOG_OPEN` stays true after the dialog is gone (so manual prompts never appear), or is false while the dialog is still up. Consider a lock-icon unlock later in the session, `dialogPassword` opened by `processURIData`, and the migrate dialog's failure path.
4. **Ordering in the hook.** The hook runs `checkBtcpayAuth()` then `checkBtcpayTransactions()`. Does the order matter, and can `checkBtcpayTransactions()` at that moment throw or misbehave because network info or the queue is not loaded yet?
5. **Tests.** Does `test/tools.test.js` make the CI gate real (a failing tools script fails `npm test`), and what does the harness still not exercise in this patch?

## Revision after the first replies (same round)

The launch flag `FW.LAUNCH_DIALOG_OPEN` and the hook `afterLaunchDialog` are gone. `processBtcpayQueue()` now asks `isPasswordDialogOpen()`, which reports whether any dialog carrying the `btc-wallet-password` class (unlock, migrate, new wallet, enable Auto-BTCpay, change password) is visible, and holds the manual prompt while one is; the 60 s tick offers the match after the last one closes. `initWallet()` passes `checkBtcpayAuth` directly as the unlock dialog's success and cancel hooks and as the migrate dialog's success hook, as #9 did, with no queue check of its own. `dialogPassphrase()` gained the same locked check as `dialogViewPrivateKey()`. `test/tools.test.js` gives the child a 14-minute timeout. The attached diff and context are the revised ones. Re-answer questions 1, 3 and 4 against this shape.
