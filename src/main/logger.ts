/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 multi-vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, shell } from "electron";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { join } from "path";

import { DATA_DIR, SESSION_DATA_DIR } from "./constants";

/**
 * File logging for support/debugging.
 *
 * - One log file per 12-hour session, named `multi-vesktop_<date>_<0000|1200>.log`.
 * - Files older than 3 days are pruned automatically.
 * - Logs go to `Documents/Multi Vesktop/logs`, falling back to the app's own
 *   data dir if Documents is not writable (e.g. macOS denies access).
 * - Also captures main-process console output, uncaught errors, and renderer
 *   errors/crashes. Verbose renderer console output needs debug mode.
 *
 * Debug mode can be enabled with `--debug` or `MULTI_VESKTOP_DEBUG=1`.
 */

type Level = "debug" | "info" | "warn" | "error";

const SESSION_HOURS = 12;
const RETENTION_DAYS = 3;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

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

function emitRenderer(level: string, url: string, message: unknown) {
    const l = level.toLowerCase();
    const prefix = `[renderer] ${shortUrl(url)}`;

    if (l === "error") log("error", `${prefix}:`, message);
    else if (l === "warning" || l === "warn") log("warn", `${prefix}:`, message);
    else log("debug", `${prefix}:`, message);
}

/** Captures renderer errors/crashes and (in debug mode) renderer console output. */
export function attachRendererLogging() {
    app.on("web-contents-created", (_event, contents) => {
        (contents as any).on("console-message", (...args: any[]) => {
            const first = args[0];

            // Electron >= 37 passes a single event object
            if (first && typeof first === "object" && "message" in first) {
                emitRenderer(String(first.level ?? "info"), first.sourceId ?? contents.getURL(), first.message);
            } else {
                // legacy signature: (event, level, message, line, sourceId)
                emitRenderer(String(args[1] ?? "info"), args[4] ?? contents.getURL(), args[2]);
            }
        });

        contents.on("render-process-gone", (_e, details) => {
            log("error", `[renderer gone] ${contents.getURL()}`, details);
        });
        contents.on("unresponsive", () => {
            log("warn", `[renderer unresponsive] ${contents.getURL()}`);
        });
        (contents as any).on("preload-error", (_e: unknown, preloadPath: string, error: unknown) => {
            log("error", `[preload error] ${preloadPath}`, error);
        });
    });
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
