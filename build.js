/*
 * NW.js builder script (nw-builder 4.x, ESM)
 *
 * Produces native NW.js application bundles for macOS. FreeWallet runs natively
 * on Apple Silicon (arm64) using NW.js 0.92.0 with no source changes, so arm64
 * is built by default. Pass `--all` to also build the Intel (x64) bundle.
 *
 *   node build.js          # builds osx-arm64
 *   node build.js --all    # builds osx-arm64 and osx-x64
 */
import nwbuild from 'nw-builder';
import { cp, rm, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const baseDir = dirname(fileURLToPath(import.meta.url));

// The application version is declared once, in package.json; the bundle's
// Info.plist takes it from there, and the release job checks the tag against it.
const { version: appVersion } = JSON.parse(await readFile(resolve(baseDir, 'package.json'), 'utf8'));

// Staging directory holding exactly the files the app needs at runtime.
// Production dependencies are installed into it by stage() below.
const srcDir = resolve(baseDir, 'build');
const outDir = resolve(baseDir, 'builds');

// Files/directories copied into the packaged app.
const includes = [
  'index.html',
  'uri-schemes.html',
  'package.json',
  'css',
  'html',
  'images',
  'js',
  'misc',
  'hardware',
];

// NW.js runtime version verified to run FreeWallet on Apple Silicon.
const version = '0.92.0';
const flavor = 'normal';

// Build arm64 by default; `--all` also produces the Intel (x64) bundle.
const arches = process.argv.includes('--all') ? ['arm64', 'x64'] : ['arm64'];

async function stage() {
  await rm(srcDir, { recursive: true, force: true });
  await mkdir(srcDir, { recursive: true });
  for (const item of includes) {
    await cp(resolve(baseDir, item), resolve(srcDir, item), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  // The app loads its libraries from node_modules at runtime, so they must be
  // bundled -- but only the runtime ones. Installing into the staging directory
  // with --omit=dev keeps build tooling (nw-builder and its dependencies) out
  // of the shipped application.
  console.log('### Installing production dependencies into staging directory...');
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: srcDir,
    stdio: 'inherit',
  });
}

await stage();

for (const arch of arches) {
  const archOutDir = resolve(outDir, `osx-${arch}`);
  console.log(`### Building FreeWallet for osx-${arch} (NW.js ${version})...`);
  await nwbuild({
    srcDir,
    mode: 'build',
    version,
    flavor,
    platform: 'osx',
    arch,
    outDir: archOutDir,
    glob: false,
    app: {
      name: 'FreeWallet',
      icon: resolve(baseDir, 'images/FreeWallet.icns'),
      LSApplicationCategoryType: 'public.app-category.finance',
      CFBundleIdentifier: 'net.freewallet.desktop',
      CFBundleName: 'FreeWallet',
      CFBundleDisplayName: 'FreeWallet',
      CFBundleSpokenName: 'Free Wallet',
      CFBundleVersion: appVersion,
      CFBundleShortVersionString: appVersion,
      NSHumanReadableCopyright: 'Copyright (c) Jeremy Johnson. MIT License.',
    },
  });
  console.log(`### Done: ${resolve(archOutDir, 'FreeWallet.app')}`);
}

console.log('all done!');
