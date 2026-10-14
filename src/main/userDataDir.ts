/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * Electron derives userData from the app name, which can differ between builds
 * and install modes ("multi-vesktop" vs "Multi Vesktop"). If it ever changes,
 * accounts, Discord sessions and settings silently move to a new folder and the
 * app looks like it was reset after an update.
 *
 * Pin it to one stable location, and adopt whichever existing folder actually
 * holds the accounts so nothing is lost.
 */

interface Candidate {
    dir: string;
    exists: boolean;
    accountCount: number;
    mtime: number;
}

function inspect(dir: string): Candidate {
    const stateFile = join(dir, "state.json");

    let exists = false;
    let accountCount = 0;
    let mtime = 0;

    try {
        exists = existsSync(stateFile) || existsSync(join(dir, "settings.json"));
    } catch {}

    try {
        mtime = statSync(stateFile).mtimeMs;
        const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
        if (Array.isArray(parsed?.accounts)) accountCount = parsed.accounts.length;
    } catch {}

    return { dir, exists, accountCount, mtime };
}

function pickDataDir(): string {
    const appData = app.getPath("appData"); // %APPDATA% on Windows

    const candidates = [join(appData, "multi-vesktop"), join(appData, "Multi Vesktop"), app.getPath("userData")]
        .filter((dir, i, all) => all.indexOf(dir) === i) // de-dupe
        .map(inspect);

    // 1. a folder that actually has accounts
    const withAccounts = candidates.filter(c => c.accountCount > 0).sort((a, b) => b.mtime - a.mtime);
    if (withAccounts.length) return withAccounts[0].dir;

    // 2. any folder with existing data
    const existing = candidates.filter(c => c.exists).sort((a, b) => b.mtime - a.mtime);
    if (existing.length) return existing[0].dir;

    // 3. fresh install -> the canonical folder
    return join(appData, "multi-vesktop");
}

const dir = pickDataDir();

try {
    mkdirSync(dir, { recursive: true });
} catch {}

app.setPath("userData", dir);

export const USER_DATA_DIR = dir;
