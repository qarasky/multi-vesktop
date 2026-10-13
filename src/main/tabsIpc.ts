/*
 * multi-vesktop, a multi-account fork of Vesktop
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcEvents } from "shared/IpcEvents";

import { createAccount, deleteAccount, getAccount, getAccounts, moveAccount, renameAccount, setLastActive } from "./accounts";
import {
    createView,
    destroyView,
    getActiveAccountId,
    getTabStatePayload,
    getTabs,
    setActive,
    updateAccountMeta
} from "./discordViews";
import { handle, handleSync } from "./utils/ipcWrappers";

handleSync(IpcEvents.TAB_GET_STATE, () => getTabStatePayload());

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
    destroyView(id);

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
});

handle(IpcEvents.TAB_OPEN_DEVTOOLS, (_e, id: string) => {
    getTabs()
        .find(t => t.account.id === id)
        ?.view.webContents.openDevTools({ mode: "detach" });
});
