# Multi-account tabs

Goal: run several Discord accounts in one window, each in its own isolated session, switchable
instantly because every account stays loaded in memory. Target: 4–6 accounts, voice on one.

This is a fork of [Vesktop](https://github.com/Vencord/Vesktop). Upstream is imported with full history;
our work lives on top.

## The core idea

Two Discord logins can coexist behind the same `discord.com` origin only if they have **separate cookie
jars and storage**. Chromium gives us exactly that with **session partitions**:

```ts
session.fromPartition("persist:multi-<accountId>")
```

So an account is just an id that maps to a partition. Everything else follows:

- Each account is a `WebContentsView` whose `webPreferences.partition` is that account's partition.
- All views are created at startup and stay alive. Switching only re-attaches the active view to the
  window; nothing reloads or reconnects, so switching is instant.
- Vesktop's own renderer preload (`dist/js/preload.js`) injects Vencord **per webContents**, so every
  account view gets Vencord for free. No change to the injection path is needed.
- Vencord's files, plugin settings and themes stay shared (one copy under `DATA_DIR`), which is what we
  want: configure once, applies to every account.

## Window layout

`mainWin` remains a normal `BrowserWindow` (so the tray, about window, updater and window-bounds code
keep working). It now loads the **tab strip** instead of Discord:

```
┌──────────────────────────────────────────────┐
│  main   alt-1 (3)   alt-2 (1)   +            │  ← mainWin's webContents: static/views/tabs.html
├──────────────────────────────────────────────┤
│                                              │
│        active account's WebContentsView      │  ← child view, bounds start below the strip
│        (partition: persist:multi-<id>)       │
│                                              │
└──────────────────────────────────────────────┘
```

- `TAB_STRIP_HEIGHT` (40px) is reserved at the top for the strip; the active view is laid out below it.
- Inactive views are detached from `win.contentView` but kept referenced in a `Map`, so their renderer
  processes and websockets stay alive. `backgroundThrottling: false` is set on every view.

## What these files do

| File | Role |
| --- | --- |
| `src/shared/accounts.ts` | Account type, partition naming, tab palette |
| `src/main/accounts.ts` | CRUD over `State.store.accounts` |
| `src/main/discordViews.ts` | The view manager: create/destroy/attach views, per-tab title & unread |
| `src/main/accountSessions.ts` | Registers media-permission + screen-share handlers on each account session |
| `src/main/tabsIpc.ts` | IPC the tab strip uses to list/select/create/close/rename accounts |
| `src/preload/tabStrip.ts` | `contextBridge` API for the strip |
| `static/views/tabs.html` | The strip UI (self-contained) |

## Sites: more than one view per account

Each account owns one view per **site**, all sharing that account's session partition:

| site | what | Vencord? |
| --- | --- | --- |
| `discord` | `discord.com/app` | yes |
| `topgg` | `top.gg` | no (plain page) |

Because they share the partition, **top.gg's "Log in with Discord" sees that account's Discord login** — so
top.gg is authenticated as the same account. The strip shows two rows: accounts on top, their top.gg views
below. Discord views are created eagerly; other sites lazily on first activation.

## Status / roadmap

- [x] Account store + session partitions
- [x] Tabbed view manager (create, switch, close, layout)
- [x] Tab strip UI + IPC
- [x] Per-view Discord behaviours (external links, popouts, spellcheck context menu, devtools hooks)
- [x] Per-account media/screen-share handlers
- [x] Account identity in tabs (avatar + display name + unread)
- [x] Extra per-account sites sharing the partition (top.gg)
- [x] Tab reordering by drag
- [x] File logging (12h sessions, 3-day retention)
- [ ] Unread badge aggregation into dock/tray
- [ ] "Primary account" concept for arRPC / voice
- [ ] Reconnect a crashed view from the tab menu

## Known costs

- Each live account is a full Chromium renderer (~350–700 MB). 4 accounts ≈ 2–3 GB. That is the price
  of instant switching, not a bug.
- Voice/screen-share hand on one account at a time; device contention makes 2+ simultaneous voice
  sessions unreliable.
- macOS: upstream typecheck is red out of the box because `@vencord/venmic` is Linux-only; those four
  errors are pre-existing and unrelated to this work.

## Licensing

Vesktop and Vencord are **GPL-3.0-or-later**. This fork inherits that and must publish its source.
