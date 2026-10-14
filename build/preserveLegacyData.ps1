# Preserve legacy profiles before electron-builder invokes the OLD uninstaller.
# Compatible with Windows PowerShell 5.1; no elevated user's AppData path is used.
param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [AllowEmptyString()][string]$MachineInstallDir = "",
    [AllowEmptyString()][string]$UserInstallDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$backups = New-Object 'System.Collections.Generic.List[string]'

try {
    $directories = @($InstallDir, $MachineInstallDir, $UserInstallDir) |
        Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd([IO.Path]::DirectorySeparatorChar) } |
        Select-Object -Unique

    foreach ($directory in $directories) {
        $oldManifest = Join-Path $directory "legacy-data-backups.json"
        if (Test-Path -LiteralPath $oldManifest) {
            $existing = Get-Content -LiteralPath $oldManifest -Raw | ConvertFrom-Json
            foreach ($backup in $existing) {
                if ($backup -isnot [string]) { throw "Invalid recovery manifest: $oldManifest" }
                if ((Test-Path -LiteralPath $backup -PathType Container) -and !$backups.Contains($backup)) {
                    $backups.Add($backup)
                }
            }
        }

        $source = Join-Path $directory "Data"
        if (!(Test-Path -LiteralPath $source)) { continue }
        if (!(Test-Path -LiteralPath $source -PathType Container)) { throw "Not a data directory: $source" }

        # The installer closes the current app first. A previous per-user install
        # might be elsewhere; refuse to copy its live Chromium databases.
        if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
            $prefix = $directory + [IO.Path]::DirectorySeparatorChar
            $running = @(Get-CimInstance Win32_Process | Where-Object {
                $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
            })
            if ($running.Count -gt 0) { throw "Close Multi Vesktop before updating: $directory" }
        }

        $items = @(Get-Item -LiteralPath $source -Force) + @(Get-ChildItem -LiteralPath $source -Recurse -Force)
        foreach ($item in $items) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Cannot preserve a linked file or directory: $($item.FullName)"
            }
        }

        # A sibling survives RMDir /r $INSTDIR, including moves between install modes.
        $backup = $directory + ".multi-vesktop-data-backup-" + [Guid]::NewGuid().ToString("N")
        [IO.Directory]::CreateDirectory($backup) | Out-Null
        foreach ($item in $items) {
            if ($item.FullName -eq $source) { continue }
            $relative = $item.FullName.Substring($source.Length + 1)
            $target = Join-Path $backup $relative
            if ($item.PSIsContainer) {
                [IO.Directory]::CreateDirectory($target) | Out-Null
            } else {
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
                [IO.File]::Copy($item.FullName, $target, $false)
                [IO.File]::SetLastWriteTimeUtc($target, $item.LastWriteTimeUtc)
                $originalHash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
                $copiedHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
                if ($originalHash -ne $copiedHash) { throw "Backup verification failed: $($item.FullName)" }
            }
        }
        # With unchanged account metadata, runtime selection preserves manifest
        # order. Prefer this fresh session snapshot over backups from earlier retries.
        $backups.Insert(0, $backup)
    }

    # Always write an array (also for zero or one backup), without a UTF-8 BOM.
    $json = ConvertTo-Json -InputObject @($backups.ToArray()) -Compress
    [IO.File]::WriteAllText($ManifestPath, $json, (New-Object Text.UTF8Encoding($false)))
    exit 0
} catch {
    [Console]::Error.WriteLine("Legacy data preservation failed. Original data has been kept. " + $_.Exception.Message)
    exit 1
}
