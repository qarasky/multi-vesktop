import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";

const require = createRequire(import.meta.url);
const code = buildSync({
    entryPoints: ["src/main/constants.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["electron"]
}).outputFiles[0].text;

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), "multi-vesktop-storage-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const appData = join(root, "AppData");
    const install = join(root, "Application");
    mkdirSync(install);
    return { root, appData, install, canonical: join(appData, "multi-vesktop") };
}

function profile(dir, id) {
    mkdirSync(join(dir, "sessionData", "Partitions", `multi-${id}`, "Local Storage"), { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ firstLaunch: false, accounts: [{ id, label: id }] }));
    writeFileSync(join(dir, "sessionData", "Partitions", `multi-${id}`, "Local Storage", "login"), `session-${id}`);
    writeFileSync(join(dir, "settings.json"), '{"tray":false}');
}

function start(f, env = {}, filesystem = fs, commands = { execFileSync: () => "" }) {
    const paths = { appData: f.appData, userData: join(f.appData, "Multi Vesktop") };
    const app = {
        getPath: name => paths[name],
        setPath: (name, value) => {
            paths[name] = value;
        },
        getVersion: () => "0.3.3",
        exit: () => {}
    };
    const context = {
        module: { exports: {} },
        console: { log() {}, error() {} },
        process: {
            platform: "win32",
            pid: process.pid,
            kill: process.kill,
            execPath: join(f.install, "multi-vesktop.exe"),
            argv: ["multi-vesktop.exe"],
            env,
            versions: { chrome: "134.0.0" }
        },
        require: name =>
            name === "electron"
                ? { app, dialog: { showErrorBox() {} } }
                : name === "fs"
                  ? filesystem
                  : name === "child_process"
                    ? commands
                    : require(name)
    };
    runInNewContext(code, context);
    return { constants: context.module.exports, paths };
}

test("installed and unpacked executables always store accounts outside the application folder", t => {
    const f = fixture(t);
    writeFileSync(join(f.install, "Uninstall multi-vesktop.exe"), "");
    const { constants, paths } = start(f);
    assert.equal(constants.DATA_DIR, f.canonical);
    assert.equal(paths.userData, f.canonical);
    assert.equal(paths.sessionData, join(f.canonical, "sessionData"));
    rmSync(join(f.install, "Uninstall multi-vesktop.exe"));
    assert.equal(start(f).constants.DATA_DIR, f.canonical);
});

test("an inherited Vencord environment variable cannot redirect account storage", t => {
    const f = fixture(t);
    assert.equal(start(f, { VENCORD_USER_DATA_DIR: join(f.install, "Data") }).constants.DATA_DIR, f.canonical);
});

test("migration preserves account IDs and their complete session storage", t => {
    const f = fixture(t);
    profile(join(f.install, "Data"), "legacy");
    start(f);
    assert.equal(JSON.parse(readFileSync(join(f.canonical, "state.json"))).accounts[0].id, "legacy");
    assert.equal(
        readFileSync(join(f.canonical, "sessionData", "Partitions", "multi-legacy", "Local Storage", "login"), "utf8"),
        "session-legacy"
    );
    assert.equal(
        readFileSync(join(f.install, "Data", "state.json"), "utf8"),
        readFileSync(join(f.canonical, "state.json"), "utf8")
    );
});

test("an existing AppData profile is copied to the canonical location", t => {
    const f = fixture(t);
    profile(join(f.appData, "Multi Vesktop"), "alias");
    assert.equal(start(f).constants.DATA_DIR, f.canonical);
    assert.equal(JSON.parse(readFileSync(join(f.canonical, "state.json"))).accounts[0].id, "alias");
});

test("an established canonical profile is never overwritten by legacy accounts", t => {
    const f = fixture(t);
    profile(f.canonical, "current");
    profile(join(f.install, "Data"), "legacy");
    start(f);
    assert.equal(JSON.parse(readFileSync(join(f.canonical, "state.json"))).accounts[0].id, "current");
});

test("an obsolete corrupt recovery manifest cannot block an established AppData profile", t => {
    const f = fixture(t);
    profile(f.canonical, "current");
    writeFileSync(join(f.install, "legacy-data-backups.json"), "{broken");
    start(f);
    assert.equal(JSON.parse(readFileSync(join(f.canonical, "state.json"))).accounts[0].id, "current");
});

