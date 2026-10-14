import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";
import { transformSync } from "esbuild";

const require = createRequire(import.meta.url);
test(
    "silent diagnostics capture every view and reload targets only the visible page",
    {
        skip: process.platform === "linux" && !process.env.DISPLAY && "Electron requires a display on Linux",
        timeout: 60000
    },
    t => {
        const root = mkdtempSync(join(tmpdir(), "multi-vesktop-view-recovery-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const compile = path => transformSync(readFileSync(path, "utf8"), { loader: "ts", format: "cjs" }).code;
        const sources = {
            logger: compile("src/main/logger.ts"),
            manager: compile("src/main/discordViews.ts"),
            ipc: compile("src/shared/IpcEvents.ts")
        };
        const worker = join(root, "main.cjs");
        writeFileSync(
            worker,
            String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { runInNewContext } = require('node:vm');
const { EventEmitter, once } = require('node:events');
const { app, BrowserWindow, session } = require('electron');
const root = ${JSON.stringify(root)};
const sources = ${JSON.stringify(sources)};
app.setPath('userData', root);
app.setPath('sessionData', root);
const timeout = setTimeout(() => app.exit(2), 45000);
const echoed = [];
const quietConsole = Object.fromEntries(['log','info','warn','error'].map(k=>[k,(...args)=>echoed.push(args.join(' '))]));
function load(code, dependencies = {}) {
    const module = { exports: {} };
    runInNewContext(code, {module,console:quietConsole,process,setTimeout,clearTimeout,Buffer,__dirname:root,
        require: name => name in dependencies ? dependencies[name] : require(name)});
    return module.exports;
}
app.whenReady().then(async () => {
    app.dock?.hide();
    // Use the real app's events, while keeping all log paths inside the fixture.
    const logApp = load(sources.logger, {
        './constants': { DATA_DIR:root, SESSION_DATA_DIR:root },
        electron: {app:{on:app.on.bind(app),getPath:()=>root},shell:{openPath:()=>{}}}
    });
    logApp.attachRendererLogging();
    const accounts = [{id:'one',label:'First'},{id:'two',label:'Second'}];
    for(const account of accounts) {
        const ses = session.fromPartition('persist:multi-'+account.id);
        ses.protocol.handle('https', () => new Response('<!doctype html><title>Fixture</title><script>window.loads=Number(sessionStorage.loads||0)+1;sessionStorage.loads=window.loads;</script>', {headers:{'Content-Type':'text/html'}}));
    }
    const manager = load(sources.manager, {
        'shared/accounts': {accountPartition:id=>'persist:multi-'+id},
        'shared/IpcEvents': load(sources.ipc),
        './accounts': {getAccount:id=>accounts.find(a=>a.id===id),getAccounts:()=>accounts},
        './accountSessions': {setupAccountSession:()=>{}},
        './activeView': {setActiveWebContentsGetter:()=>{}},
        './constants': {BrowserUserAgent:'Mozilla/5.0',DISCORD_HOSTNAMES:['discord.com']},
        './events': {AppEvents:new EventEmitter()},
        './settings': {Settings:{store:{discordBranch:'stable'}}},
        './splash': {updateSplashMessage:()=>{}},
        './utils/makeLinksOpenExternally': {makeWebContentsOpenLinksExternally:()=>{}},
        './logger': logApp
    });
    const win = new BrowserWindow({show:false});
    manager.initDiscordViews(win);
    const first = manager.createView(accounts[0]).view.webContents;
    const second = manager.createView(accounts[1]).view.webContents;
    const settled = async wc => { if(wc.isLoading()) await once(wc,'did-stop-loading'); };
    await Promise.all([settled(first),settled(second)]);
    assert.equal(await first.executeJavaScript('window.loads'),1);
    assert.equal(await second.executeJavaScript('window.loads'),1);
    const failures=[];
    const check = async (name,fn) => {try {await fn();} catch(e){failures.push(name+': '+e.message);}};
    await check('visible Discord reload', async () => {
        manager.setActive('one');
        assert.equal(manager.reloadVisibleView?.(),true);
        await settled(first);
        assert.equal(await first.executeJavaScript('window.loads'),2);
        assert.equal(await second.executeJavaScript('window.loads'),1);
    });
    manager.openOverlay('one');
    const overlay = win.contentView.children.find(v=>v.webContents && v.webContents!==first && v.webContents!==second && v.webContents.session===first.session)?.webContents;
    assert.ok(overlay);
    await settled(overlay);
    await check('visible overlay reload preserves storage', async () => {
        await overlay.executeJavaScript('localStorage.setItem("kept","yes")');
        await overlay.session.cookies.set({url:'https://top.gg',name:'kept',value:'yes'});
        const firstLoads=await first.executeJavaScript('window.loads');
        assert.equal(manager.reloadVisibleView?.(),true);
        await settled(overlay);
        assert.equal(await overlay.executeJavaScript('window.loads'),2);
        assert.equal(await first.executeJavaScript('window.loads'),firstLoads);
        assert.equal(await overlay.executeJavaScript('localStorage.getItem("kept")'),'yes');
        assert.equal((await overlay.session.cookies.get({name:'kept'}))[0].value,'yes');
    });
    await check('all renderer levels are silent and attributable', async () => {
        echoed.length=0;
        await first.executeJavaScript('console.debug("first-debug-marker");console.info("first-info-marker");console.warn("first-warning-marker");console.error("first-error-marker")');
        await overlay.executeJavaScript('console.log("overlay-info-marker")');
        await second.executeJavaScript('console.debug("hidden-account-marker")');
        await new Promise(r=>setTimeout(r,400));
        // Flush buffered diagnostics on normal shutdown as well.
        app.emit('before-quit');
        const dir=logApp.getLogDirPath();
        const files=fs.readdirSync(dir).filter(n=>n.endsWith('.log'));
        const text=files.map(n=>fs.readFileSync(require('node:path').join(dir,n),'utf8')).join('');
        for(const marker of ['first-debug-marker','first-info-marker','first-warning-marker','first-error-marker','overlay-info-marker','hidden-account-marker']) assert.ok(text.includes(marker),'missing '+marker);
        assert.ok(text.includes('discord:one'));
        assert.ok(text.includes('topgg:one'));
        assert.equal(echoed.filter(s=>s.includes('-marker')).length,0);
    });
    await check('closing the overlay restores the selected account reload target', async () => {
        manager.closeOverlay();
        manager.setActive('two');
        const overlayLoads=await overlay.executeJavaScript('window.loads');
        assert.equal(manager.reloadVisibleView(),true);
        await settled(second);
        assert.equal(await second.executeJavaScript('window.loads'),2);
        assert.equal(await overlay.executeJavaScript('window.loads'),overlayLoads);
        assert.equal(await first.executeJavaScript('window.loads'),2);
        manager.openOverlay('one');
    });
    await check('view logs rotate and bound oversized messages', async () => {
        const dir=logApp.getLogDirPath();
        const file=fs.readdirSync(dir).find(n=>n.endsWith('_views.log'));
        assert.ok(file);
        const path=require('node:path').join(dir,file);
        for(let index=0;index<3;index++) {
            fs.truncateSync(path,10*1024*1024);
            await first.executeJavaScript('console.info("rotation-marker-'+index+'")');
            app.emit('before-quit');
            assert.ok(fs.readFileSync(path,'utf8').includes('rotation-marker-'+index));
            assert.ok(fs.existsSync(path.replace(/\.log$/,'.1.log')));
        }
        assert.equal(fs.readdirSync(dir).filter(n=>n.includes('_views')).length,3);
        await first.executeJavaScript('console.info("long-marker-"+"x".repeat(100000)+"end-marker")');
        app.emit('before-quit');
        const text=fs.readFileSync(path,'utf8');
        assert.ok(text.includes('long-marker-'));
        assert.ok(text.includes('[truncated]'));
        assert.ok(!text.includes('end-marker'));
        assert.ok(fs.statSync(path).size<100000);
    });
    await check('destroyed visible view is safe', async () => {
        const destroyed=once(overlay,'destroyed');
        overlay.close();
        await destroyed;
        assert.equal(manager.reloadVisibleView?.(),false);
    });
    clearTimeout(timeout);
    if(failures.length) {console.error(failures.join('\n'));app.exit(1);} else {console.log('View recovery checks passed');app.quit();}
}).catch(error=>{console.error(error);app.exit(1);});
`
        );
        const env = { ...process.env };
        new Script(readFileSync(worker, "utf8"), { filename: worker });
        delete env.ELECTRON_RUN_AS_NODE;
        delete env.MULTI_VESKTOP_DEBUG;
        const result = spawnSync(require("electron"), [worker], { env, encoding: "utf8", timeout: 50000 });
        assert.equal(result.status, 0, result.stdout + result.stderr + (result.error || ""));
    }
);
