/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcEvents } from "shared/IpcEvents";

import {
    createAccount,
    deleteAccount,
    getAccount,
    getAccounts,
    moveAccount,
    renameAccount,
    setLastActive
} from "./accounts";
import {
    broadcast,
    closeOverlay,
    createView,
    destroyAccount,
    getAccountIdByWebContents,
    getActiveAccountId,
    getTabStatePayload,
    getView,
    reloadVisibleView,
    setAccountIdentity,
    setActive,
    toggleOverlay,
    updateAccountMeta
} from "./discordViews";
import { getTopggButtonPosition, setTopggButtonPosition } from "./topggButtonPosition";
import { handle, handleSync } from "./utils/ipcWrappers";

handleSync(IpcEvents.TAB_GET_STATE, () => getTabStatePayload());
handle(IpcEvents.VIEW_RELOAD, () => reloadVisibleView());

handle(IpcEvents.ACCOUNT_IDENTITY, (e, identity) => {
    const accountId = getAccountIdByWebContents(e.sender);
    if (accountId) setAccountIdentity(accountId, identity);
});

handle(IpcEvents.TAB_SELECT, (_e, id: string) => {
    if (!getAccount(id)) return false;

    const ok = setActive(id);
    if (ok) setLastActive(id);

    return ok;
});

handle(IpcEvents.TAB_CREATE, (_e, label?: string) => {
    const account = createAccount(label);
    createView(account);
    setActive(account.id);
    setLastActive(account.id);

    return account;
});

handle(IpcEvents.TAB_CLOSE, (_e, id: string) => {
    if (!getAccount(id)) return;

    const wasActive = getActiveAccountId() === id;
    destroyAccount(id);

    const isLast = deleteAccount(id);

    if (isLast) {
        // Never leave the window account-less: drop in a fresh blank account.
        const replacement = createAccount("Account 1");
        createView(replacement);
        setActive(replacement.id);
        setLastActive(replacement.id);
        return;
    }

    if (wasActive) {
        const next = getAccounts()[0];
        if (next) {
            setActive(next.id);
            setLastActive(next.id);
        }
    }
});

handle(IpcEvents.TAB_RENAME, (_e, id: string, label: string) => {
    renameAccount(id, label);

    const account = getAccount(id);
    if (account) updateAccountMeta(account);
});

handle(IpcEvents.TAB_MOVE, (_e, id: string, index: number) => {
    moveAccount(id, index);
    broadcast();
});

handle(IpcEvents.TAB_OPEN_DEVTOOLS, (_e, id: string) => {
    getView(id)?.view.webContents.openDevTools({ mode: "detach" });
});

// Floating button inside the Discord view toggles that account's top.gg overlay.
handle(IpcEvents.TOPGG_TOGGLE, e => {
    const accountId = getAccountIdByWebContents(e.sender);
    if (accountId) toggleOverlay(accountId);
});

// "Back to Discord" in the overlay header closes it.
handle(IpcEvents.TOPGG_CLOSE, () => closeOverlay());

handleSync(IpcEvents.TOPGG_GET_BUTTON_POSITION, () => getTopggButtonPosition());
handle(IpcEvents.TOPGG_SET_BUTTON_POSITION, (_e, position: unknown) => setTopggButtonPosition(position));
