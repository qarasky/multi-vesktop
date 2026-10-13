/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { AccountIdentity } from "shared/accounts";

/**
 * Reports this view's signed-in account (avatar + display name) to the main
 * process so the tab strip can label the account properly.
 *
 * This runs inside each account's Discord view, where Vencord exposes Discord's
 * user store. Everything is defensive: if the store is not reachable yet (or
 * ever), we simply report nothing and the tab falls back to its label.
 */

interface DiscordUser {
    id?: string;
    username?: string;
    globalName?: string;
    global_name?: string;
    avatar?: string | null;
}

function common(): any {
    return (globalThis as any).Vencord?.Webpack?.Common;
}

function readIdentity(): AccountIdentity | null {
    try {
        const user: DiscordUser | undefined = common()?.UserStore?.getCurrentUser?.();
        if (!user?.id) return null;

        const displayName = user.globalName ?? user.global_name ?? user.username;

        let avatarUrl: string | undefined;
        if (user.avatar) {
            const ext = String(user.avatar).startsWith("a_") ? "gif" : "png";
            avatarUrl = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=64`;
        }

        return {
            id: user.id,
            username: user.username ?? user.id,
            displayName,
            avatarUrl
        };
    } catch {
        return null;
    }
}

let lastReported = "";

function report() {
    try {
        const identity = readIdentity();
        if (!identity) return;

        const json = JSON.stringify(identity);
        if (json === lastReported) return;
        lastReported = json;

        (globalThis as any).VesktopNative?.account?.reportIdentity?.(identity);
    } catch {
        // never let this break Vencord
    }
}

try {
    const flux = common()?.FluxDispatcher;
    for (const event of ["CONNECTION_OPEN", "CURRENT_USER_UPDATE", "USER_UPDATE"]) {
        flux?.subscribe?.(event, report);
    }
} catch {
    // ignore
}

// The store may not exist yet when this runs, and some updates do not dispatch
// the events above, so also poll on a slow interval.
setInterval(report, 5000);
report();
