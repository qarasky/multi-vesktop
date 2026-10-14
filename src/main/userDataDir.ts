/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, dialog } from "electron";
import { mkdirSync } from "fs";
import { dirname, join } from "path";

import { initializeDataDirectory, readBackupManifest } from "./dataMigration";
import { assertLegacyAppClosed, getLegacyUserInstallDir } from "./windowsLegacyData";

// One location in every build. Legacy folders are migration sources, never destinations.
export const USER_DATA_DIR = join(app.getPath("appData"), "multi-vesktop");
export const SESSION_DATA_DIR = join(USER_DATA_DIR, "sessionData");

try {
    initializeDataDirectory(
        USER_DATA_DIR,
        () => {
            const candidates: (string | { dir: string; preferred: boolean })[] = [
                { dir: join(app.getPath("appData"), "Multi Vesktop"), preferred: true },
                { dir: app.getPath("userData"), preferred: true }
            ];
            if (process.platform === "win32") {
                // Read HKCU in the running user's context, not the installer administrator's.
                const userInstall = getLegacyUserInstallDir();
                if (userInstall) candidates.push({ dir: join(userInstall, "Data"), preferred: true });
                const installDir = dirname(process.execPath);
                candidates.push(join(installDir, "Data"), ...readBackupManifest(installDir));
            }
            return candidates;
        },
        process.platform === "win32" ? assertLegacyAppClosed : undefined
    );
    mkdirSync(SESSION_DATA_DIR, { recursive: true });
    app.setPath("userData", USER_DATA_DIR);
    app.setPath("sessionData", SESSION_DATA_DIR);
    // Vencord must use the same root, including the --repair startup path.
    process.env.VENCORD_USER_DATA_DIR = USER_DATA_DIR;
} catch (error) {
    console.error("[multi-vesktop] data initialization failed", error);
    dialog.showErrorBox(
        "Multi Vesktop data migration failed",
        `${error}\n\nYour existing data has been kept. The app will stop to avoid resetting your accounts.`
    );
    app.exit(1);
    throw error;
}
