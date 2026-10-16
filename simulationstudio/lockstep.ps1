# Brings up a world in LOCKSTEP mode: the robot code sets the pace of the physics.
#
#   .\lockstep.ps1 -World worlds\offseason2026_lockstep.sdf -RobotMap models\offseason2026\robot-map.json [-Gui]
#
# Then, in the robot project:
#
#   $env:MARS_LOCKSTEP = "127.0.0.1:5811"; ./gradlew simulateJava
#
# The world has to have real_time_factor 0 (the *_lockstep.sdf files that
# gen_offseason2026.py generates). It runs with `run`, but MarsLink waits for
# every command from the robot, so it does not get ahead. With no robot
# connected it runs free (and fast).
#
# What the Studio does on "Start", minus picking the world: the Studio does not
# know this mode yet. See glue/README.md, Lockstep section.
param(
  [Parameter(Mandatory = $true)][string]$World,
  [Parameter(Mandatory = $true)][string]$RobotMap,
  [int]$Port = 5811,
  [switch]$Gui
)

$ErrorActionPreference = "Stop"
$sim = $PSScriptRoot

$candidates = @()
if ($env:MARS_CONDA_ENV) { $candidates += $env:MARS_CONDA_ENV }
if ($env:CONDA_PREFIX)   { $candidates += $env:CONDA_PREFIX }
foreach ($root in @("$env:USERPROFILE\miniforge3", "$env:LOCALAPPDATA\miniforge3",
                    "$env:USERPROFILE\miniconda3", "$env:USERPROFILE\anaconda3")) {
  $candidates += Join-Path $root "envs\mars-sim"
}
$conda = $candidates | Where-Object { Test-Path (Join-Path $_ "Library\bin") } | Select-Object -First 1
if (-not $conda) { throw "The 'mars-sim' environment was not found. Create it with: conda env create -f simulationstudio\environment.yml" }

$bridge = @("$sim\build\mars-bridge.exe",
            "$sim\bridge\target\release\mars-bridge.exe",
            "$sim\bridge\target\debug\mars-bridge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bridge) { throw "mars-bridge.exe is missing: cargo build --release in simulationstudio\bridge" }

Get-Process mars-bridge, mars-sim-server, mars-sim-gui -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

# The same as Supervisor::child_path: conda first and no MSYS2.
$rest = ($env:PATH -split ';' | Where-Object { $_ -and ($_.ToLower() -notmatch 'msys64') }) -join ';'
$env:PATH = "$conda\Library\bin;$rest"
$env:GZ_SIM_SYSTEM_PLUGIN_PATH = "$sim\build"
$env:GZ_SIM_RESOURCE_PATH = "$sim\models"
New-Item -ItemType Directory -Force "$sim\build" | Out-Null

$engine = Start-Process -FilePath "$sim\build\mars-sim-server.exe" -ArgumentList $World, "run" `
  -WorkingDirectory $sim -RedirectStandardOutput "$sim\build\lockstep-engine.log" `
  -RedirectStandardError "$sim\build\lockstep-engine.err" -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 1500

if ($Gui) {
  $env:OGRE2_RESOURCE_PATH = "$conda\Library\bin\OGRE-Next"
  $env:GZ_GUI_PLUGIN_PATH = "$conda\Library\lib\gz-gui-10\plugins;$conda\Library\lib\gz-sim-10\plugins\gui"
  Start-Process -FilePath "$sim\build\mars-sim-gui.exe" -ArgumentList "gui/mars.config" `
    -WorkingDirectory $sim -RedirectStandardOutput "$sim\build\lockstep-gui.log" `
    -RedirectStandardError "$sim\build\lockstep-gui.err" | Out-Null
}

$bridgeProc = Start-Process -FilePath $bridge -ArgumentList "--robot-map", $RobotMap, "--lockstep-port", $Port `
  -WorkingDirectory $sim -RedirectStandardOutput "$sim\build\lockstep-bridge.log" `
  -RedirectStandardError "$sim\build\lockstep-bridge.err" -PassThru -WindowStyle Hidden

Write-Host "engine $($engine.Id), bridge $($bridgeProc.Id): waiting for the robot on 127.0.0.1:$Port" -ForegroundColor Green
Write-Host "  `$env:MARS_LOCKSTEP = `"127.0.0.1:$Port`"; ./gradlew simulateJava"
Write-Host "  logs: $sim\build\lockstep-*.log"
