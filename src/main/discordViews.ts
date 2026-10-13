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

/**
 * Each account owns one view per *site*, all sharing that account's session
 * partition. That is what lets a site like top.gg log in "as" the same account:
 * the Discord OAuth flow sees the account's Discord cookies because both live
 * in the same partition.
 */
export type SiteId = "discord" | "topgg";

interface SiteDefinition {
    id: SiteId;
    label: string;
    /** Discord gets Vencord injected; other sites are plain web pages. */
    vencord: boolean;
    url: (uri?: string) => string;
}

export const SITES: SiteDefinition[] = [
    { id: "discord", label: "Discord", vencord: true, url: buildDiscordUrl },
    { id: "topgg", label: "top.gg", vencord: false, url: () => "https://top.gg" }
];

const SITE_BY_ID = new Map(SITES.map(s => [s.id, s]));

/** Height reserved at the top of the window for the two-row tab strip. */
export const TAB_STRIP_HEIGHT = 64;

export const viewKey = (accountId: string, site: SiteId) => `${accountId}:${site}`;

function parseKey(key: string): [string, SiteId] | null {
    const idx = key.lastIndexOf(":");
    if (idx === -1) return null;

    const accountId = key.slice(0, idx);
    const site = key.slice(idx + 1) as SiteId;
    if (!SITE_BY_ID.has(site)) return null;

    return [accountId, site];
}

export interface ViewState {
    account: Account;
    site: SiteId;
    view: WebContentsView;
    title: string;
    unread: number;
    favicon?: string;
    crashed: boolean;
    audible: boolean;
    loaded: boolean;
    identity?: AccountIdentity;
}

export interface SiteState {
    title: string;
    unread: number;
    favicon?: string;
    crashed: boolean;
    audible: boolean;
    loaded: boolean;
    displayName?: string;
    username?: string;
    avatarUrl?: string;
}

export interface TabState {
    id: string;
    label: string;
    color?: string;
    sites: Record<string, SiteState>;
}

export interface TabStatePayload {
    activeKey: string | null;
    activeAccountId: string | null;
    tabs: TabState[];
}

const views = new Map<string, ViewState>();
let activeKey: string | null = null;
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

export function getViewByKey(key: string): ViewState | null {
    return views.get(key) ?? null;
}

export function getActiveView(): ViewState | null {
    return activeKey ? (views.get(activeKey) ?? null) : null;
}

export function getActiveWebContents(): WebContents | null {
    return getActiveView()?.view.webContents ?? null;
}

export function getActiveAccountId(): string | null {
    return activeKey ? (parseKey(activeKey)?.[0] ?? null) : null;
}

export function getTotalUnread(): number {
    let total = 0;
    for (const view of views.values()) total += view.unread;
    return total;
}

function ensureView(account: Account, site: SiteId, loadUri?: string): ViewState {
    const key = viewKey(account.id, site);

    const existing = views.get(key);
    if (existing) return existing;

    const def = SITE_BY_ID.get(site)!;

    const view = new WebContentsView({
        webPreferences: {
            // Vesktop's preload injects Vencord; only meaningful on Discord.
            preload: def.vencord ? join(__dirname, "preload.js") : undefined,
            partition: accountPartition(account.id),
            contextIsolation: true,
            sandbox: true,
            devTools: true,
            spellcheck: true,
            // keep background views receiving messages and notifications
            backgroundThrottling: false
        }
    });

    const state: ViewState = {
        account,
        site,
        view,
        title: def.label,
        unread: 0,
        crashed: false,
        audible: false,
        loaded: false
    };

    views.set(key, state);

    setupAccountSession(account.id);
    wireView(state);

    if (def.vencord) {
        state.view.webContents.setUserAgent(BrowserUserAgent);
        makeWebContentsOpenLinksExternally(state.view.webContents);
    } else {
        wirePlainSite(state.view.webContents);
    }

    loadSite(state, loadUri);
    broadcast();

    return state;
}

/** Sites other than Discord: allow same-site + Discord OAuth popups, external for the rest. */
function wirePlainSite(wc: WebContents) {
    wc.setWindowOpenHandler(({ url }) => {
        try {
            const { hostname } = new URL(url);
            if (hostname.endsWith("top.gg") || DISCORD_HOSTNAMES.includes(hostname)) return { action: "allow" };
        } catch {}

        shell.openExternal(url);
        return { action: "deny" };
    });
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

        if (state.site === "discord") {
            updateSplashMessage("");

            if (!appLoadedEmitted) {
                appLoadedEmitted = true;
                AppEvents.emit("appLoaded");
            }
        }

        broadcast();
    });

    wc.on("did-navigate", (_e, url, responseCode) => {
        if (state.site !== "discord") return;

        updateSplashMessage("");

        // mirror upstream: redirect to the app if Discord sends us somewhere odd
        if (responseCode >= 300) {
            try {
                if (new URL(url).pathname !== "/app") loadSite(state);
            } catch {}
        }
    });

    wc.on("render-process-gone", (_e, details) => {
        console.error(`[multi-vesktop] renderer gone for "${state.account.label}" (${state.site}):`, details);
        state.crashed = true;
        broadcast();
    });
}

