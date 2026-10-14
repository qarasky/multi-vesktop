# Storage migration only. Never override the install location or install mode.
!include "getProcessInfo.nsh"
Var pid
!ifndef BUILD_UNINSTALLER
Var legacyMachineInstallDir
Var legacyUserInstallDir
Var legacyPreservationDone
!endif

# electron-builder invokes this hook after closing the app, before uninstallOldVersion.
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    ${if} $legacyPreservationDone != "1"
      ReadRegStr $legacyMachineInstallDir HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
      ReadRegStr $legacyUserInstallDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
      InitPluginsDir
      File /oname=$PLUGINSDIR\preserveLegacyData.ps1 "${BUILD_RESOURCES_DIR}\preserveLegacyData.ps1"
      nsExec::ExecToStack '"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\preserveLegacyData.ps1" -InstallDir "$INSTDIR" -MachineInstallDir "$legacyMachineInstallDir" -UserInstallDir "$legacyUserInstallDir" -ManifestPath "$PLUGINSDIR\legacy-data-backups.json"'
      Pop $0
      Pop $1
      ${if} $0 != "0"
        MessageBox MB_OK|MB_ICONSTOP "Your existing accounts could not be backed up. The update has stopped and your original data has been kept.$\r$\n$\r$\n$1"
        SetErrorLevel 1
        Quit
      ${endif}
      StrCpy $legacyPreservationDone "1"
    ${endif}
  !endif
!macroend

!macro customInstall
  ClearErrors
  CopyFiles /SILENT "$PLUGINSDIR\legacy-data-backups.json" "$INSTDIR\legacy-data-backups.json"
  ${if} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "Could not save the account recovery manifest. Your backup remains beside the previous installation folder."
    SetErrorLevel 1
    Quit
  ${endif}
!macroend
