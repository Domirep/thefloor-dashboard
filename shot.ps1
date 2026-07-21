# Headless render of office2 + optional crop in CANVAS pixel coords (480x270 space).
# usage: shot.ps1 -Name moloch -Cx 314 -Cy 8 -Cw 166 -Ch 234      (omit crop args for full frame)
param(
  [string]$Name = "shot",
  [int]$Cx = -1, [int]$Cy = 0, [int]$Cw = 0, [int]$Ch = 0,
  [int]$WinW = 2880, [int]$WinH = 1620,
  [string]$Url = "http://localhost:4319/office2"
)
$sp = "C:\Users\Christi\AppData\Local\Temp\claude\C--Users-Christi-openclaw-agent\a49211a6-9549-40a6-a744-963f368032d0\scratchpad"
$full = Join-Path $sp "$Name-full.png"
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
& $edge --headless=new --disable-gpu --hide-scrollbars --window-size=$WinW,$WinH --virtual-time-budget=4500 --screenshot="$full" $Url 2>$null | Out-Null
Start-Sleep -Milliseconds 350
if (-not (Test-Path $full)) { "NO OUTPUT"; exit 1 }
if ($Cx -lt 0) { "full -> $full"; exit 0 }

Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($full)
$s  = [int][Math]::Min([Math]::Floor($img.Width/480), [Math]::Floor($img.Height/270))
$ox = [int](($img.Width  - 480*$s)/2)
$oy = [int](($img.Height - 270*$s)/2)
$rx = [int]($ox + $Cx*$s); $ry = [int]($oy + $Cy*$s)
$rw = [int]($Cw*$s);       $rh = [int]($Ch*$s)
if (($rx+$rw) -gt $img.Width)  { $rw = [int]($img.Width  - $rx) }
if (($ry+$rh) -gt $img.Height) { $rh = [int]($img.Height - $ry) }
$crop = Join-Path $sp "$Name-crop.png"
$bmp = New-Object System.Drawing.Bitmap -ArgumentList @([int]$rw,[int]$rh)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.DrawImage($img,
  (New-Object System.Drawing.Rectangle -ArgumentList @(0,0,$rw,$rh)),
  (New-Object System.Drawing.Rectangle -ArgumentList @($rx,$ry,$rw,$rh)),
  [System.Drawing.GraphicsUnit]::Pixel)
$bmp.Save($crop, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose(); $bmp.Dispose(); $img.Dispose()
"scale=$s crop=${rw}x${rh} -> $crop"
