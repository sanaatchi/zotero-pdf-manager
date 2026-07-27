param(
  [Parameter(Mandatory = $true)][string]$AddonDir,
  [Parameter(Mandatory = $true)][string]$XpiPath
)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (Test-Path $XpiPath) {
  Remove-Item -LiteralPath $XpiPath -Force
}

$root = (Resolve-Path $AddonDir).Path
$zip = [System.IO.Compression.ZipFile]::Open(
  $XpiPath,
  [System.IO.Compression.ZipArchiveMode]::Create
)
try {
  # Firefox/Zotero AddonManager expects explicit directory entries in the XPI.
  $dirSet = New-Object 'System.Collections.Generic.HashSet[string]'
  Get-ChildItem -LiteralPath $root -Recurse -Directory | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length + 1).Replace("\", "/")
    $parts = $rel.Split("/") | Where-Object { $_ -ne "" }
    $acc = ""
    foreach ($part in $parts) {
      $acc = "$acc$part/"
      [void]$dirSet.Add($acc)
    }
  }
  foreach ($dir in ($dirSet | Sort-Object)) {
    [void]$zip.CreateEntry($dir)
  }

  Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($root.Length + 1).Replace("\", "/")
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip,
      $_.FullName,
      $relative,
      [System.IO.Compression.CompressionLevel]::Optimal
    )
  }
}
finally {
  $zip.Dispose()
}
