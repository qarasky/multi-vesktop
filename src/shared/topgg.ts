/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface TopggButtonPosition {
    x: number;
    y: number;
}

interface Viewport {
    width: number;
    height: number;
}

export const TOPGG_BUTTON_SIZE = 46;
const MARGIN = 8;

export function isTopggButtonPosition(value: unknown): value is TopggButtonPosition {
    if (!value || typeof value !== "object") return false;
    const { x, y } = value as TopggButtonPosition;
    return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1;
}

function bounds(viewport: Viewport) {
    const maxX = Math.max(0, viewport.width - TOPGG_BUTTON_SIZE - MARGIN);
    const maxY = Math.max(0, viewport.height - TOPGG_BUTTON_SIZE - MARGIN);
    return { minX: Math.min(MARGIN, maxX), minY: Math.min(MARGIN, maxY), maxX, maxY };
}

export function getTopggButtonCoordinates(position: unknown, viewport: Viewport): TopggButtonPosition {
    const { minX, minY, maxX, maxY } = bounds(viewport);
    if (!isTopggButtonPosition(position)) {
        return {
            x: Math.max(minX, Math.min(maxX, viewport.width - TOPGG_BUTTON_SIZE - 16)),
            y: Math.max(minY, Math.min(maxY, viewport.height - TOPGG_BUTTON_SIZE - 96))
        };
    }
    return { x: minX + position.x * (maxX - minX), y: minY + position.y * (maxY - minY) };
}

export function normalizeTopggButtonPosition(point: TopggButtonPosition, viewport: Viewport): TopggButtonPosition {
    const { minX, minY, maxX, maxY } = bounds(viewport);
    const clamp = (value: number) => Math.max(0, Math.min(1, value));
    return {
        x: maxX > minX ? clamp((point.x - minX) / (maxX - minX)) : 0,
        y: maxY > minY ? clamp((point.y - minY) / (maxY - minY)) : 0
    };
}
