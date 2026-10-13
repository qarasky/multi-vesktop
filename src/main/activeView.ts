/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { WebContents } from "electron";

/**
 * Indirection so modules that need "the active Discord view" (e.g. ipcCommands)
 * do not have to import discordViews, which would create an import cycle with
 * the screen-share / session code. discordViews registers the getter at load.
 */
let getter: (() => WebContents | null) | null = null;

export function setActiveWebContentsGetter(fn: () => WebContents | null) {
    getter = fn;
}

export function getActiveWebContents(): WebContents | null {
    return getter?.() ?? null;
}
