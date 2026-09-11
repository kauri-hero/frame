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
