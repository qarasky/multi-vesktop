/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash } from "crypto";
import {
    closeSync,
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync
} from "fs";
import { dirname, join, resolve } from "path";

function readState(dir: string) {
    const file = join(dir, "state.json");
    if (!existsSync(file)) return {};
    const state = JSON.parse(readFileSync(file, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error(`Invalid state: ${file}`);
    if (
        state.accounts !== undefined &&
        (!Array.isArray(state.accounts) || state.accounts.some(a => !a || typeof a.id !== "string"))
    ) {
        throw new Error(`Invalid accounts: ${file}`);
    }
    return state;
}

function profile(dir: string) {
    const state = readState(dir);
    const settings = join(dir, "settings.json");
    const stateFile = join(dir, "state.json");
    return {
        dir,
        established: (state.accounts?.length ?? 0) > 0 || Object.hasOwn(state, "firstLaunch"),
        hasData: Object.keys(state).length > 0 || existsSync(settings),
        hasAccounts: (state.accounts?.length ?? 0) > 0,
        mtime: existsSync(stateFile)
            ? statSync(stateFile).mtimeMs
            : existsSync(settings)
              ? statSync(settings).mtimeMs
              : 0
    };
}

function verifyTree(source: string, copy?: string) {
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error(`Cannot migrate a symbolic link: ${source}`);
    if (stat.isDirectory()) {
        for (const entry of readdirSync(source)) verifyTree(join(source, entry), copy && join(copy, entry));
    } else if (stat.isFile()) {
        if (copy) {
            const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
            if (digest(source) !== digest(copy)) throw new Error(`Migration verification failed: ${source}`);
        }
    } else {
        throw new Error(`Cannot migrate a special file: ${source}`);
    }
}

type MigrationSource = string | { dir: string; preferred: boolean };

/** Copy before switching directories; never delete the source or overwrite an established profile. */
export function initializeDataDirectory(
    destination: string,
    candidates: MigrationSource[] | (() => MigrationSource[]),
    beforeCopy?: () => void
) {
    mkdirSync(dirname(destination), { recursive: true });
    // Outside the profile so an intentional Reset app cannot resurrect old logins.
    const marker = `${destination}.migration-complete`;
    let summary = "AppData storage initialized";
    const finish = () => {
        mkdirSync(destination, { recursive: true });
        try {
            writeFileSync(marker, `${summary}\n`, { flag: "wx" });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
    };
    if (profile(destination).established || existsSync(marker)) {
        finish();
        return;
    }
    const lockFile = `${destination}.migration-lock`;
    let lock: number;
    try {
        lock = openSync(lockFile, "wx");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error(
                `A data migration is running or was interrupted. Close all app instances. If this persists, remove ${lockFile} before retrying.`
            );
        }
        throw error;
    }
    try {
        writeFileSync(lock, String(process.pid));
        if (profile(destination).established || existsSync(marker)) {
            finish();
            return;
        }
        const source = (typeof candidates === "function" ? candidates() : candidates)
            .map(source => (typeof source === "string" ? { dir: source, preferred: false } : source))
            .filter(({ dir }) => resolve(dir) !== resolve(destination) && existsSync(dir))
            .map(source => ({ ...profile(source.dir), preferred: source.preferred }))
            .filter(p => p.hasData)
            .sort(
                (a, b) =>
                    Number(b.preferred && b.established) - Number(a.preferred && a.established) ||
                    Number(b.hasAccounts) - Number(a.hasAccounts) ||
                    Number(b.preferred) - Number(a.preferred) ||
                    b.mtime - a.mtime
            )[0];

        if (source) {
            beforeCopy?.();
            verifyTree(source.dir);
            const staging = mkdtempSync(join(dirname(destination), ".multi-vesktop-migrate-"));
            const previous = `${staging}.previous`;
            try {
                cpSync(source.dir, staging, { recursive: true, preserveTimestamps: true });
                verifyTree(source.dir, staging);
                beforeCopy?.();
                if (profile(destination).established || existsSync(marker)) {
                    finish();
                    return;
                }
                if (existsSync(destination)) renameSync(destination, previous);
                try {
                    renameSync(staging, destination);
                } catch (error) {
                    if (existsSync(previous)) renameSync(previous, destination);
                    throw error;
                }
                console.log("[multi-vesktop] migrated data from", source.dir, "to", destination);
                summary = `Migrated from ${source.dir} to ${destination}`;
                if (existsSync(previous)) console.log("[multi-vesktop] retained previous data at", previous);
            } finally {
                rmSync(staging, { recursive: true, force: true });
            }
        }
        finish();
    } finally {
        closeSync(lock);
        rmSync(lockFile);
    }
}

export function readBackupManifest(installDir: string): string[] {
    const file = join(installDir, "legacy-data-backups.json");
    if (!existsSync(file)) return [];
    const backups = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (!Array.isArray(backups) || backups.some(p => typeof p !== "string")) {
        throw new Error(`Invalid recovery manifest: ${file}`);
    }
    return backups;
}
