# Generate assets\launcher.ico : a radar mark (green square, white sweep rings).
# Separate from app.ico because the launcher is a console app; without its own
# icon Windows would show the default Node.js icon.
#
# ASCII-only source: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = if ($args.Count -ge 1) { $args[0] } else { 'D:\dsh\12306-assistant' }
$outDir = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$out = Join-Path $outDir 'launcher.ico'

$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# rounded square background
$r = 52
$d = $r * 2
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d, 0, $d, $d, 270, 90)
$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$path.AddArc(0, $size - $d, $d, $d, 90, 90)
$path.CloseFigure()

$c1 = [System.Drawing.Color]::FromArgb(255, 9, 176, 90)
$c2 = [System.Drawing.Color]::FromArgb(255, 3, 132, 66)
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)),
  (New-Object System.Drawing.Point($size, $size)), $c1, $c2)
$g.FillPath($bg, $path)

# radar rings
$cx = 128.0
$cy = 128.0
$penRing = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(210, 255, 255, 255), 11)
foreach ($rad in @(36.0, 62.0, 88.0)) {
  $g.DrawEllipse($penRing, [single]($cx - $rad), [single]($cy - $rad), [single]($rad * 2), [single]($rad * 2))
}

# sweep wedge (upper-right quadrant of the outer ring)
$sweep = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 255, 255, 255))
$g.FillPie($sweep, [single]($cx - 88), [single]($cy - 88), 176, 176, 270, 62)

# center hub
$hub = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$g.FillEllipse($hub, [single]($cx - 15), [single]($cy - 15), 30, 30)

$g.Dispose()

# assemble ICO (single 256x256 PNG entry)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$ms.Dispose()
$bmp.Dispose()

$fs = [System.IO.File]::Create($out)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)
$bw.Write([Byte]0);   $bw.Write([Byte]0)
$bw.Write([Byte]0);   $bw.Write([Byte]0)
$bw.Write([UInt16]1); $bw.Write([UInt16]32)
$bw.Write([UInt32]$png.Length)
$bw.Write([UInt32]22)
$bw.Write($png)
$bw.Flush(); $bw.Close(); $fs.Close()

Write-Output ("icon written: {0}  ({1} KB)" -f $out, [math]::Round((Get-Item $out).Length / 1KB, 1))
