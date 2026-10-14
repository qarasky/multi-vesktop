import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const powershell = process.env.MULTI_VESKTOP_POWERSHELL || (process.platform === "win32" ? "powershell.exe" : "pwsh");
const available = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]).status === 0;
if (process.platform === "win32" && !available) throw new Error("Windows installer tests require PowerShell");

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), "multi-vesktop-installer-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const install = join(root, "Old Application");
    const manifest = join(root, "manifest.json");
    mkdirSync(install);
    return { root, install, manifest };
}

function preserve(f, extra = []) {
    return spawnSync(
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
            f.manifest,
            ...extra
        ],
        { encoding: "utf8" }
    );
}

const options = { skip: !available && "PowerShell is unavailable (Windows CI runs these tests)" };
test("installer preserves nested session files outside the directory deleted by the old uninstaller", options, t => {
    const f = fixture(t);
    const data = join(f.install, "Data");
    mkdirSync(join(data, "sessionData", "Partitions", "multi-account"), { recursive: true });
    writeFileSync(join(data, "state.json"), '{"accounts":[{"id":"account"}]}');
    writeFileSync(join(data, "sessionData", "Partitions", "multi-account", "Cookies"), Buffer.from([0, 255, 42]));
    const result = preserve(f);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const [backup] = JSON.parse(readFileSync(f.manifest, "utf8").replace(/^\uFEFF/, ""));
    assert.ok(!backup.startsWith(f.install + "/") && !backup.startsWith(f.install + "\\"));
    rmSync(f.install, { recursive: true });
    assert.equal(JSON.parse(readFileSync(join(backup, "state.json"))).accounts[0].id, "account");
    assert.deepEqual(
        readFileSync(join(backup, "sessionData", "Partitions", "multi-account", "Cookies")),
        Buffer.from([0, 255, 42])
    );
});

test("updates retain existing recovery paths when there is no longer a legacy Data folder", options, t => {
    const f = fixture(t);
    const backup = join(f.root, "Existing backup");
    mkdirSync(backup);
    writeFileSync(join(f.install, "legacy-data-backups.json"), JSON.stringify([backup]));
    const result = preserve(f);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(f.manifest, "utf8").replace(/^\uFEFF/, "")), [backup]);
});

test("a clean install writes an empty recovery manifest", options, t => {
    const f = fixture(t);
    const result = preserve(f);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(f.manifest, "utf8").replace(/^\uFEFF/, "")), []);
});

test("a retried update prefers the newest session snapshot when state.json is unchanged", options, t => {
    const f = fixture(t);
    const data = join(f.install, "Data");
    mkdirSync(data);
    writeFileSync(join(data, "state.json"), '{"accounts":[{"id":"account"}]}');
    writeFileSync(join(data, "login"), "old-session");
    assert.equal(preserve(f).status, 0);
    writeFileSync(join(f.install, "legacy-data-backups.json"), readFileSync(f.manifest));
    writeFileSync(join(data, "login"), "new-session");
    const result = preserve(f);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const [latest] = JSON.parse(readFileSync(f.manifest, "utf8").replace(/^\uFEFF/, ""));
    assert.equal(readFileSync(join(latest, "login"), "utf8"), "new-session");
});

test("preservation failure aborts without changing the original data or publishing a manifest", options, t => {
    const f = fixture(t);
    mkdirSync(join(f.install, "Data"));
    writeFileSync(join(f.install, "Data", "state.json"), "original");
    // A file instead of a writable manifest directory forces a real I/O failure.
    writeFileSync(join(f.root, "blocked"), "block");
    f.manifest = join(f.root, "blocked", "manifest.json");
    assert.notEqual(preserve(f).status, 0);
    assert.equal(readFileSync(join(f.install, "Data", "state.json"), "utf8"), "original");
    assert.throws(() => readFileSync(f.manifest));
});

test("both per-machine and previous per-user installations are preserved", options, t => {
    const f = fixture(t);
    const user = join(f.root, "Per user application");
    for (const dir of [f.install, user]) {
        mkdirSync(join(dir, "Data"), { recursive: true });
        writeFileSync(join(dir, "Data", "state.json"), JSON.stringify({ accounts: [{ id: dir }] }));
    }
    const result = preserve(f, ["-UserInstallDir", user, "-MachineInstallDir", f.install]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(readFileSync(f.manifest, "utf8").replace(/^\uFEFF/, "")).length, 2);
});
