/*
 * libvesktop build guard
 * Copyright (c) 2026 Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * libvesktop is a Linux-only helper that emits D-Bus events. Building it
 * requires gio/glib, which does not exist on macOS or Windows. The root build
 * script (copyLibVesktop) already skips it off Linux, so skip the native build
 * here too instead of failing the whole `pnpm install`.
 *
 * On Linux, build it only if the dev headers are present; otherwise fall back
 * to the prebuilt binaries in prebuilds/ (again matching copyLibVesktop).
 */

import { spawnSync } from "node:child_process";

if (process.platform !== "linux") {
    console.log(`[libvesktop] skipped native build on ${process.platform} (Linux-only helper)`);
    process.exit(0);
}

// pkg-config presence is a good proxy for the glib dev headers node-gyp needs.
const hasGio = spawnSync("pkg-config", ["--exists", "gio-2.0"]).status === 0;

if (!hasGio) {
    console.warn("[libvesktop] gio-2.0 not found; skipping native build, will use prebuilt binaries");
    process.exit(0);
}

const result = spawnSync("node-gyp", ["rebuild"], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
