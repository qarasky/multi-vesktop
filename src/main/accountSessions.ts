/*
 * multi-vesktop, a multi-account fork of Vesktop
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { session, type Session } from "electron";
import { accountPartition } from "shared/accounts";

import { registerMediaPermissionsHandler } from "./mediaPermissions";
import { registerScreenShareHandler } from "./screenShare";
import { Settings } from "./settings";

const registered = new Set<string>();

/**
 * Each account talks over its own session partition, so permissions, screen
 * share and spellchecker languages have to be configured per session rather
 * than on the default session.
 */
export function setupAccountSession(accountId: string) {
    const partition = accountPartition(accountId);
    if (registered.has(partition)) return;

    registered.add(partition);
    const ses = session.fromPartition(partition);

    registerMediaPermissionsHandler(ses);
    registerScreenShareHandler(ses);
    applySpellCheckLanguages(ses);
}

function applySpellCheckLanguages(ses: Session) {
    const languages = Settings.store.spellCheckLanguages;
    if (!languages?.length) return;

    const available = ses.availableSpellCheckerLanguages;
    const applicable = languages.filter(l => available.includes(l)).slice(0, 5);
    if (applicable.length) ses.setSpellCheckerLanguages(applicable);
}

/** Re-applies spellchecker languages to every account session (used when the setting changes). */
export function applySpellCheckLanguagesToAccounts(accountIds: string[]) {
    for (const id of accountIds) {
        applySpellCheckLanguages(session.fromPartition(accountPartition(id)));
    }
}
