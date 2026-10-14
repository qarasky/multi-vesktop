/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, shell, type WebContents, WebContentsView } from "electron";
import { join } from "path";
import { type Account, type AccountIdentity, accountPartition } from "shared/accounts";
import { IpcEvents } from "shared/IpcEvents";

import { getAccount, getAccounts } from "./accounts";
import { setupAccountSession } from "./accountSessions";
import { setActiveWebContentsGetter } from "./activeView";
import { BrowserUserAgent, DISCORD_HOSTNAMES } from "./constants";
import { AppEvents } from "./events";
import { Settings } from "./settings";
import { updateSplashMessage } from "./splash";
import { makeWebContentsOpenLinksExternally } from "./utils/makeLinksOpenExternally";

/** Height reserved at the top of the window for the tab strip. */
export const TAB_STRIP_HEIGHT = 40;
/** Height of the top.gg overlay's header bar. */
const OVERLAY_HEADER_HEIGHT = 36;
/** URL opened by the per-account overlay. */
const OVERLAY_URL = "https://top.gg";

export interface ViewState {
    account: Account;
    view: WebContentsView;
    title: string;
    unread: number;
    favicon?: string;
    crashed: boolean;
    audible: boolean;
    loaded: boolean;
    identity?: AccountIdentity;
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
    displayName?: string;
    username?: string;
    avatarUrl?: string;
    overlayOpen: boolean;
}

export interface TabStatePayload {
    activeId: string | null;
    tabs: TabState[];
}

const views = new Map<string, ViewState>();
const overlays = new Map<string, WebContentsView>();

let activeId: string | null = null;
let overlayId: string | null = null;
let headerView: WebContentsView | null = null;
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

export function getViews(): ViewState[] {
    return [...views.values()];
}

export function getView(accountId: string): ViewState | null {
    return views.get(accountId) ?? null;
}

export function getActiveView(): ViewState | null {
    return activeId ? (views.get(activeId) ?? null) : null;
}

/** The active Discord view (never the top.gg overlay) — used for screen share etc. */
export function getActiveWebContents(): WebContents | null {
    return getActiveView()?.view.webContents ?? null;
}

export function getActiveAccountId(): string | null {
    return activeId;
}

export function getTotalUnread(): number {
    let total = 0;
    for (const view of views.values()) total += view.unread;
    return total;
}

