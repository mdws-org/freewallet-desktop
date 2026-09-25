# FreeWallet Desktop

FreeWallet is a free wallet for Bitcoin and Counterparty.

## Fork of jdogresorg/freewallet-desktop

This repository continues [jdogresorg/freewallet-desktop](https://github.com/jdogresorg/freewallet-desktop), written by Jeremy Johnson. It is maintained in the [mdws-org](https://github.com/mdws-org) organization and is not affiliated with that project, which did not produce this build and cannot support it.

Forked from upstream commit `fdb7f2f` (2025-07-31).

Changes in this fork:

- A native Apple Silicon build, replacing a build script that targeted Intel only and could not run under current versions of Node.
- Build tooling is no longer copied into the packaged application.
- Continuous integration builds a macOS bundle on every push, then checks its bundle identifier, confirms it excludes build tooling, and confirms that no part of it loads a library from outside the bundle other than the system frameworks.
- Security fixes to the encryption that protects the wallet on disk, and to the escaping of data rendered in the interface. An existing wallet is re-encrypted the first time you unlock it after installing this build, and the previous copy is retained until that unlock succeeds. If the re-encrypted copy is damaged before that first unlock, the wallet is rebuilt from the retained copy.
- A wallet password is required. A new or changed password must have at least 12 characters, including a number. A wallet that already had a password keeps it through the re-encryption, even a shorter one: unlocking checks the password against the stored wallet and applies no other rule. The password can be changed under Settings, on the Wallet tab, and the change asks for the current password.
- Auto-BTCpay keeps a copy of the wallet seed and imported keys in the application's session memory while it is enabled, including while the wallet is locked, until Auto-BTCpay is disabled, the wallet is logged out, or the application is closed. The order form states this where auto-pay is chosen.

Code in this repository is written with AI assistance and reviewed by one maintainer. It has had no independent security audit. The dmg attached to each CI run is build output, not a reviewed release.

This software is provided as is, with no warranty and no support commitment. Back up your passphrase before you install it.

## Install

No release is published yet. CI attaches a dmg to each run on the [Actions tab](https://github.com/mdws-org/freewallet-desktop/actions). Released builds will appear on the [releases page](https://github.com/mdws-org/freewallet-desktop/releases).

These builds carry an ad-hoc signature. They are not signed with an Apple Developer ID and are not notarized, so Gatekeeper refuses to open them.

1. Drag the app to your Applications folder. Do not open it from the mounted disk image. macOS runs a quarantined app from a temporary read-only location, and the wallet can fail to find its data directory.
2. Open the app once and dismiss the warning.
3. Open System Settings, go to Privacy and Security, and scroll to Security.
4. Select Open Anyway, then enter your login password.

The Open Anyway button appears for about an hour after the blocked launch. If it is gone, open the app again to bring it back.

## Build it yourself

Install the dependencies and build the application:

```shell
npm install
node build.js
```

`node build.js` produces an Apple Silicon bundle in `builds/osx-arm64`. `node build.js --all` also produces an Intel bundle, which this repository does not test or publish.

## Report a problem

Open an issue on [this repository](https://github.com/mdws-org/freewallet-desktop/issues). Do not report problems with this fork to the upstream project.

For a security vulnerability, report it privately through [GitHub private vulnerability reporting](https://github.com/mdws-org/freewallet-desktop/security/advisories/new). Do not open a public issue.

## License

FreeWallet is free and open-source software, licensed under MIT. See [LICENSE](LICENSE).

Copyright (c) Jeremy Johnson and FreeWallet contributors.
