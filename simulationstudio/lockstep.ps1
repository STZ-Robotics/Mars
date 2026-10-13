# Levanta un mundo en modo LOCKSTEP: el codigo del robot marca el paso de la fisica.
#
#   .\lockstep.ps1 -World worlds\offseason2026_lockstep.sdf -RobotMap models\offseason2026\robot-map.json [-Gui]
#
# Despues, en el proyecto del robot:
#
#   $env:MARS_LOCKSTEP = "127.0.0.1:5811"; ./gradlew simulateJava
#
# El mundo tiene que tener real_time_factor 0 (los *_lockstep.sdf que genera
# gen_offseason2026.py). Corre con `run`, pero MarsLink espera cada comando del
# robot, asi que no se adelanta. Sin robot conectado corre libre (y rapido).
#
# Lo que hace el Studio con "Start", menos la eleccion de mundo: el Studio
# todavia no conoce este modo. Ver glue/README.md, seccion Lockstep.
param(
  [Parameter(Mandatory = $true)][string]$World,
  [Parameter(Mandatory = $true)][string]$RobotMap,
  [int]$Port = 5811,
  [switch]$Gui
)

$ErrorActionPreference = "Stop"
$sim = $PSScriptRoot

$candidatos = @()
if ($env:MARS_CONDA_ENV) { $candidatos += $env:MARS_CONDA_ENV }
if ($env:CONDA_PREFIX)   { $candidatos += $env:CONDA_PREFIX }
foreach ($root in @("$env:USERPROFILE\miniforge3", "$env:LOCALAPPDATA\miniforge3",
                    "$env:USERPROFILE\miniconda3", "$env:USERPROFILE\anaconda3")) {
  $candidatos += Join-Path $root "envs\mars-sim"
}
$conda = $candidatos | Where-Object { Test-Path (Join-Path $_ "Library\bin") } | Select-Object -First 1
if (-not $conda) { throw "No se encontro el entorno 'mars-sim'. Crealo con: conda env create -f simulationstudio\environment.yml" }

$bridge = @("$sim\build\mars-bridge.exe",
            "$sim\bridge\target\release\mars-bridge.exe",
            "$sim\bridge\target\debug\mars-bridge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bridge) { throw "Falta mars-bridge.exe: cargo build --release en simulationstudio\bridge" }

Get-Process mars-bridge, mars-sim-server, mars-sim-gui -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

# Lo mismo que Supervisor::path_para_hijos: conda primero y sin MSYS2.
$rest = ($env:PATH -split ';' | Where-Object { $_ -and ($_.ToLower() -notmatch 'msys64') }) -join ';'
$env:PATH = "$conda\Library\bin;$rest"
$env:GZ_SIM_SYSTEM_PLUGIN_PATH = "$sim\build"
$env:GZ_SIM_RESOURCE_PATH = "$sim\models"
New-Item -ItemType Directory -Force "$sim\build" | Out-Null

$motor = Start-Process -FilePath "$sim\build\mars-sim-server.exe" -ArgumentList $World, "run" `
  -WorkingDirectory $sim -RedirectStandardOutput "$sim\build\lockstep-motor.log" `
  -RedirectStandardError "$sim\build\lockstep-motor.err" -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 1500

if ($Gui) {
  $env:OGRE2_RESOURCE_PATH = "$conda\Library\bin\OGRE-Next"
  $env:GZ_GUI_PLUGIN_PATH = "$conda\Library\lib\gz-gui-10\plugins;$conda\Library\lib\gz-sim-10\plugins\gui"
  Start-Process -FilePath "$sim\build\mars-sim-gui.exe" -ArgumentList "gui/mars.config" `
    -WorkingDirectory $sim -RedirectStandardOutput "$sim\build\lockstep-gui.log" `
    -RedirectStandardError "$sim\build\lockstep-gui.err" | Out-Null
}

$puente = Start-Process -FilePath $bridge -ArgumentList "--robot-map", $RobotMap, "--lockstep-port", $Port `
  -WorkingDirectory $sim -RedirectStandardOutput "$sim\build\lockstep-bridge.log" `
  -RedirectStandardError "$sim\build\lockstep-bridge.err" -PassThru -WindowStyle Hidden

Write-Host "motor $($motor.Id), bridge $($puente.Id): esperando al robot en 127.0.0.1:$Port" -ForegroundColor Green
Write-Host "  `$env:MARS_LOCKSTEP = `"127.0.0.1:$Port`"; ./gradlew simulateJava"
Write-Host "  logs: $sim\build\lockstep-*.log"
