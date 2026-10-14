/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    getTopggButtonCoordinates,
    isTopggButtonPosition,
    normalizeTopggButtonPosition,
    type TopggButtonPosition
} from "shared/topgg";

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
const native = globalThis.VesktopNative?.topgg;
let position: TopggButtonPosition | undefined;
let renderPosition = () => {};
let dragging = false;

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

native?.onButtonPositionChanged?.(value => {
    if (!isTopggButtonPosition(value) || dragging) return;
    position = value;
    renderPosition();
});
window.addEventListener("resize", () => renderPosition());

// top.gg's own mark, downloaded from https://top.gg/logo.svg (white fill).
// Kept inline so it needs no network request or file access at runtime.
const TOPGG_LOGO = `
<svg width="22" height="22" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M15 2.88316H5.47314V12.5816H7.41964C8.16672 12.5816 8.88323 12.2794 9.41152 11.7416C9.9398 11.2038 10.2366 10.4744 10.2366 9.71387V7.73236H12.1831C12.9301 7.73236 13.6467 7.43022 14.1749 6.89245C14.7032 6.35465 15 5.62524 15 4.86468V2.88316Z" fill="white"/>
    <path d="M0 2.88316H4.76343V7.73236H1.45561C1.07085 7.73236 0.70185 7.57677 0.429763 7.29978C0.157677 7.02279 0.00483651 6.64715 0.00483651 6.25546L0 2.88316Z" fill="white"/>
</svg>`;

function inject() {
    if (document.getElementById(HOST_ID) || !document.body) return;

    // A removed capture target sends lostpointercapture to document, not its
    // former button. Discard any unfinished drag when rebuilding the host.
    dragging = false;
    position = native?.getButtonPosition?.();

    const host = document.createElement("div");
    host.id = HOST_ID;
    Object.assign(host.style, {
        position: "fixed",
        WebkitAppRegion: "no-drag",
        zIndex: "2147483000",
        width: "46px",
        height: "46px"
    });

    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent =
        "button { all: unset; } button:focus-visible { outline: 2px solid white; outline-offset: 3px; }";
    root.appendChild(style);
    const button = document.createElement("button");
    button.title = "top.gg — click to open, drag to move";
    button.setAttribute("aria-label", "Open top.gg; drag to move");
    button.style.cssText = [
        "box-sizing: border-box",
        "display: flex",
        "align-items: center",
        "justify-content: center",
        "width: 46px",
        "height: 46px",
        "border-radius: 50%",
        "background: linear-gradient(135deg, #5b6cff 0%, #3b82f6 100%)",
        "box-shadow: 0 4px 14px rgba(0,0,0,.4)",
        "cursor: grab",
        "touch-action: none",
        "user-select: none",
        "-webkit-app-region: no-drag",
        "transition: transform .12s ease, box-shadow .12s ease"
    ].join(";");
    button.innerHTML = TOPGG_LOGO;

    renderPosition = () => {
        const point = getTopggButtonCoordinates(position, viewport());
        host.style.left = `${point.x}px`;
        host.style.top = `${point.y}px`;
    };
    renderPosition();

    let gesture:
        | {
              id: number;
              x: number;
              y: number;
              left: number;
              top: number;
              original: TopggButtonPosition | undefined;
              moved: boolean;
          }
        | undefined;
    let suppressClick = false;

    button.addEventListener("pointerdown", event => {
        if (event.button !== 0 || !event.isPrimary || gesture) return;
        event.preventDefault();
        button.focus({ preventScroll: true });
        const rect = host.getBoundingClientRect();
        gesture = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: rect.left,
            top: rect.top,
            original: position,
            moved: false
        };
        suppressClick = false;
        button.setPointerCapture(event.pointerId);
    });
    button.addEventListener("pointermove", event => {
        if (!gesture || gesture.id !== event.pointerId) return;
        const dx = event.clientX - gesture.x;
        const dy = event.clientY - gesture.y;
        if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
        gesture.moved = true;
        dragging = true;
        button.style.cursor = "grabbing";
        button.style.transform = "scale(1)";
        position = normalizeTopggButtonPosition({ x: gesture.left + dx, y: gesture.top + dy }, viewport());
        renderPosition();
    });
    const finish = (event: PointerEvent, cancelled: boolean) => {
        if (!gesture || gesture.id !== event.pointerId) return;
        const previous = gesture;
        gesture = undefined;
        dragging = false;
        suppressClick = previous.moved;
        button.style.cursor = "grab";
        if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
        if (cancelled) {
            position = previous.original;
            renderPosition();
        } else if (previous.moved && position) {
            native
                ?.setButtonPosition?.(position)
                .catch(error => VesktopLogger.error("Failed to save top.gg position", error));
        }
    };
    button.addEventListener("pointerup", event => finish(event, false));
    button.addEventListener("pointercancel", event => finish(event, true));
    button.addEventListener("lostpointercapture", event => finish(event, true));

    button.addEventListener("mouseenter", () => {
        if (!dragging) button.style.transform = "scale(1.07)";
        button.style.boxShadow = "0 6px 18px rgba(0,0,0,.45)";
    });
    button.addEventListener("mouseleave", () => {
        button.style.transform = "scale(1)";
        button.style.boxShadow = "0 4px 14px rgba(0,0,0,.4)";
    });
    button.addEventListener("click", event => {
        if (suppressClick && event.detail !== 0) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        native?.toggle?.();
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
