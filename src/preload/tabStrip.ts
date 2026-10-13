/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { contextBridge, ipcRenderer } from "electron/renderer";

import { IpcEvents } from "../shared/IpcEvents";

export interface TabState {
    id: string;
    label: string;
    color?: string;
    title: string;
    unread: number;
    favicon?: string;
    crashed: boolean;
    audible: boolean;
    loaded: boolean;
}

export interface TabStatePayload {
    activeId: string | null;
    tabs: TabState[];
}

const api = {
    getState: () => ipcRenderer.sendSync(IpcEvents.TAB_GET_STATE) as TabStatePayload,
    select: (id: string) => ipcRenderer.invoke(IpcEvents.TAB_SELECT, id) as Promise<boolean>,
    create: (label?: string) => ipcRenderer.invoke(IpcEvents.TAB_CREATE, label),
    close: (id: string) => ipcRenderer.invoke(IpcEvents.TAB_CLOSE, id) as Promise<void>,
    rename: (id: string, label: string) => ipcRenderer.invoke(IpcEvents.TAB_RENAME, id, label) as Promise<void>,
    move: (id: string, index: number) => ipcRenderer.invoke(IpcEvents.TAB_MOVE, id, index) as Promise<void>,
    openDevtools: (id: string) => ipcRenderer.invoke(IpcEvents.TAB_OPEN_DEVTOOLS, id) as Promise<void>,
    onState: (cb: (state: TabStatePayload) => void) => {
        ipcRenderer.on(IpcEvents.TAB_STATE_UPDATED, (_e, state) => cb(state as TabStatePayload));
    },
    platform: process.platform
};

contextBridge.exposeInMainWorld("MultiVesktop", api);

export type MultiVesktopApi = typeof api;
