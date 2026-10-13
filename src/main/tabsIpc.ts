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
    createAccountViews,
    destroyAccount,
    getAccountIdByWebContents,
    getActiveAccountId,
    getTabStatePayload,
    getViewByKey,
    setAccountIdentity,
    setActive,
    updateAccountMeta,
    viewKey
} from "./discordViews";
import { handle, handleSync } from "./utils/ipcWrappers";

const accountIdOf = (key: string) => key.slice(0, key.lastIndexOf(":"));

handleSync(IpcEvents.TAB_GET_STATE, () => getTabStatePayload());

handle(IpcEvents.ACCOUNT_IDENTITY, (e, identity) => {
    const accountId = getAccountIdByWebContents(e.sender);
    if (accountId) setAccountIdentity(accountId, identity);
});

handle(IpcEvents.TAB_SELECT, (_e, key: string) => {
    const accountId = accountIdOf(key);
    if (!getAccount(accountId)) return false;

    const ok = setActive(key);
    if (ok) setLastActive(accountId);

    return ok;
});

handle(IpcEvents.TAB_CREATE, (_e, label?: string) => {
    const account = createAccount(label);
    createAccountViews(account);
    setActive(viewKey(account.id, "discord"));
    setLastActive(account.id);

    return account;
});

handle(IpcEvents.TAB_CLOSE, (_e, accountId: string) => {
    if (!getAccount(accountId)) return;

    const wasActive = getActiveAccountId() === accountId;
    destroyAccount(accountId);

    const isLast = deleteAccount(accountId);

    if (isLast) {
        // Never leave the window account-less: drop in a fresh blank account.
        const replacement = createAccount("Account 1");
        createAccountViews(replacement);
        setActive(viewKey(replacement.id, "discord"));
        setLastActive(replacement.id);
        return;
    }

    if (wasActive) {
        const next = getAccounts()[0];
        if (next) {
            setActive(viewKey(next.id, "discord"));
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

handle(IpcEvents.TAB_OPEN_DEVTOOLS, (_e, key: string) => {
    getViewByKey(key)?.view.webContents.openDevTools({ mode: "detach" });
});
