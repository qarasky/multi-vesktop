/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type Session, session, systemPreferences } from "electron";

export function registerMediaPermissionsHandler(ses: Session = session.defaultSession) {
    if (process.platform !== "darwin") return;

    ses.setPermissionRequestHandler(async (_webContents, permission, callback, details) => {
        let granted = true;

        if ("mediaTypes" in details) {
            if (details.mediaTypes?.includes("audio")) {
                granted &&= await systemPreferences.askForMediaAccess("microphone");
            }
            if (details.mediaTypes?.includes("video")) {
                granted &&= await systemPreferences.askForMediaAccess("camera");
            }
        }

        callback(granted);
    });
}
