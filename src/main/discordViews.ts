/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, WebContents, WebContentsView } from "electron";
import { join } from "path";
import { type Account, accountPartition } from "shared/accounts";
import { IpcEvents } from "shared/IpcEvents";

import { setupAccountSession } from "./accountSessions";
import { setActiveWebContentsGetter } from "./activeView";
import { BrowserUserAgent } from "./constants";
import { AppEvents } from "./events";
import { Settings } from "./settings";
import { updateSplashMessage } from "./splash";
import { makeWebContentsOpenLinksExternally } from "./utils/makeLinksOpenExternally";

/** Height reserved at the top of the window for the tab strip. */
export const TAB_STRIP_HEIGHT = 40;

export interface TabView {
    account: Account;
    view: WebContentsView;
    title: string;
    unread: number;
    favicon?: string;
    crashed: boolean;
    audible: boolean;
    loaded: boolean;
}

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

const tabs = new Map<string, TabView>();
let activeId: string | null = null;
let win: BrowserWindow | null = null;
let appLoadedEmitted = false;

export function initDiscordViews(browserWindow: BrowserWindow) {
    win = browserWindow;

    const relayout = () => layout();
    browserWindow.on("resize", relayout);
    browserWindow.on("maximize", relayout);
    browserWindow.on("unmaximize", relayout);
    browserWindow.on("enter-full-screen", relayout);
    browserWindow.on("leave-full-screen", relayout);
}

export function getTabs(): TabView[] {
    return [...tabs.values()];
}

export function getActiveTab(): TabView | null {
    return activeId ? (tabs.get(activeId) ?? null) : null;
}

export function getActiveWebContents(): WebContents | null {
    return getActiveTab()?.view.webContents ?? null;
}

export function getActiveAccountId(): string | null {
    return activeId;
}

export function getTotalUnread(): number {
    let total = 0;
    for (const tab of tabs.values()) total += tab.unread;
    return total;
}

export function buildDiscordUrl(uri?: string) {
    const branch = Settings.store.discordBranch;
    const subdomain = branch === "canary" || branch === "ptb" ? `${branch}.` : "";
    const path = uri ? new URL(uri).pathname.slice(1) || "app" : "app";

    return `https://${subdomain}discord.com/${path}`;
}

function parseUnread(title: string) {
    const match = /^\((\d+)\)/.exec(title);
    return match ? Number(match[1]) : 0;
}

export function createView(account: Account, loadUri?: string): TabView {
    const existing = tabs.get(account.id);
    if (existing) return existing;

    const view = new WebContentsView({
        webPreferences: {
            // Vesktop's preload injects Vencord per webContents, so each account view
            // gets Vencord independently without touching the injection path.
            preload: join(__dirname, "preload.js"),
            partition: accountPartition(account.id),
            contextIsolation: true,
            sandbox: true,
            devTools: true,
            spellcheck: true,
            // keep background accounts receiving messages and notifications
            backgroundThrottling: false
        }
    });

    const state: TabView = {
        account,
        view,
        title: account.label,
        unread: 0,
        crashed: false,
        audible: false,
        loaded: false
    };

    tabs.set(account.id, state);

    setupAccountSession(account.id);
    wireView(state);
    loadView(state, loadUri);
    broadcast();

    return state;
}

function wireView(state: TabView) {
    const wc = state.view.webContents;

    wc.setUserAgent(BrowserUserAgent);
    makeWebContentsOpenLinksExternally(wc);

    wc.on("page-title-updated", (_e, title) => {
        state.title = title;
        state.unread = parseUnread(title);
        broadcast();
    });

    wc.on("page-favicon-updated", (_e, favicons) => {
        state.favicon = favicons[0];
        broadcast();
    });

    wc.on("audio-state-changed", event => {
        state.audible = event.audible;
        broadcast();
    });

    wc.on("context-menu", (_e, params) => {
        wc.send(IpcEvents.SPELLCHECK_RESULT, params.misspelledWord, params.dictionarySuggestions);
    });

    wc.on("devtools-opened", () => wc.send(IpcEvents.DEVTOOLS_OPENED));
    wc.on("devtools-closed", () => wc.send(IpcEvents.DEVTOOLS_CLOSED));

    wc.on("did-start-loading", () => {
        state.crashed = false;
    });

    wc.on("did-finish-load", () => {
        state.loaded = true;
        updateSplashMessage("");

        if (!appLoadedEmitted) {
            appLoadedEmitted = true;
            AppEvents.emit("appLoaded");
        }

        broadcast();
    });

    wc.on("did-navigate", (_e, url, responseCode) => {
        updateSplashMessage("");

        // mirror upstream: redirect to the app if Discord sends us somewhere odd
        if (responseCode >= 300) {
            try {
                if (new URL(url).pathname !== "/app") loadView(state);
            } catch {}
        }
    });

    wc.on("render-process-gone", (_e, details) => {
        console.error(`[multi-vesktop] renderer gone for "${state.account.label}":`, details);
        state.crashed = true;
        broadcast();
    });
}

const RETRY_DELAY = 1000;

function loadView(state: TabView, uri?: string) {
    state.view.webContents.loadURL(buildDiscordUrl(uri)).catch((error: any) => {
        console.log(`[multi-vesktop] failed to load "${state.account.label}", retrying in ${RETRY_DELAY}ms`);
        updateSplashMessage(`Failed to load Discord: ${error?.code ?? error}`);
        setTimeout(() => loadView(state, uri), RETRY_DELAY);
    });
}

export function layout() {
    const state = getActiveTab();
    if (!state || !win || win.isDestroyed()) return;

    const { width, height } = win.getContentBounds();
    state.view.setBounds({
        x: 0,
        y: TAB_STRIP_HEIGHT,
        width,
        height: Math.max(0, height - TAB_STRIP_HEIGHT)
    });
}

export function setActive(id: string): boolean {
    const next = tabs.get(id);
    if (!next || !win || win.isDestroyed()) return false;
    if (activeId === id) return true;

    const current = getActiveTab();
    if (current && current !== next) {
        try {
            win.contentView.removeChildView(current.view);
        } catch (e) {
            console.error("[multi-vesktop] failed to detach previous view", e);
        }
    }

    activeId = id;
    win.contentView.addChildView(next.view);
    layout();

    if (!next.view.webContents.isDestroyed()) next.view.webContents.focus();

    broadcast();
    return true;
}

export function destroyView(id: string) {
    const state = tabs.get(id);
    if (!state) return;

    if (activeId === id) {
        if (win && !win.isDestroyed()) {
            try {
                win.contentView.removeChildView(state.view);
            } catch {}
        }
        activeId = null;
    }

    tabs.delete(id);

    if (!state.view.webContents.isDestroyed()) {
        state.view.webContents.close();
    }

    broadcast();
}

export function updateAccountMeta(account: Account) {
    const state = tabs.get(account.id);
    if (!state) return;

    state.account = account;
    broadcast();
}

export function getTabStatePayload(): TabStatePayload {
    return {
        activeId,
        tabs: getTabs().map(t => ({
            id: t.account.id,
            label: t.account.label,
            color: t.account.color,
            title: t.title,
            unread: t.unread,
            favicon: t.favicon,
            crashed: t.crashed,
            audible: t.audible,
            loaded: t.loaded
        }))
    };
}

export function broadcast() {
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IpcEvents.TAB_STATE_UPDATED, getTabStatePayload());
}

// Let other modules (e.g. ipcCommands, screen share) resolve the active view
// without importing this module and creating an import cycle.
setActiveWebContentsGetter(getActiveWebContents);
