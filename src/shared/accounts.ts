/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * An account is just an identity mapping to its own Chromium session partition.
 * The partition is what gives two logins behind the same discord.com origin
 * separate cookies, localStorage, IndexedDB and cache.
 */
export interface Account {
    id: string;
    label: string;
    /** Tab accent colour. */
    color?: string;
}

/** The signed-in identity of an account, reported from inside its Discord view. */
export interface AccountIdentity {
    id: string;
    username: string;
    displayName?: string;
    avatarUrl?: string;
}

/** Prefix for the persist: partition of an account session. */
export const ACCOUNT_PARTITION_PREFIX = "persist:multi-";

export function accountPartition(id: string) {
    return ACCOUNT_PARTITION_PREFIX + id;
}

/** Palette used for new tabs, cycled by index. */
export const TAB_COLORS = [
    "#5865f2", // blurple
    "#2ea043", // green
    "#e0a020", // amber
    "#eb459e", // fuchsia
    "#00a8fc", // sky
    "#ed4245", // red
    "#9b59b6", // violet
    "#1abc9c" // teal
];

export function colorForIndex(index: number) {
    return TAB_COLORS[index % TAB_COLORS.length];
}