test("an empty state file in AppData does not block migration", t => {
    const f = fixture(t);
    mkdirSync(f.canonical, { recursive: true });
    writeFileSync(join(f.canonical, "state.json"), "{}");
    profile(join(f.install, "Data"), "legacy");
    start(f);
    assert.equal(JSON.parse(readFileSync(join(f.canonical, "state.json"))).accounts[0].id, "legacy");
});

test("installer recovery works even after the old installation has been deleted", t => {
    const f = fixture(t);
    const backup = join(f.root, "Old Application.multi-vesktop-data-backup-test");
    profile(backup, "recovered");
    writeFileSync(join(f.install, "legacy-data-backups.json"), JSON.stringify([backup]));
    start(f);
    assert.equal(JSON.parse(readFileSync(join(f.canonical, "state.json"))).accounts[0].id, "recovered");
});

test("resetting the app does not import stale legacy accounts again", t => {
    const f = fixture(t);
    profile(join(f.install, "Data"), "legacy");
    start(f);
    assert.equal(JSON.parse(readFileSync(join(f.canonical, "state.json"))).accounts[0].id, "legacy");
    rmSync(f.canonical, { recursive: true, force: true });
    start(f);
    assert.throws(() => readFileSync(join(f.canonical, "state.json")), { code: "ENOENT" });
});

test("corrupt legacy account data stops startup rather than creating an empty profile", t => {
    const f = fixture(t);
    mkdirSync(join(f.install, "Data"));
    writeFileSync(join(f.install, "Data", "state.json"), "{broken");
    assert.throws(() => start(f), /JSON/);
});

test("migration refuses links outside the legacy profile and can retry after correction", t => {
    const f = fixture(t);
    const legacy = join(f.install, "Data");
    profile(legacy, "legacy");
    symlinkSync(f.root, join(legacy, "external"));
    assert.throws(() => start(f), /symbolic link/);
    rmSync(join(legacy, "external"));
    start(f);
    assert.equal(JSON.parse(readFileSync(join(f.canonical, "state.json"))).accounts[0].id, "legacy");
});

test("a damaged copy leaves the current directory intact and migration remains retryable", t => {
    const f = fixture(t);
    profile(join(f.install, "Data"), "legacy");
    mkdirSync(f.canonical, { recursive: true });
    writeFileSync(join(f.canonical, "state.json"), "{}");
    const filesystem = {
        ...fs,
        cpSync(source, target, options) {
            fs.cpSync(source, target, options);
            writeFileSync(join(target, "state.json"), "damaged copy");
        }
    };
    assert.throws(() => start(f, {}, filesystem), /verification failed/);
    assert.equal(readFileSync(join(f.canonical, "state.json"), "utf8"), "{}");
    assert.throws(() => readFileSync(f.canonical + ".migration-complete"));
    start(f);
    assert.equal(JSON.parse(readFileSync(join(f.canonical, "state.json"))).accounts[0].id, "legacy");
});

test("a failed promotion restores the previous directory before stopping startup", t => {
    const f = fixture(t);
    profile(join(f.install, "Data"), "legacy");
    mkdirSync(f.canonical, { recursive: true });
    writeFileSync(join(f.canonical, "state.json"), "{}");
    const filesystem = {
        ...fs,
        renameSync(from, to) {
            if (to === f.canonical && !from.endsWith(".previous")) throw new Error("Simulated disk failure");
            fs.renameSync(from, to);
        }
    };
    assert.throws(() => start(f, {}, filesystem), /disk failure/);
    assert.equal(readFileSync(join(f.canonical, "state.json"), "utf8"), "{}");
    start(f);
    assert.equal(JSON.parse(readFileSync(join(f.canonical, "state.json"))).accounts[0].id, "legacy");
});

test("a concurrent startup cannot overwrite an account established during copying", t => {
    const f = fixture(t);
    profile(join(f.install, "Data"), "legacy");
    const filesystem = {
        ...fs,
        cpSync(source, target, options) {
            fs.cpSync(source, target, options);
            profile(f.canonical, "concurrent");
            writeFileSync(f.canonical + ".migration-complete", "done");
        }
    };
    start(f, {}, filesystem);
    assert.equal(JSON.parse(readFileSync(join(f.canonical, "state.json"))).accounts[0].id, "concurrent");
});

