/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFileSync } from "child_process";
import { join } from "path";

const systemDir = join(process.env.SystemRoot || "C:\\Windows", "System32");
// Pin the same GUID in package.json so the registry key survives branding changes.
const registryKey = "HKCU\\Software\\5703248c-79de-57a9-b087-061b96cfed2e";

export function getLegacyUserInstallDir(): string | undefined {
    try {
        const output = execFileSync(join(systemDir, "reg.exe"), ["query", registryKey, "/v", "InstallLocation"], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 15000
        });
        return /^\s*InstallLocation\s+REG_SZ\s+(.+)$/m.exec(output)?.[1].trim();
    } catch (error) {
        // A missing HKCU key is normal for fresh and per-machine installations.
        if ((error as { status?: number }).status !== 1) throw error;
    }
}

export function assertLegacyAppClosed() {
    const command = `$ErrorActionPreference = 'Stop'; $running = @(Get-CimInstance Win32_Process -Filter "Name='multi-vesktop.exe'" | Where-Object { $_.ProcessId -ne ${process.pid} }); if ($running.Count -gt 0) { exit 1 }`;
    try {
        execFileSync(
            join(systemDir, "WindowsPowerShell", "v1.0", "powershell.exe"),
            ["-NoProfile", "-NonInteractive", "-Command", command],
            {
                windowsHide: true,
                timeout: 15000,
                stdio: "pipe"
            }
        );
    } catch (error) {
        throw new Error(
            "Close all running Multi Vesktop instances before migrating account data. Windows could not confirm that the old app is closed.",
            { cause: error }
        );
    }
}
