# top.gg client-side errors: investigation

Investigated on 2026-10-14 against commit `0c02c2b`, Electron 44.4.3 / Chromium
152.0.7977.130, and the live top.gg site. No application behavior was changed.

## Result

A malformed top.gg localStorage entry can reproduce its generic client-side
exception page under the overlay's Electron settings. This is a demonstrated
failure mechanism, **not a diagnosis of the reported intermittent problem**:
the experiment deliberately introduced malformed data, and no naturally
occurring failure or affected account profile was available.

## What the application does

- `src/main/discordViews.ts` creates one top.gg `WebContentsView` per account,
  using that account's persistent session partition. This allows Discord OAuth
  to use the corresponding Discord login. Cookies remain domain scoped and
  localStorage remains origin scoped; sharing a partition does not make
  Discord's localStorage available to top.gg.
- The overlay has sandboxing and context isolation enabled, no Vesktop/Vencord
  preload, and a Chrome-style user agent based on the installed Chromium version.
- Closing the overlay only hides it. Reopening reuses the same document,
  JavaScript state, and sessionStorage. There is no reload or recovery action in
  the overlay header. A failed document therefore remains failed on reopening.
- The shared logger already captures renderer console errors and process
  crashes. Its modern `console-message` event handling matches the installed
  Electron API. There is no overlay-specific resource failure reporting.

## Isolated runtime experiment

A temporary Electron profile and persistent test partition were used; the
user's account storage was neither loaded nor modified. A hidden BrowserWindow
hosted a WebContentsView with the overlay's renderer preferences and user agent.
The temporary profile was deleted after the process exited.

1. The homepage loaded normally.
2. Clicking a homepage link navigated to Mudae's bot page normally.
3. Ten hide/show cycles retained a sessionStorage marker and caused no observed
   renderer crash.
4. Setting `localStorage['BOT:DISCORD']` to the invalid JSON string `{broken`
   and loading the homepage produced the generic client-side exception page.
   The renderer console reported a JSON parsing SyntaxError.
5. Removing only `BOT:DISCORD` and loading the homepage restored normal rendering.
   No cookie or sessionStorage clearing was performed.

Inspection of the site's first-party JavaScript found an unguarded
`JSON.parse` of this saved entry in chunk `6520-82149523886cf1b1.js` (deployment
`345aa33`). Chunk `1130-2cd0ca76e0d90501.js` also parses the localStorage queues
`topgg:pending-events` and `topgg:pending-ads-v2-events` without a surrounding
catch. Those queue entries were not tested. Site deployments can change this
code and the chunk names.

## Interpretation and next steps

Persistent localStorage is now a concrete candidate. Cookies, sessionStorage,
OAuth, and a Chromium process failure remain unconfirmed. The generic error page
indicates an uncaught website JavaScript error; it does not establish that the
Electron renderer process crashed. Authenticated voting, Windows behavior, and
long-running sessions were not tested.

The next useful implementation would provide overlay-specific diagnostics for
failed navigation/resources and a user-triggered reload. If reload does not help,
recreating only the overlay would discard its page session and sessionStorage
while retaining the account's persistent login data. Neither action fixes
malformed persistent localStorage. A separate, explicit top.gg-only storage
reset could address that case after diagnostics establish the cause.

Do not automatically erase the shared account partition as a recovery strategy:
it contains the Discord login. No automatic storage cleanup is justified by
this experiment.

## References

- [Next.js: Client-side Exception Occurred](https://nextjs.org/docs/messages/client-side-exception-occurred)
- [Electron: webContents events](https://www.electronjs.org/docs/latest/api/web-contents)
- [Electron: session partitions](https://www.electronjs.org/docs/latest/api/session)
- [MDN: sessionStorage lifetime and scope](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage)
- [top.gg storage-reading chunk](https://top.gg/_next/static/chunks/6520-82149523886cf1b1.js?dpl=345aa33)
- [top.gg event queue chunk](https://top.gg/_next/static/chunks/1130-2cd0ca76e0d90501.js?dpl=345aa33)
