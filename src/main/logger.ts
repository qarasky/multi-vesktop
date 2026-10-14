/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, shell, type WebContents } from "electron";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "fs";
import { join } from "path";

import { DATA_DIR, SESSION_DATA_DIR } from "./constants";

/**
 * File logging for support/debugging.
 *
 * - One log file per 12-hour session, named `multi-vesktop_<date>_<0000|1200>.log`.
 * - Files older than 3 days are pruned automatically.
 * - Logs go to `Documents/Multi Vesktop/logs`, falling back to the app's own
 *   data dir if Documents is not writable (e.g. macOS denies access).
 * - Captures all renderer console levels and lifecycle events silently in
 *   separate *_views.log files. Debug mode also echoes them to the terminal.
 * - View logs are buffered, with 10 MiB files and two rotating backups per
 *   12-hour session. Both main and view logs use the same 3-day retention.
 *
 * Debug mode can be enabled with `--debug` or `MULTI_VESKTOP_DEBUG=1`.
 */

type Level = "debug" | "info" | "warn" | "error";

const SESSION_HOURS = 12;
const RETENTION_DAYS = 3;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const VIEW_LOG_MAX_BYTES = 10 * 1024 * 1024;
const VIEW_LOG_BATCH_BYTES = 64 * 1024;
const VIEW_LOG_MAX_MESSAGE_LENGTH = 16 * 1024;
const VIEW_LOG_FLUSH_MS = 250;

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
};

let minLevel: Level = isDebugEnabled() ? "debug" : "info";
let logDir: string | null = null;
let logDirResolved = false;
let currentSession = 0;
let currentFile: string | null = null;
let lastCleanup = 0;

interface ViewLogContext {
    id: number;
    label: string;
    url: string;
}

const viewContexts = new WeakMap<WebContents, ViewLogContext>();
let viewLines: string[] = [];
let viewBytes = 0;
let viewFlushTimer: ReturnType<typeof setTimeout> | null = null;

export function isDebugEnabled(): boolean {
    return process.argv.includes("--debug") || process.env.MULTI_VESKTOP_DEBUG === "1";
}

function candidateDirs(): string[] {
    const dirs: string[] = [];

    try {
        dirs.push(join(app.getPath("documents"), "Multi Vesktop", "logs"));
    } catch {}
    try {
        dirs.push(join(app.getPath("userData"), "logs"));
    } catch {}

    return dirs;
}

function getLogDir(): string | null {
    if (logDirResolved) return logDir;
    logDirResolved = true;

    for (const dir of candidateDirs()) {
        try {
            mkdirSync(dir, { recursive: true });

            // probe writability so a readonly/denied folder falls through
            const probe = join(dir, ".write-test");
            appendFileSync(probe, "");
            unlinkSync(probe);

            logDir = dir;
            break;
        } catch {
            // try the next candidate
        }
    }

    if (!logDir) original.error("[multi-vesktop] no writable log directory found; file logging disabled");

    return logDir;
}

function sessionStart(now = Date.now()): number {
    const d = new Date(now);
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() < SESSION_HOURS ? 0 : SESSION_HOURS);
    return d.getTime();
}

function fileNameFor(start: number): string {
    const d = new Date(start);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `multi-vesktop_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}00.log`;
}

function cleanupOldLogs(dir: string) {
    if (Date.now() - lastCleanup < CLEANUP_INTERVAL_MS) return;
    lastCleanup = Date.now();

    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

    try {
        for (const name of readdirSync(dir)) {
            if (!name.startsWith("multi-vesktop_") || !name.endsWith(".log")) continue;

            const file = join(dir, name);
            try {
                if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
            } catch {}
        }
    } catch {}
}

function getFile(): string | null {
    const dir = getLogDir();
    if (!dir) return null;

    const start = sessionStart();
    if (start !== currentSession || !currentFile) {
        currentSession = start;
        currentFile = join(dir, fileNameFor(start));
        cleanupOldLogs(dir);
    }

    return currentFile;
}