test("an active migration lock stops a competing startup without touching either profile", t => {
    const f = fixture(t);
    profile(join(f.install, "Data"), "legacy");
    mkdirSync(f.appData, { recursive: true });
    writeFileSync(f.canonical + ".migration-lock", String(process.pid));
    assert.throws(() => start(f), /migration.*running/i);
    assert.throws(() => readFileSync(join(f.canonical, "state.json")));
    assert.equal(JSON.parse(readFileSync(join(f.install, "Data", "state.json"))).accounts[0].id, "legacy");
});

test("an older running app prevents migration of its live session databases", t => {
    const f = fixture(t);
    profile(join(f.install, "Data"), "legacy");
    const commands = {
        execFileSync(executable) {
            if (executable.endsWith("powershell.exe")) throw new Error("Another app is running");
            return "";
        }
    };
    assert.throws(() => start(f, {}, fs, commands), /close.*Multi Vesktop/i);
    assert.throws(() => readFileSync(f.canonical + ".migration-complete"));
});

test("the current user's old installation takes priority over an elevated administrator's backup", t => {
    const f = fixture(t);
    const userInstall = join(f.root, "Users installation");
    profile(join(userInstall, "Data"), "user");
    profile(join(f.install, "Data"), "administrator");
    const commands = {
        execFileSync(executable) {
            return executable.endsWith("reg.exe") ? `InstallLocation    REG_SZ    ${userInstall}\r\n` : "";
        }
    };
    start(f, {}, fs, commands);
    assert.equal(JSON.parse(readFileSync(join(f.canonical, "state.json"))).accounts[0].id, "user");
});

test("an established current-user profile with no accounts is not replaced with shared accounts", t => {
    const f = fixture(t);
    const userInstall = join(f.root, "Users installation");
    mkdirSync(join(userInstall, "Data"), { recursive: true });
    writeFileSync(join(userInstall, "Data", "state.json"), '{"firstLaunch":false,"accounts":[]}');
    profile(join(f.install, "Data"), "administrator");
    const commands = {
        execFileSync(executable, args) {
            if (executable.endsWith("reg.exe")) {
                const pkg = require("../package.json");
                assert.equal(args[1], "HKCU\\Software\\" + pkg.build.nsis.guid);
                return `InstallLocation    REG_SZ    ${userInstall}\r\n`;
            }
            return "";
        }
    };
    start(f, {}, fs, commands);
    assert.deepEqual(JSON.parse(readFileSync(join(f.canonical, "state.json"))).accounts, []);
});

const powershell = process.env.MULTI_VESKTOP_POWERSHELL || (process.platform === "win32" ? "powershell.exe" : "pwsh");
const hasPowershell = spawnSync(powershell, ["-NoProfile", "-Command", "exit 0"]).status === 0;
test("failed Windows process enumeration prevents migration", { skip: !hasPowershell }, t => {
    const f = fixture(t);
    profile(join(f.install, "Data"), "legacy");
    const commands = {
        execFileSync(executable, args, options) {
            if (executable.endsWith("reg.exe")) return "";
            const command = "function Get-CimInstance { Write-Error 'Simulated WMI failure' }; " + args.at(-1);
            return execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], options);
        }
    };
    assert.throws(() => start(f, {}, fs, commands), /Windows could not confirm/);
    assert.throws(() => readFileSync(f.canonical + ".migration-complete"));
});
test(
    "legacy accounts and sessions survive removal of the installation across two updates",
    { skip: !hasPowershell },
    t => {
        const f = fixture(t);
        profile(join(f.install, "Data"), "legacy");
        const manifest = join(f.root, "recovery.json");
        for (let update = 0; update < 2; update++) {
            const result = spawnSync(
                powershell,
                [
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    resolve("build/preserveLegacyData.ps1"),
                    "-InstallDir",
                    f.install,
                    "-ManifestPath",
                    manifest
                ],
                { encoding: "utf8" }
            );
            assert.equal(result.status, 0, result.stdout + result.stderr);
            // Model the old uninstaller's destructive boundary, then reinstall.
            rmSync(f.install, { recursive: true });
            mkdirSync(f.install);
            fs.copyFileSync(manifest, join(f.install, "legacy-data-backups.json"));
            start(f);
            assert.equal(JSON.parse(readFileSync(join(f.canonical, "state.json"))).accounts[0].id, "legacy");
            assert.equal(
                readFileSync(
                    join(f.canonical, "sessionData", "Partitions", "multi-legacy", "Local Storage", "login"),
                    "utf8"
                ),
                "session-legacy"
            );
        }
    }
);
