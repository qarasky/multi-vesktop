<img src="assets/icon.svg" width="64" height="64" alt="">

# Multi Vesktop

A fork of [Vesktop](https://github.com/Vencord/Vesktop) that adds **multi-account tabs**: several Discord
accounts open at once, each in its own isolated session, switchable instantly because every account stays
loaded in memory.

Built on Vesktop (Electron 44), with [Vencord](https://vencord.dev) preinstalled.

## How it works

The main window hosts a tab strip. Each account is a `WebContentsView` bound to its own Chromium session
partition (`persist:multi-<id>`), so multiple Discord logins coexist behind the same `discord.com` origin
with separate cookies, localStorage, IndexedDB and cache. All views stay loaded, so switching only
re-attaches the active view — no reload, no reconnect. See [`docs/multi-account.md`](docs/multi-account.md).

## Install

Download the Windows installer from the [Releases](../../releases) page:

- **Windows** — `Multi-Vesktop-Setup-<version>.exe` (NSIS installer)

> The build is **unsigned**, so SmartScreen shows an "unknown publisher" prompt on the first run
> (More info → Run anyway).

Releases are **Windows-only** by design. macOS and Linux can still be built from source with
`pnpm package`.

Account data always lives in **`%APPDATA%\multi-vesktop`** on Windows. Portable mode has been
removed: even an unpacked executable uses this folder. Account IDs and settings are in `state.json`
and `settings.json`; Discord logins live under `sessionData\Partitions`.

When upgrading an older build that stored data inside the application folder, the installer closes
the app and makes a verified backup beside the old installation **before** running its uninstaller.
The new app copies that profile into AppData on first launch, keeping the backup. Existing AppData
profiles are preserved. If backup or migration fails, the operation stops and retains the original
data. Startup logs include the actual account and session storage paths.

## Build from source

```bash
git clone https://github.com/qarasky/multi-vesktop
cd multi-vesktop
pnpm install
pnpm start          # run
pnpm package        # or: pnpm package:dir
```

Requires Node 24+ and pnpm. (Upstream pins pnpm 11.9.0 via `packageManager`; newer pnpm also works.)

## Releases

Pushing a tag like `v0.3.0` triggers [`.github/workflows/release.yml`](.github/workflows/release.yml),
which builds a single **Windows NSIS installer** (`.exe`) and attaches it to a GitHub Release.
The app self-updates from these releases on Windows.

## Logs & debugging

Logs are written to **`Documents/Multi Vesktop/logs`** (falling back to the app's data dir if that folder isn't writable):

- one file per **12-hour session**: `multi-vesktop_<date>_<0000|1200>.log`
- files older than **3 days** are pruned automatically
- captures main-process output, uncaught errors, and renderer errors/crashes
- in the app menu: **Open logs folder**

Verbose logging (including all renderer console output, which is noisy) can be enabled with `--debug`
or the `MULTI_VESKTOP_DEBUG=1` environment variable.

> Some logged lines are normal Discord/Vencord noise (e.g. `Sentry successfully disabled`, CSP warnings
> from badge fetches) — not necessarily bugs.

## Staying in sync with upstream Vesktop

This is a real fork with upstream history preserved. To pull in upstream changes:

```bash
git remote add upstream https://github.com/Vencord/Vesktop   # once
git fetch upstream
git merge upstream/main
```

Conflicts concentrate in the upstream files we edit (`mainWindow.ts`, `ipc.ts`, `screenShare.ts`,
`mediaPermissions.ts`, `makeLinksOpenExternally.ts`, `ipcCommands.ts`, `build.mts`, `IpcEvents.ts`,
`settings.d.ts`). Most of the multi-account logic lives in new files, so it survives upstream churn.
Merge regularly to keep conflicts small.

## Licensing

Inherited from Vesktop and Vencord: **GPL-3.0-or-later**. See [`LICENSE`](LICENSE). This fork must remain
GPL-3.0 and publish its source.
