import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSync } from "esbuild";

const require = createRequire(import.meta.url);
test(
    "real Electron session storage survives replacement of the application files",
    {
        skip: process.platform === "linux" && !process.env.DISPLAY && "Electron requires a display on Linux",
        timeout: 60000
    },
    t => {
        const root = mkdtempSync(join(tmpdir(), "multi-vesktop-electron-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const canonical = join(root, "multi-vesktop");
        const install = join(root, "application");
        // Isolate source discovery from the real user's registry and existing profiles.
        writeFileSync(canonical + ".migration-complete", "Isolated regression profile\n");
        const bootstrap = buildSync({
            entryPoints: ["src/main/userDataDir.ts"],
            bundle: true,
            write: false,
            platform: "node",
            format: "cjs",
            external: ["electron"]
        }).outputFiles[0].text;
        const main = join(install, "main.cjs");
        const worker = `
const { app, session } = require('electron');
app.setPath('appData', ${JSON.stringify(root)});
app.setPath('userData', ${JSON.stringify(join(root, "isolated-default"))});
${bootstrap}
app.whenReady().then(async () => {
    if (app.dock) app.dock.hide();
    const ses = session.fromPartition('persist:multi-regression');
    if (process.argv.includes('--write-cookie')) {
        await ses.cookies.set({ url: 'https://example.invalid', name: 'regression', value: 'kept', expirationDate: Math.floor(Date.now() / 1000) + 3600 });
        await ses.cookies.flushStore();
        ses.flushStorageData();
    } else {
        const cookies = await ses.cookies.get({ url: 'https://example.invalid', name: 'regression' });
        if (cookies[0]?.value !== 'kept') throw new Error('Session cookie was lost');
    }
    console.log(JSON.stringify({ storage: ses.getStoragePath(), userData: app.getPath('userData') }));
    app.quit();
}).catch(error => { console.error(error); app.exit(1); });
`;
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        for (const args of [[main, "--write-cookie"], [main]]) {
            mkdirSync(install);
            writeFileSync(main, worker);
            const result = spawnSync(require("electron"), args, { env, encoding: "utf8", timeout: 25000 });
            assert.equal(result.status, 0, result.stdout + result.stderr + (result.error || ""));
            const persisted = JSON.parse(result.stdout.trim().split("\n").at(-1));
            assert.equal(persisted.userData, canonical);
            assert.equal(persisted.storage, join(canonical, "sessionData", "Partitions", "multi-regression"));
            rmSync(install, { recursive: true });
        }
    }
);
