# Local fork build notes (Windows, modern Node)

This fork's toolchain (Electron 11 / webpack 4 / node-gyp native modules) predates
current Node/OpenSSL tooling. Building it on a modern Node install (verified on
Node 20.x) needs the workarounds below, none of which are optional.

## Prerequisites

- Visual Studio Build Tools 2022, "Desktop development with C++" workload
  (needed for node-gyp to compile `memoryjs`, `node-keyboard-watcher`,
  `electron-overlay-window`). Install via:
  `winget install Microsoft.VisualStudio.2022.BuildTools`
- `yarn` reachable on PATH as a literal `yarn` command, not just `corepack yarn`.
  `electron-overlay-window`'s own postinstall step shells out to `yarn build-ts`
  and does not know about corepack shimming. If `corepack enable` can't run
  (needs write access to the Node install dir, i.e. admin), drop a `yarn.cmd`
  shim earlier on PATH that forwards to `corepack yarn %*`.

## Install

```sh
GYP_DEFINES="openssl_fips=" yarn install
```

`GYP_DEFINES=openssl_fips=` is required. Electron 11's downloaded gyp headers
(`~/.electron-gyp/11.5.0/include/node/common.gypi`) reference `openssl_fips`
inside a nested `conditions` block; modern node-gyp (10.x, bundled with
Node 20) no longer auto-populates that variable in the `config.gypi` it
generates, so gyp fails with `name 'openssl_fips' is not defined` while
configuring any of the three native modules above. Setting it globally via
`GYP_DEFINES` (gyp's own env-var mechanism, applies to every gyp file
regardless of scope) fixes all three at once — no per-package binding.gyp
edits needed.

If native modules were already installed once with `--ignore-scripts` (skipping
the native build entirely), rebuild them against Electron's own ABI afterward
— **not** `npm rebuild`, which targets the system Node and produces a binary
Electron can't load:

```sh
GYP_DEFINES="openssl_fips=" npx electron-builder install-app-deps
```

## Compile

```sh
NODE_OPTIONS=--openssl-legacy-provider yarn compile
```

webpack 4's MD4-based hashing is incompatible with OpenSSL 3 (Node 17+),
raising `error:0308010C:digital envelope routines::unsupported`. The legacy
provider flag restores MD4 support.

## Running an unpackaged build for verification

No need for a full `electron-builder` installer just to confirm the app
starts:

```sh
node_modules/.bin/electron.cmd dist/main/main.js
```

Verify non-interactively (process list + `%APPDATA%\bettercrewlink\logs\main.log`,
which this fork now writes via `electron-log` — see `src/main/index.ts`)
rather than by screenshotting the window.

## Known remaining gap

`registry-js`'s prebuilt binary install (unrelated to the gyp issue above)
was not independently re-verified beyond the log line reporting it installed
successfully.
