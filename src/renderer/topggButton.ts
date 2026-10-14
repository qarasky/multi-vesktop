/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { VesktopLogger } from "./logger";

/**
 * A small floating button inside each Discord view that toggles the account's
 * top.gg overlay. Injected from the Vesktop renderer, which only runs in
 * Discord views, so it never appears on top.gg itself.
 *
 * Lives in a shadow root so Discord's styles can't touch it and ours can't
 * leak out.
 */

const HOST_ID = "multi-vesktop-topgg-host";

function inject() {
    if (document.getElementById(HOST_ID) || !document.body) return;

    const host = document.createElement("div");
    host.id = HOST_ID;
    Object.assign(host.style, {
        position: "fixed",
        right: "16px",
        bottom: "16px",
        zIndex: "2147483000",
        width: "44px",
        height: "44px"
    });

    const root = host.attachShadow({ mode: "closed" });
    const button = document.createElement("button");
    button.title = "Open top.gg";
    button.textContent = "top.gg";
    button.style.cssText = [
        "all: unset",
        "box-sizing: border-box",
        "display: flex",
        "align-items: center",
        "justify-content: center",
        "width: 44px",
        "height: 44px",
        "border-radius: 12px",
        "background: #5865f2",
        "color: #fff",
        "font: 700 10px/1 system-ui, -apple-system, sans-serif",
        "cursor: pointer",
        "box-shadow: 0 4px 14px rgba(0,0,0,.35)",
        "transition: transform .12s ease, background .12s ease"
    ].join(";");

    button.addEventListener("mouseenter", () => (button.style.transform = "scale(1.06)"));
    button.addEventListener("mouseleave", () => (button.style.transform = "scale(1)"));
    button.addEventListener("click", () => {
        (globalThis as any).VesktopNative?.topgg?.toggle?.();
    });

    root.appendChild(button);
    document.body.appendChild(host);
}

// Discord is an SPA; make sure the button comes back if the DOM is rebuilt.
try {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", inject, { once: true });
    } else {
        inject();
    }

    // cheap guard; inject() early-returns when the button is present
    setInterval(inject, 3000);
} catch (e) {
    VesktopLogger.error("Failed to inject top.gg button", e);
}
