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

// top.gg's own mark, downloaded from https://top.gg/logo.svg (white fill).
// Kept inline so it needs no network request or file access at runtime.
const TOPGG_LOGO = `
<svg width="22" height="22" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M15 2.88316H5.47314V12.5816H7.41964C8.16672 12.5816 8.88323 12.2794 9.41152 11.7416C9.9398 11.2038 10.2366 10.4744 10.2366 9.71387V7.73236H12.1831C12.9301 7.73236 13.6467 7.43022 14.1749 6.89245C14.7032 6.35465 15 5.62524 15 4.86468V2.88316Z" fill="white"/>
    <path d="M0 2.88316H4.76343V7.73236H1.45561C1.07085 7.73236 0.70185 7.57677 0.429763 7.29978C0.157677 7.02279 0.00483651 6.64715 0.00483651 6.25546L0 2.88316Z" fill="white"/>
</svg>`;

function inject() {
    if (document.getElementById(HOST_ID) || !document.body) return;

    const host = document.createElement("div");
    host.id = HOST_ID;
    Object.assign(host.style, {
        position: "fixed",
        right: "16px",
        bottom: "16px",
        zIndex: "2147483000",
        width: "46px",
        height: "46px"
    });

    const root = host.attachShadow({ mode: "closed" });
    const button = document.createElement("button");
    button.title = "Open top.gg";
    button.style.cssText = [
        "all: unset",
        "box-sizing: border-box",
        "display: flex",
        "align-items: center",
        "justify-content: center",
        "width: 46px",
        "height: 46px",
        "border-radius: 50%",
        "background: linear-gradient(135deg, #5b6cff 0%, #3b82f6 100%)",
        "box-shadow: 0 4px 14px rgba(0,0,0,.4)",
        "cursor: pointer",
        "transition: transform .12s ease, box-shadow .12s ease"
    ].join(";");
    button.innerHTML = TOPGG_LOGO;

    button.addEventListener("mouseenter", () => {
        button.style.transform = "scale(1.07)";
        button.style.boxShadow = "0 6px 18px rgba(0,0,0,.45)";
    });
    button.addEventListener("mouseleave", () => {
        button.style.transform = "scale(1)";
        button.style.boxShadow = "0 4px 14px rgba(0,0,0,.4)";
    });
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