function format(args: unknown[]): string {
    return args
        .map(a => {
            if (typeof a === "string") return a;
            if (a instanceof Error) return a.stack || a.message;
            if (a === undefined) return "undefined";
            try {
                return JSON.stringify(a);
            } catch {
                return String(a);
            }
        })
        .join(" ");
}

function emit(level: Level, args: unknown[]) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

    const file = getFile();
    if (!file) return;

    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${format(args)}\n`;
    try {
        appendFileSync(file, line);
    } catch {}
}

/** Explicit log call. Writes to the file and echoes to the console. */
export function log(level: Level, ...args: unknown[]) {
    emit(level, args);

    const sink = level === "error" ? original.error : level === "warn" ? original.warn : original.log;
    sink(format(args));
}

/** Routes existing console.* calls into the log file too. */
function installConsoleCapture() {
    console.log = (...a: unknown[]) => {
        emit("info", a);
        original.log(...a);
    };
    console.info = (...a: unknown[]) => {
        emit("info", a);
        original.info(...a);
    };
    console.warn = (...a: unknown[]) => {
        emit("warn", a);
        original.warn(...a);
    };
    console.error = (...a: unknown[]) => {
        emit("error", a);
        original.error(...a);
    };
}

function shortUrl(url: string): string {
    try {
        const u = new URL(url);
        if (u.protocol === "http:" || u.protocol === "https:") return u.origin + u.pathname;
        if (u.protocol === "file:") return u.pathname;
        return u.pathname || url;
    } catch {
        return url;
    }
}

function flushViewLogs() {
    if (viewFlushTimer) clearTimeout(viewFlushTimer);
    viewFlushTimer = null;
    if (!viewLines.length) return;

    const batch = viewLines.join("");
    viewLines = [];
    viewBytes = 0;
    const dir = getLogDir();
    if (!dir) return;

    try {
        cleanupOldLogs(dir);
        const file = join(dir, fileNameFor(sessionStart()).replace(/\.log$/, "_views.log"));
        let size = 0;
        try {
            size = statSync(file).size;
        } catch {}

        if (size + Buffer.byteLength(batch) > VIEW_LOG_MAX_BYTES) {
            const backup = (index: number) => file.replace(/\.log$/, `.${index}.log`);
            try {
                unlinkSync(backup(2));
            } catch (error: any) {
                if (error.code !== "ENOENT") throw error;
            }
            for (let index = 1; index >= 0; index--) {
                try {
                    renameSync(index ? backup(index) : file, backup(index + 1));
                } catch (error: any) {
                    if (error.code !== "ENOENT") throw error;
                }
            }
        }
        appendFileSync(file, batch);
    } catch {
        // Diagnostics must never interrupt the application when disk writes fail.
    }
}

function logView(contents: WebContents, level: Level, event: string, ...args: unknown[]) {
    const context = viewContexts.get(contents);
    if (!context) return;

    const prefix = `[view:${context.id} ${context.label}] ${shortUrl(context.url)} [${event}]`;
    const message = format(args);
    const boundedMessage =
        message.length > VIEW_LOG_MAX_MESSAGE_LENGTH
            ? `${message.slice(0, VIEW_LOG_MAX_MESSAGE_LENGTH)} [truncated]`
            : message;
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${prefix} ${boundedMessage}\n`;
    viewLines.push(line);
    viewBytes += Buffer.byteLength(line);

    if (viewBytes >= VIEW_LOG_BATCH_BYTES) flushViewLogs();
    else if (!viewFlushTimer) {
        viewFlushTimer = setTimeout(flushViewLogs, VIEW_LOG_FLUSH_MS);
        viewFlushTimer.unref();
    }

    // Keep errors discoverable in the existing main log as well.
    if (level === "error") emit(level, [prefix, boundedMessage]);
    if (isDebugEnabled()) {
        const sink = level === "error" ? original.error : level === "warn" ? original.warn : original.log;
        sink(prefix, boundedMessage);
    }
}

