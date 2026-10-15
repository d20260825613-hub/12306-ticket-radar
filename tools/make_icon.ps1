# Generate assets\app.ico : green rounded square with a white glyph.
# ASCII-only source on purpose: Windows PowerShell 5.1 reads BOM-less .ps1
# as ANSI, so any non-ASCII literal here would be corrupted.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = if ($args.Count -ge 1) { $args[0] } else { 'D:\dsh\12306-assistant' }
$outDir = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$out = Join-Path $outDir 'app.ico'

# U+7968 : the Chinese character for "ticket"
$glyph = [string][char]0x7968

$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

# rounded-rectangle path
$r = 52
$d = $r * 2
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d, 0, $d, $d, 270, 90)
$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$path.AddArc(0, $size - $d, $d, $d, 90, 90)
$path.CloseFigure()

$c1 = [System.Drawing.Color]::FromArgb(255, 7, 193, 96)
$c2 = [System.Drawing.Color]::FromArgb(255, 4, 158, 78)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)),
  (New-Object System.Drawing.Point($size, $size)), $c1, $c2)
$g.FillPath($brush, $path)

$font = New-Object System.Drawing.Font('Microsoft YaHei', 132, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$rect = New-Object System.Drawing.RectangleF(0, -6, $size, $size)
$g.DrawString($glyph, $font, $white, $rect, $fmt)

$g.Dispose()

# ---- assemble ICO (single 256x256 PNG-compressed entry) ----
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$ms.Dispose()
$bmp.Dispose()

$fs = [System.IO.File]::Create($out)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)   # ICONDIR
$bw.Write([Byte]0);   $bw.Write([Byte]0)                            # width/height = 256
$bw.Write([Byte]0);   $bw.Write([Byte]0)                            # palette / reserved
$bw.Write([UInt16]1); $bw.Write([UInt16]32)                         # planes / bpp
$bw.Write([UInt32]$png.Length)
$bw.Write([UInt32]22)                                               # offset
$bw.Write($png)
$bw.Flush(); $bw.Close(); $fs.Close()

Write-Output ("icon written: {0}  ({1} KB, 256x256 PNG-compressed)" -f $out, [math]::Round((Get-Item $out).Length / 1KB, 1))