const RETRY_DELAY = 1000;

function loadSite(state: ViewState, uri?: string) {
    const def = SITE_BY_ID.get(state.site)!;

    state.view.webContents.loadURL(def.url(uri)).catch((error: any) => {
        console.log(
            `[multi-vesktop] failed to load ${state.site} for "${state.account.label}", retrying in ${RETRY_DELAY}ms`
        );
        if (state.site === "discord") updateSplashMessage(`Failed to load Discord: ${error?.code ?? error}`);
        setTimeout(() => loadSite(state, uri), RETRY_DELAY);
    });
}

export function layout() {
    const state = getActiveView();
    if (!state || !win || win.isDestroyed()) return;

    const { width, height } = win.getContentBounds();
    state.view.setBounds({
        x: 0,
        y: TAB_STRIP_HEIGHT,
        width,
        height: Math.max(0, height - TAB_STRIP_HEIGHT)
    });
}

/** Creates the account's Discord view (and only that one). Other sites are lazy. */
export function createAccountViews(account: Account, discordUri?: string): ViewState {
    return ensureView(account, "discord", discordUri);
}

export function activateAccount(accountId: string): boolean {
    return setActive(viewKey(accountId, "discord"));
}

export function setActive(key: string): boolean {
    const parsed = parseKey(key);
    if (!parsed || !win || win.isDestroyed()) return false;

    const [accountId, site] = parsed;
    const account = getAccount(accountId);
    if (!account) return false;

    const next = ensureView(account, site);
    if (activeKey === key) return true;

    const current = getActiveView();
    if (current && current !== next) {
        try {
            win.contentView.removeChildView(current.view);
        } catch (e) {
            console.error("[multi-vesktop] failed to detach previous view", e);
        }
    }

    activeKey = key;
    win.contentView.addChildView(next.view);
    layout();

    if (!next.view.webContents.isDestroyed()) next.view.webContents.focus();

    broadcast();
    return true;
}

/** Destroys every view belonging to an account. */
export function destroyAccount(accountId: string) {
    const prefix = `${accountId}:`;

    for (const [key, state] of [...views.entries()]) {
        if (!key.startsWith(prefix)) continue;

        if (activeKey === key) {
            if (win && !win.isDestroyed()) {
                try {
                    win.contentView.removeChildView(state.view);
                } catch {}
            }
            activeKey = null;
        }

        views.delete(key);

        if (!state.view.webContents.isDestroyed()) state.view.webContents.close();
    }

    broadcast();
}

export function updateAccountMeta(account: Account) {
    for (const state of views.values()) {
        if (state.account.id === account.id) state.account = account;
    }
    broadcast();
}

export function getAccountIdByWebContents(wc: WebContents): string | null {
    for (const state of views.values()) {
        if (state.view.webContents === wc) return state.account.id;
    }
    return null;
}

export function setAccountIdentity(accountId: string, identity: AccountIdentity) {
    for (const state of views.values()) {
        if (state.account.id !== accountId || state.site !== "discord") continue;
        if (JSON.stringify(state.identity) === JSON.stringify(identity)) continue;

        state.identity = identity;
    }

    broadcast();
}

function siteStateFor(accountId: string, site: SiteId): SiteState {
    const state = views.get(viewKey(accountId, site));

    if (!state) {
        return {
            title: SITE_BY_ID.get(site)!.label,
            unread: 0,
            crashed: false,
            audible: false,
            loaded: false
        };
    }

    return {
        title: state.title,
        unread: state.unread,
        favicon: state.favicon,
        crashed: state.crashed,
        audible: state.audible,
        loaded: state.loaded,
        displayName: state.identity?.displayName,
        username: state.identity?.username,
        avatarUrl: state.identity?.avatarUrl
    };
}

export function getTabStatePayload(): TabStatePayload {
    return {
        activeKey,
        activeAccountId: getActiveAccountId(),
        tabs: getAccounts().map(account => ({
            id: account.id,
            label: account.label,
            color: account.color,
            sites: Object.fromEntries(SITES.map(s => [s.id, siteStateFor(account.id, s.id)]))
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