export function createView(account: Account, loadUri?: string): ViewState {
    const existing = views.get(account.id);
    if (existing) return existing;

    const view = new WebContentsView({
        webPreferences: {
            // Vesktop's preload injects Vencord (and our floating top.gg button).
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

    const state: ViewState = {
        account,
        view,
        title: account.label,
        unread: 0,
        crashed: false,
        audible: false,
        loaded: false
    };

    views.set(account.id, state);

    setupAccountSession(account.id);

    view.webContents.setUserAgent(BrowserUserAgent);
    makeWebContentsOpenLinksExternally(view.webContents);
    wireView(state);

    loadView(state, loadUri);
    broadcast();

    return state;
}

function wireView(state: ViewState) {
    const wc = state.view.webContents;

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

function loadView(state: ViewState, uri?: string) {
    state.view.webContents.loadURL(buildDiscordUrl(uri)).catch((error: any) => {
        console.log(`[multi-vesktop] failed to load "${state.account.label}", retrying in ${RETRY_DELAY}ms`);
        updateSplashMessage(`Failed to load Discord: ${error?.code ?? error}`);
        setTimeout(() => loadView(state, uri), RETRY_DELAY);
    });
}

// ---------------------------------------------------------------- child views

function detachAll() {
    if (!win || win.isDestroyed()) return;

    const all: WebContentsView[] = [...views.values()].map(s => s.view);
    all.push(...overlays.values());
    if (headerView) all.push(headerView);

    for (const view of all) {
        try {
            win.contentView.removeChildView(view);
        } catch {}
    }
}

/** (Re)builds the child stack: active Discord view, then overlay content, then overlay header. */
function syncChildren() {
    if (!win || win.isDestroyed()) return;

    detachAll();

    const active = activeId ? views.get(activeId) : null;
    if (active) safeAdd(active.view);

    const content = overlayId ? overlays.get(overlayId) : null;
    if (content) {
        safeAdd(content);
        if (headerView) safeAdd(headerView);
    }

    layout();
}

function safeAdd(view: WebContentsView) {
    try {
        win!.contentView.addChildView(view);
    } catch (e) {
        console.error("[multi-vesktop] failed to add child view", e);
    }
}

export function layout() {
    if (!win || win.isDestroyed()) return;

    const { width, height } = win.getContentBounds();
    const top = TAB_STRIP_HEIGHT;

    const active = activeId ? views.get(activeId) : null;
    active?.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });

    if (overlayId) {
        const contentTop = top + OVERLAY_HEADER_HEIGHT;

        overlays.get(overlayId)?.setBounds({ x: 0, y: contentTop, width, height: Math.max(0, height - contentTop) });
        headerView?.setBounds({ x: 0, y: top, width, height: OVERLAY_HEADER_HEIGHT });
    }
}

// ------------------------------------------------------------------- accounts

export function setActive(id: string): boolean {
    if (!views.has(id) || !win || win.isDestroyed()) return false;

    // switching accounts always returns you to Discord
    overlayId = null;
    if (activeId === id) {
        syncChildren();
        return true;
    }

    activeId = id;
    syncChildren();

    views.get(id)?.view.webContents.focus();
    broadcast();
    return true;
}

export function destroyAccount(accountId: string) {
    if (activeId === accountId) activeId = null;
    if (overlayId === accountId) overlayId = null;

    const state = views.get(accountId);
    views.delete(accountId);

    const overlay = overlays.get(accountId);
    overlays.delete(accountId);

    detachAll();

    if (state && !state.view.webContents.isDestroyed()) state.view.webContents.close();
    if (overlay && !overlay.webContents.isDestroyed()) overlay.webContents.close();

    broadcast();
}

export function updateAccountMeta(account: Account) {
    const state = views.get(account.id);
    if (state) state.account = account;
    broadcast();
}

export function getAccountIdByWebContents(wc: WebContents): string | null {
    for (const state of views.values()) {
        if (state.view.webContents === wc) return state.account.id;
    }
    return null;
}

export function setAccountIdentity(accountId: string, identity: AccountIdentity) {
    const state = views.get(accountId);
    if (!state) return;
    if (JSON.stringify(state.identity) === JSON.stringify(identity)) return;

    state.identity = identity;
    broadcast();
}

// --------------------------------------------------------------- top.gg overlay

function ensureHeader(): WebContentsView {
    if (headerView) return headerView;

    headerView = new WebContentsView({
        webPreferences: {
            preload: join(__dirname, "tabStripPreload.js"),
            contextIsolation: true,
            sandbox: true
        }
    });

    headerView.webContents.loadURL("vesktop://static/views/topggHeader.html").catch(e => {
        console.error("[multi-vesktop] failed to load overlay header", e);
    });

    return headerView;
}

function ensureOverlay(account: Account): WebContentsView {
    const existing = overlays.get(account.id);
    if (existing) return existing;

    const view = new WebContentsView({
        webPreferences: {
            partition: accountPartition(account.id),
            contextIsolation: true,
            sandbox: true,
            devTools: true,
            backgroundThrottling: false
        }
    });

    view.webContents.setUserAgent(BrowserUserAgent);
    view.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const { hostname } = new URL(url);
            if (hostname.endsWith("top.gg") || DISCORD_HOSTNAMES.includes(hostname)) return { action: "allow" };
        } catch {}

        shell.openExternal(url);
        return { action: "deny" };
    });

    overlays.set(account.id, view);
    setupAccountSession(account.id);

    view.webContents.loadURL(OVERLAY_URL).catch(e => console.error("[multi-vesktop] failed to load top.gg", e));

    return view;
}

export function openOverlay(accountId: string) {
    const account = getAccount(accountId);
    if (!account || !win || win.isDestroyed()) return;

    ensureOverlay(account);
    ensureHeader();

    overlayId = accountId;
    syncChildren();

    overlays.get(accountId)?.webContents.focus();
    broadcast();
}

export function closeOverlay() {
    if (!overlayId) return;

    overlayId = null;
    syncChildren();

    if (activeId) views.get(activeId)?.view.webContents.focus();
    broadcast();
}

export function toggleOverlay(accountId: string) {
    if (overlayId === accountId) closeOverlay();
    else openOverlay(accountId);
}

export function isOverlayOpen(accountId: string) {
    return overlayId === accountId;
}

// -------------------------------------------------------------------- payload

export function getTabStatePayload(): TabStatePayload {
    return {
        activeId,
        tabs: getAccounts().map(account => {
            const state = views.get(account.id);

            return {
                id: account.id,
                label: account.label,
                color: account.color,
                title: state?.title ?? account.label,
                unread: state?.unread ?? 0,
                favicon: state?.favicon,
                crashed: state?.crashed ?? false,
                audible: state?.audible ?? false,
                loaded: state?.loaded ?? false,
                displayName: state?.identity?.displayName,
                username: state?.identity?.username,
                avatarUrl: state?.identity?.avatarUrl,
                overlayOpen: overlayId === account.id
            };
        })
    };
}

export function broadcast() {
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IpcEvents.TAB_STATE_UPDATED, getTabStatePayload());
}

// Let other modules (e.g. ipcCommands, screen share) resolve the active view
// without importing this module and creating an import cycle.
setActiveWebContentsGetter(getActiveWebContents);
