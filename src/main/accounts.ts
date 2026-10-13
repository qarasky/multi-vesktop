/*
 * multi-vesktop, a multi-account fork of Vesktop
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "crypto";
import type { Account } from "shared/accounts";
import { colorForIndex } from "shared/accounts";

import { State } from "./settings";

/**
 * The account list lives in Vesktop's State store. NOTE: SettingsStore only
 * persists on property assignment, so every mutation must reassign
 * `State.store.accounts` rather than mutate the array in place.
 */
function getStored(): Account[] {
    return State.store.accounts ?? [];
}

export function getAccounts(): Account[] {
    return getStored();
}

export function getAccount(id: string): Account | undefined {
    return getStored().find(a => a.id === id);
}

function commit(accounts: Account[]) {
    State.store.accounts = accounts;
}

export function createAccount(label?: string, color?: string): Account {
    const accounts = [...getStored()];

    const account: Account = {
        id: randomUUID(),
        label: label?.trim() || `Account ${accounts.length + 1}`,
        color: color ?? colorForIndex(accounts.length)
    };

    accounts.push(account);
    commit(accounts);

    return account;
}

export function renameAccount(id: string, label: string) {
    const trimmed = label.trim();
    if (!trimmed) return;

    commit(getStored().map(a => (a.id === id ? { ...a, label: trimmed } : a)));
}

export function setAccountColor(id: string, color: string) {
    commit(getStored().map(a => (a.id === id ? { ...a, color } : a)));
}

export function moveAccount(id: string, toIndex: number) {
    const accounts = [...getStored()];
    const from = accounts.findIndex(a => a.id === id);
    if (from === -1) return;

    const [account] = accounts.splice(from, 1);
    accounts.splice(Math.max(0, Math.min(toIndex, accounts.length)), 0, account);

    commit(accounts);
}

/**
 * Removes an account. Returns true if it was the last one (so the caller can
 * decide whether to keep the window open / create a replacement).
 */
export function deleteAccount(id: string): boolean {
    const accounts = getStored().filter(a => a.id !== id);
    commit(accounts);

    if (State.store.lastActiveAccountId === id) {
        State.store.lastActiveAccountId = accounts[0]?.id;
    }

    return accounts.length === 0;
}

export function setLastActive(id: string) {
    State.store.lastActiveAccountId = id;
}
