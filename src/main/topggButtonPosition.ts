/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { webContents } from "electron";
import { IpcEvents } from "shared/IpcEvents";
import { isTopggButtonPosition } from "shared/topgg";

import { State } from "./settings";

export function getTopggButtonPosition() {
    const position = State.store.topggButtonPosition;
    return isTopggButtonPosition(position) ? { x: position.x, y: position.y } : undefined;
}

export function setTopggButtonPosition(value: unknown) {
    if (!isTopggButtonPosition(value)) throw new Error("Invalid top.gg button position");
    const position = { x: value.x, y: value.y };
    State.store.topggButtonPosition = position;
    for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed()) contents.send(IpcEvents.TOPGG_BUTTON_POSITION_CHANGED, position);
    }
}
