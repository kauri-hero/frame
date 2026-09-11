# Frame Fork

This is an unofficial community fork of [Frame](https://github.com/floating/frame). It is not affiliated with Frame Labs. Official Frame remains the upstream project.

The fork can sit next to an official Frame install. It uses a separate app id (`sh.frame.fork`) and a separate userData directory (`frame-fork` under the OS application-data folder — on Windows that is `%APPDATA%\frame-fork`). Official Frame settings, accounts, and keys are not reused.

Only one of the two apps can listen on the local JSON-RPC port at a time. Both use `ws://127.0.0.1:1248` and `http://127.0.0.1:1248`. Quit one before launching the other.

## What this fork adds

- **Separate identity.** Packaged and unpackaged builds identify as Frame Fork and write to `frame-fork` userData.
- **Updater off.** The fork does not start Frame’s auto-updater, so it will not download or install official Frame releases over this build.
- **Public RPC preset.** Settings can expose a public RPC connection type in addition to Pylon. Public endpoints are operated by third parties; they see the client IP and request data.
- **Pylon RPC toggle.** Pylon remains the default RPC preset. It can be turned off in Settings if those endpoints are unreachable.
- **CMC Price API.** Optional [CoinMarketCap](https://coinmarketcap.com/api/documentation/guides/get-latest-crypto-prices) quotes when upstream Pylon USD rates are stale. This is off until you opt in.

## Versioning

Community builds keep the upstream Frame `x.y.z` they were forked from. The `-ce.N` pre-release label is this fork’s increment (`ce` = community edition).

The first community cut on a given upstream is `-ce.1`. Later community-only changes on the same upstream bump `N`. After merging a newer upstream Frame, take that new `x.y.z` and start `-ce.1` again.

This avoids occupying official Frame’s next number — do not ship `0.7.0` as if it were upstream. Under semver, `0.6.11-ce.1` sorts older than a future official `0.6.12` or `0.7.0`, which is intended.

## CoinMarketCap prices

Settings → **CMC Price API**:

- **On, with a key:** CoinMarketCap is the USD price feed. Pylon rate subscriptions stay unused.
- **Off:** the saved key is left in place and Pylon rates are used again.
- **On, no key:** the price feed stays off until you add a key.

Bring your own key. Nothing is bundled. Create a CoinMarketCap API account and use the v3 quotes endpoint documented here:

- [Latest crypto prices](https://coinmarketcap.com/api/documentation/guides/get-latest-crypto-prices)
- [Cryptocurrency API reference](https://coinmarketcap.com/api/documentation/pro-api-reference/cryptocurrency)

Keys can come from:

1. **Settings** — entered in the dashboard and encrypted at rest with Electron `safeStorage` (OS keychain / DPAPI). The key is not written into the Conf `config.json` store.
2. **`CMC_API_KEY` in `.env.local`** — for development. A non-empty env value wins over a Settings key.

Polling is conservative (five minutes by default, never faster than once a minute) so a typical retail CMC plan can cover a small custom-token list.

Last-good quotes are cached in userData as `cmc-rates.json`. That file is a local price cache, not a secret. Do not put API keys in git, Conf, or this cache file. See `.env.example` for placeholders only.

## Environment variables

Defined in `main/env.ts` and `@types/frame/environment.d.ts` (plus a few existing Frame knobs):

| Variable | Purpose |
| --- | --- |
| `CMC_API_KEY` | CoinMarketCap API key. Wins over a key saved in Settings. |
| `CMC_POLL_INTERVAL_MS` | Quote poll interval. Default `300000` (5 minutes). Values under `60000` are clamped to 60 seconds. |
| `CMC_MAX_TOKENS` | Max ERC-20s quoted per poll (natives are always included). Default `40`, max `200`. |
| `LOG_LEVEL` | `electron-log` console level (`silly` / `debug` / `verbose` / `info` / `warn` / `error`). |
| `OPEN_DEVTOOLS` | `true` / `false`. Detached Chromium DevTools. Dev defaults on unless `false`; production defaults off unless `true`. `ENABLE_DEV_TOOLS` is a fallback if `OPEN_DEVTOOLS` is unset. |
| `LOG_TRAFFIC` | When `true` (or set to an origin string), logs local JSON-RPC traffic. `npm run launch:dev:traffic` sets this. |

Copy `.env.example` to `.env.local` (gitignored). Never commit a real key.

## Run from source

From the repo root, after `npm run setup`:

```bash
npm run compile && npm run bundle && npm run launch
```

- `compile` builds the main process (`tsc`).
- Dash / Settings UI changes need `bundle:dash` or a full `bundle`.
- `npm run prod` is the same compile + bundle + launch sequence.
- `npm run launch:dev` starts Electron in development (needs a Parcel server or an existing `bundle/`).
- `npm run dev` compiles, starts Parcel, and launches development Electron.

Quit official Frame first so port 1248 is free.

Official Frame’s install and build notes in the README still apply (Node 18, platform packages, `npm run setup`).

## Local Windows install

This produces a **Frame Fork** app (`sh.frame.fork`, userData `%APPDATA%\frame-fork`) next to official Frame. Do not change the app id back to official Frame. Quit one app before starting the other (port 1248).

`npm run build` / `npm run release` are the upstream unix scripts (`sleep` is not a cmd.exe command). On this machine use:

```powershell
npm run package:win
```

That compiles, bundles, and writes an unsigned per-user NSIS installer:

`dist\Frame-Fork-Setup-<version>.exe`

Run the installer and keep the default per-user path (`%LOCALAPPDATA%\Programs\Frame Fork`). That is not official Frame (`%LOCALAPPDATA%\Programs\frame`).

Unpackaged (no installer) — same identity, good if you only want to run the exe tonight:

```powershell
npm run package:win:dir
```

Then, after quitting official Frame:

```powershell
.\dist\win-unpacked\Frame Fork.exe
```

Already compiled and bundled? Add `--skip-build`:

```powershell
node .\scripts\package-win.mjs --dir --skip-build
node .\scripts\package-win.mjs --skip-build
```

The local Windows config (`build/electron-builder-win-local.js`) sets `npmRebuild: false` and `CSC_IDENTITY_AUTO_DISCOVERY=false`. It will not call official Frame’s updater, will not publish to GitHub, and will not run `electron-builder install-app-deps` (that previously failed here with VS Build Tools 5008). It packages the `.node` files already in `node_modules`.

A from-scratch native rebuild still needs VS 2022 Build Tools with the C++ desktop workload, then `electron-builder install-app-deps`. Do not spend time on the VS installer if the `--dir` exe or NSIS package already runs.

## CI on this fork

The inherited `build` job in `.github/workflows/compile-and-test.yml` is compile + unit tests. Electronegativity (Doyensec’s unmaintained Electron scanner) is a separate non-blocking job: on this fork it exited 1 in ~10s and skipped tests. That was scanner/runtime, not a completed findings report. Node 20 deprecation on `checkout` / `setup-node` is a warning only.

`.github/workflows/build.yml` is upstream’s publish/notarize matrix. It is gated to `floating/frame` so this fork cannot ship official Frame installers (those jobs need secrets this repo does not have).

Push the workflow change to the PR branch for CI to go green.