/** Gives diagnostic lines a stable account/view identity, independent of page URLs. */
export function setViewLogLabel(contents: WebContents, label: string) {
    const context = viewContexts.get(contents);
    if (context) {
        context.label = label;
        logView(contents, "info", "label");
    }
}

/** Captures all views, including hidden accounts, overlays, and child windows. */
export function attachRendererLogging() {
    app.on("web-contents-created", (_event, contents) => {
        const context: ViewLogContext = {
            id: contents.id,
            label: contents.getType(),
            url: contents.getURL()
        };
        viewContexts.set(contents, context);
        logView(contents, "info", "created");

        contents.on("console-message", event => {
            const level = event.level === "warning" ? "warn" : event.level;
            logView(contents, level, "console", `${shortUrl(event.sourceId)}:${event.lineNumber}`, event.message);
        });
        contents.on("did-start-loading", () => logView(contents, "debug", "loading"));
        contents.on("did-finish-load", () => logView(contents, "info", "loaded"));
        contents.on("did-stop-loading", () => logView(contents, "debug", "stopped loading"));
        contents.on("did-navigate", (_e, url, responseCode) => {
            context.url = url;
            logView(contents, "info", "navigation", { responseCode });
        });
        contents.on("did-navigate-in-page", (_e, url, isMainFrame) => {
            if (isMainFrame) context.url = url;
            logView(contents, "debug", "in-page navigation", { url: shortUrl(url), isMainFrame });
        });
        contents.on("did-fail-load", (_e, errorCode, errorDescription, url, isMainFrame) => {
            logView(contents, errorCode === -3 ? "debug" : "error", "load failed", {
                errorCode,
                errorDescription,
                url: shortUrl(url),
                isMainFrame
            });
        });
        contents.on("render-process-gone", (_e, details) => {
            logView(contents, "error", "renderer gone", details);
        });
        contents.on("unresponsive", () => {
            logView(contents, "warn", "unresponsive");
        });
        contents.on("responsive", () => logView(contents, "info", "responsive"));
        contents.on("preload-error", (_e, preloadPath, error) => {
            logView(contents, "error", "preload error", preloadPath, error);
        });
        contents.on("destroyed", () => {
            logView(contents, "info", "destroyed");
            viewContexts.delete(contents);
        });
    });
    app.on("before-quit", flushViewLogs);
    app.on("will-quit", flushViewLogs);
}

/** Written once the app is ready. */
export function initLogger() {
    minLevel = isDebugEnabled() ? "debug" : "info";

    log(
        "info",
        `Multi Vesktop v${app.getVersion()} — ${process.platform} ${process.arch}, Electron ${process.versions.electron}, Node ${process.versions.node}`
    );
    log("info", `app name: ${app.getName()} — userData: ${app.getPath("userData")}`);
    log("info", `account data: ${DATA_DIR} — sessionData: ${SESSION_DATA_DIR}`);
    try {
        log("info", `storage initialization: ${readFileSync(`${DATA_DIR}.migration-complete`, "utf8").trim()}`);
    } catch (error) {
        log("warn", "Could not read storage initialization record", error);
    }
    log("info", `log file: ${getFile() ?? "(file logging disabled)"}`);
    log("info", `debug logging: ${isDebugEnabled() ? "on" : "off"}`);
    log("info", "verbose view logging: on (silent unless debug mode is enabled)");
}

export function getLogDirPath(): string | null {
    return getLogDir();
}

export async function openLogsFolder() {
    const dir = getLogDir();
    if (dir) await shell.openPath(dir);
}

// Installed at module load so logs from the very first imports are captured.
installConsoleCapture();
process.on("uncaughtException", error => log("error", "[uncaughtException]", error));
process.on("unhandledRejection", reason => log("error", "[unhandledRejection]", reason));
