import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

test(
    "top.gg can be dragged without opening and restores its saved position after reload",
    {
        skip: process.platform === "linux" && !process.env.DISPLAY && "Electron requires a display on Linux",
        timeout: 60000
    },
    async t => {
        const root = mkdtempSync(join(tmpdir(), "multi-vesktop-topgg-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const renderer = (
            await build({
                entryPoints: ["src/renderer/topggButton.ts"],
                bundle: true,
                write: false,
                format: "iife",
                plugins: [
                    {
                        name: "test-logger",
                        setup(build) {
                            build.onResolve({ filter: /^\.\/logger$/ }, () => ({ path: "logger", namespace: "test" }));
                            build.onLoad({ filter: /.*/, namespace: "test" }, () => ({
                                contents: "export const VesktopLogger = console;"
                            }));
                        }
                    }
                ]
            })
        ).outputFiles[0].text;
        const main = join(root, "test.cjs");
        writeFileSync(
            main,
            `
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const { writeFileSync, readFileSync } = require('node:fs');
app.setPath('userData', ${JSON.stringify(root)});
let saved;
let opens = 0;
let writes = 0;
app.whenReady().then(async () => {
    if (app.dock) app.dock.hide();
    const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { contextIsolation: false, nodeIntegration: true, backgroundThrottling: false } });
    win.webContents.on('console-message', event => console.log(event.message));
    const bootstrap = () => \
        'const originalAttachShadow = HTMLElement.prototype.attachShadow; HTMLElement.prototype.attachShadow = function(options) { const root = originalAttachShadow.call(this, options); if (this.id === "multi-vesktop-topgg-host") window.buttonShadowRoot = root; return root; }; window.VesktopNative = { topgg: { toggle() { require("electron").ipcRenderer.send("opened") }, getButtonPosition() { return require("electron").ipcRenderer.sendSync("get-position") }, setButtonPosition(p) { return require("electron").ipcRenderer.invoke("save-position", p) }, onButtonPositionChanged(cb) { window.positionChanged = cb } } };';
    const { ipcMain } = require('electron');
    ipcMain.on('opened', () => opens++);
    ipcMain.on('get-position', e => { e.returnValue = saved; });
    ipcMain.handle('save-position', (_e, p) => { saved = p; writes++; writeFileSync(${JSON.stringify(join(root, "position.json"))}, JSON.stringify(p)); });
    const load = async () => {
        await win.loadURL('data:text/html,' + encodeURIComponent('<html><body style="margin:0"><button id="send" style="position:fixed;right:16px;bottom:16px">Send</button><script>' + bootstrap() + ${JSON.stringify(renderer)} + '</script></body></html>'));
        await new Promise(r => setTimeout(r, 80));
        await win.webContents.executeJavaScript('for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture", "click"]) window.buttonShadowRoot.querySelector("button").addEventListener(type, event => console.log(JSON.stringify({type, detail:event.detail, pointerType:event.pointerType, x:event.clientX, y:event.clientY, buttons:event.buttons, trusted:event.isTrusted})))');
    };
    const rect = () => win.webContents.executeJavaScript('(() => { const r = document.getElementById("multi-vesktop-topgg-host").getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight}; })()');
    let leftButtonDown = false;
    const input = async (type, x, y) => {
        if (type === 'mouseDown') leftButtonDown = true;
        if (type === 'mouseUp') leftButtonDown = false;
        win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: leftButtonDown ? ['leftbuttondown'] : [] });
        await new Promise(r => setTimeout(r, 40));
    };
    await load();
    const initial = await rect();
    const x = initial.x + 23, y = initial.y + 23;
    await input('mouseDown', x, y);
    await input('mouseMove', x - 180, y - 120);
    await input('mouseUp', x - 180, y - 120);
    assert.ok(saved, 'Dragging must save a position');
    assert.equal(opens, 0, 'Dragging must not open top.gg');
    assert.equal(writes, 1, 'Only persist once, on drop');
    const moved = await rect();
    assert.ok(Math.abs(moved.x - (initial.x - 180)) < 2);
    assert.ok(Math.abs(moved.y - (initial.y - 120)) < 2);
    saved = JSON.parse(readFileSync(${JSON.stringify(join(root, "position.json"))}, 'utf8'));
    await load();
    const restored = await rect();
    assert.ok(Math.abs(restored.x - moved.x) < 1 && Math.abs(restored.y - moved.y) < 1, 'Restore after reload');
    await input('mouseDown', restored.x + 23, restored.y + 23);
    await input('mouseUp', restored.x + 23, restored.y + 23);
    assert.equal(opens, 1, 'Normal click still opens top.gg');
    await input('mouseDown', restored.x + 23, restored.y + 23);
    await input('mouseMove', restored.x + 25, restored.y + 25);
    await input('mouseUp', restored.x + 25, restored.y + 25);
    assert.equal(opens, 2, 'Small pointer jitter remains a click');
    assert.equal(writes, 1, 'Clicks do not rewrite the saved position');
    await win.webContents.executeJavaScript('window.positionChanged({x:0,y:0})');
    const shared = await rect();
    assert.equal(shared.x, 8, 'Other account position updates apply');
    assert.equal(shared.y, 8);
    await input('mouseDown', shared.x + 23, shared.y + 23);
    // Keep input inside the client area while requesting an origin past the edge.
    await input('mouseMove', 0, 0);
    const edge = await rect();
    assert.equal(edge.x, 8, 'Drag clamps the button to the left inset');
    assert.equal(edge.y, 8, 'Drag clamps the button to the top inset');
    await input('mouseMove', edge.x + 23, edge.y + 23);
    await input('mouseUp', edge.x + 23, edge.y + 23);
    assert.equal(opens, 2, 'Offscreen drag must not open top.gg');
    await win.webContents.executeJavaScript('window.buttonShadowRoot.querySelector("button").click()');
    await new Promise(r => setTimeout(r, 40));
    assert.equal(opens, 3, 'Keyboard/programmatic activation is not suppressed after dragging');
    await input('mouseDown', edge.x + 23, edge.y + 23);
    await input('mouseUp', edge.x + 23, edge.y + 23);
    assert.equal(opens, 4, 'Click still works after an offscreen drag');
    const writesBeforeRemoval = writes;
    await input('mouseDown', edge.x + 23, edge.y + 23);
    await input('mouseMove', edge.x + 123, edge.y + 103);
    await win.webContents.executeJavaScript('document.getElementById("multi-vesktop-topgg-host").remove()');
    await input('mouseUp', edge.x + 123, edge.y + 103);
    await new Promise(r => setTimeout(r, 3100));
    const replacement = await rect();
    assert.equal(replacement.x, 8, 'Host replacement restores persisted position, not an unfinished drag');
    assert.equal(replacement.y, 8);
    assert.equal(writes, writesBeforeRemoval, 'Interrupted drag must not persist');
    await win.webContents.executeJavaScript('window.positionChanged({x:1,y:0})');
    const synchronized = await rect();
    assert.equal(synchronized.x, synchronized.viewportWidth - 54, 'Shared updates still work after replacement');
    assert.equal(synchronized.y, 8);
    console.log('top.gg drag, click, shared update, edge clamp and reload passed');
    win.destroy();
    app.quit();
}).catch(error => { console.error(error); app.exit(1); });
`
        );
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const result = spawnSync(require("electron"), [main], { env, encoding: "utf8", timeout: 45000 });
        assert.equal(result.status, 0, result.stdout + result.stderr + (result.error || ""));
    }
);
