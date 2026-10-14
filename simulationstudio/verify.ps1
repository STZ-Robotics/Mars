# End-to-end verification of the simulation.
#
#   .\simulationstudio\verify.ps1
#
# Runs the layers in increasing order of cost: the contract (instant), building
# the engine and the bridge, and the real loop with real physics. Fit for CI.
$ErrorActionPreference = "Stop"
# Same as build.ps1: the folder is the one holding this script, whether it is
# called simulationstudio/ (repository) or sim/ (installation).
$sim = $PSScriptRoot
$repo = Split-Path -Parent $sim

$condaEnv = $null
foreach ($root in @("$env:USERPROFILE\miniforge3", "$env:LOCALAPPDATA\miniforge3")) {
  $c = Join-Path $root "envs\mars-sim"
  if (Test-Path (Join-Path $c "Library\lib\cmake\gz-sim")) { $condaEnv = $c; break }
}
if (-not $condaEnv) { throw "the 'mars-sim' environment is missing (conda env create -f simulationstudio\environment.yml)" }

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }

# --- 1. The contract ---------------------------------------------------
Step 1 "protocol contract"
$ErrorActionPreference = "Continue"
& "$condaEnv\python.exe" "$sim\protocol\check.py"
if ($LASTEXITCODE -ne 0) { throw "the contract is inconsistent" }

# --- 2. The engine -----------------------------------------------------
Step 2 "building the engine and its systems"
& "$sim\build.ps1"
foreach ($f in @("mars-sim-server.exe", "MarsLink.dll")) {
  if (-not (Test-Path "$sim\build\$f")) { throw "$f was not produced" }
}

# --- 3. The bridge -----------------------------------------------------
Step 3 "building the bridge"
# gz-transport-sys finds the C++ libs through pkg-config.
$env:PKG_CONFIG_PATH = "$condaEnv\Library\lib\pkgconfig"
$env:PATH = "$condaEnv\Library\bin;" + (($env:PATH -split ';' | Where-Object { $_ -and $_ -notmatch 'msys64' }) -join ';')
Push-Location "$sim\bridge"
try {
  cargo build --quiet --bins
  if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
  # They cover the coordinate transform and the struct layouts, which are
  # pure and need neither an engine nor a network.
  cargo test --quiet --lib
  if ($LASTEXITCODE -ne 0) { throw "the bridge's tests failed" }
} finally { Pop-Location }

# --- 4. The loop -------------------------------------------------------
Step 4 "full loop: commands -> physics -> telemetry"
# gz-sim looks for our own systems here.
$env:GZ_SIM_SYSTEM_PLUGIN_PATH = "$sim\build"
$srv = Start-Process -FilePath "$sim\build\mars-sim-server.exe" `
  -ArgumentList "worlds\testbot.sdf","run" -WorkingDirectory $sim -PassThru `
  -RedirectStandardOutput "$sim\build\srv.log" -RedirectStandardError "$sim\build\srv.err"
# Reading .Handle is not decorative: Start-Process -PassThru does not cache the
# process handle, and without a cached handle ExitCode is unreachable forever.
$null = $srv.Handle
Start-Sleep -Seconds 1

$log = "$sim\build\drive.log"
$drv = Start-Process -FilePath "$sim\bridge\target\debug\drive-test.exe" `
  -WorkingDirectory "$sim\bridge" -PassThru `
  -RedirectStandardOutput $log -RedirectStandardError "$sim\build\drive.err"
$null = $drv.Handle

$exited = $drv.WaitForExit(90000)
# WaitForExit with a timeout returns true but leaves ExitCode unpopulated.
if ($exited) { $drv.WaitForExit() }
$code = if ($exited) { $drv.ExitCode } else { -1 }
Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
if (-not $exited) { Stop-Process -Id $drv.Id -Force -ErrorAction SilentlyContinue }
# Really wait for it to die: Stop-Process does not block, and a step 4 engine
# still alive would publish on the same topics as step 5's. Two publishers on
# /mars/state/pose give no error, they give poses that overwrite each other.
$srv.WaitForExit(10000) | Out-Null

Get-Content $log -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" }
if ($code -ne 0) {
  Get-Content "$sim\build\drive.err" -Encoding UTF8 -ErrorAction SilentlyContinue |
    Where-Object { $_ -notmatch "DynamicFactory" } |
    ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  throw "the loop failed (drive-test exit $code)"
}

# --- 5. NT4 ------------------------------------------------------------
Step 5 "bridge -> NT4, against WPILib's ntcore"
# nt-probe acts as the NT4 SERVER, which is the role the robot code plays in
# simulation. It uses the reference implementation on purpose: a test written
# by us could share the bridge's misunderstanding of the wire format, ntcore
# cannot.
& "$condaEnv\python.exe" -c "import ntcore" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "    skipped: pyntcore is missing (pip install pyntcore)" -ForegroundColor Yellow
} else {
  $ntLog = "$sim\build\nt.log"
  $ntProbe = Start-Process -FilePath "$condaEnv\python.exe" `
    -ArgumentList "$sim\bridge\nt-probe.py","16","0.5" -WorkingDirectory $sim -PassThru `
    -RedirectStandardOutput $ntLog -RedirectStandardError "$sim\build\nt.err"
  $null = $ntProbe.Handle
  Start-Sleep -Seconds 2

  $srv2 = Start-Process -FilePath "$sim\build\mars-sim-server.exe" `
    -ArgumentList "worlds\testbot.sdf","run" -WorkingDirectory $sim -PassThru `
    -RedirectStandardOutput "$sim\build\srv2.log" -RedirectStandardError "$sim\build\srv2.err"
  $null = $srv2.Handle
  Start-Sleep -Seconds 1

  $bridge = Start-Process -FilePath "$sim\bridge\target\debug\mars-bridge.exe" `
    -ArgumentList "--robot-map","models\testbot\robot-map.json" -WorkingDirectory $sim -PassThru `
    -RedirectStandardOutput "$sim\build\br.log" -RedirectStandardError "$sim\build\br.err"
  $null = $bridge.Handle

  # Drive in parallel: a static pose cannot tell "the bridge works" from "the
  # bridge published once and got stuck".
  Start-Sleep -Seconds 2
  $drv2 = Start-Process -FilePath "$sim\bridge\target\debug\drive-test.exe" `
    -WorkingDirectory "$sim\bridge" -PassThru `
    -RedirectStandardOutput "$sim\build\drive2.log" -RedirectStandardError "$sim\build\drive2.err"
  $null = $drv2.Handle

  $ntOk = $ntProbe.WaitForExit(60000)
  if ($ntOk) { $ntProbe.WaitForExit() }
  $ntCode = if ($ntOk) { $ntProbe.ExitCode } else { -1 }
  foreach ($p in @($drv2, $bridge, $srv2, $ntProbe)) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }

  Get-Content $ntLog -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" }
  Write-Host "    (probe: exited=$ntOk code=$ntCode)" -ForegroundColor DarkGray
  if ($ntCode -ne 0) {
    Get-Content "$sim\build\nt.err" -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    Get-Content "$sim\build\br.err" -Encoding UTF8 -ErrorAction SilentlyContinue |
      Where-Object { $_ -notmatch "DynamicFactory" } | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    throw "the bridge failed against NT4 (probe exit $ntCode)"
  }
}


# --- 6. The vendor profile's glue ---------------------------------------
Step 6 "hardware loop: robot code <-> engine"
# fake-robot plays the robot code: it brings up the NT4 server, publishes the
# duty the vendor would apply to each motor and reads back what the physics
# returns. It is the only test that closes the whole circle; the pieces on
# their own already passed in the previous steps.
$robLog = "$sim\build\rob.log"
$rob = Start-Process -FilePath "$condaEnv\python.exe" `
  -ArgumentList "$sim\bridge\fake-robot.py","$sim\models\testbot\robot-map.json","5" `
  -WorkingDirectory $sim -PassThru `
  -RedirectStandardOutput $robLog -RedirectStandardError "$sim\build\rob.err"
$null = $rob.Handle
Start-Sleep -Seconds 2

$srv3 = Start-Process -FilePath "$sim\build\mars-sim-server.exe" `
  -ArgumentList "worlds\testbot.sdf","run" -WorkingDirectory $sim -PassThru `
  -RedirectStandardOutput "$sim\build\srv3.log" -RedirectStandardError "$sim\build\srv3.err"
$null = $srv3.Handle
Start-Sleep -Seconds 1

$br2 = Start-Process -FilePath "$sim\bridge\target\debug\mars-bridge.exe" `
  -ArgumentList "--robot-map","models\testbot\robot-map.json" -WorkingDirectory $sim -PassThru `
  -RedirectStandardOutput "$sim\build\br2.log" -RedirectStandardError "$sim\build\br2.err"
$null = $br2.Handle

$robOk = $rob.WaitForExit(90000)
if ($robOk) { $rob.WaitForExit() }
$robCode = if ($robOk) { $rob.ExitCode } else { -1 }
foreach ($p in @($br2, $srv3, $rob)) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }

Get-Content $robLog -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" }
if ($robCode -ne 0) {
  Get-Content "$sim\build\rob.err" -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  throw "the hardware loop failed (fake-robot exit $robCode)"
}


# --- 7. The swerve under position control --------------------------------
Step 7 "swerve: the engine closes the position loop"
# Step 6 tests duty mode on a 4-wheel-drive robot. This one tests position
# mode, which is what a CAN motor really does: the robot code sends an angle
# and the engine chases it at the physics rate. Without it a swerve's steering
# is not held --- no loop over the network governs 90 N*m across 0.008 kg*m2.
$robLog2 = "$sim\build\rob2.log"
$rob2 = Start-Process -FilePath "$condaEnv\python.exe" `
  -ArgumentList "$sim\bridge\fake-robot.py","$sim\models\swerve\robot-map.json","4" `
  -WorkingDirectory $sim -PassThru `
  -RedirectStandardOutput $robLog2 -RedirectStandardError "$sim\build\rob2.err"
$null = $rob2.Handle
Start-Sleep -Seconds 2

$srv4 = Start-Process -FilePath "$sim\build\mars-sim-server.exe" `
  -ArgumentList "worlds\swerve.sdf","run" -WorkingDirectory $sim -PassThru `
  -RedirectStandardOutput "$sim\build\srv4.log" -RedirectStandardError "$sim\build\srv4.err"
$null = $srv4.Handle
Start-Sleep -Seconds 1

$br3 = Start-Process -FilePath "$sim\bridge\target\debug\mars-bridge.exe" `
  -ArgumentList "--robot-map","models\swerve\robot-map.json" -WorkingDirectory $sim -PassThru `
  -RedirectStandardOutput "$sim\build\br3.log" -RedirectStandardError "$sim\build\br3.err"
$null = $br3.Handle

$rob2Ok = $rob2.WaitForExit(90000)
if ($rob2Ok) { $rob2.WaitForExit() }
$rob2Code = if ($rob2Ok) { $rob2.ExitCode } else { -1 }
foreach ($p in @($br3, $srv4, $rob2)) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }

Get-Content $robLog2 -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" }
if ($rob2Code -ne 0) {
  Get-Content "$sim\build\rob2.err" -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  throw "the swerve failed (fake-robot exit $rob2Code)"
}


# --- 8. Simulation Studio: the supervisor and the launcher ---------------
Step 8 "Simulation Studio: starts the simulation and stops it cleanly"
# The Studio is the SEPARATE application that governs the simulation;
# mars-desktop only has a button that opens it. Here its supervisor is tested
# in headless mode: that it finds sim/ and the conda environment, that it
# brings up engine and bridge with the right environment, that they stay up
# without robot code, and that nothing is left alive after stopping. The last
# one matters more than it looks: an orphaned engine publishes on the same
# topics as the next one and the poses overwrite each other.
Push-Location "$sim\app"
try {
  cargo build --quiet
  if ($LASTEXITCODE -ne 0) { throw "MARS Sim does not build" }
} finally { Pop-Location }

& "$sim\app\target\debug\mars-sim-app.exe" --headless 6 2>&1 |
  Where-Object { $_ -notmatch "DynamicFactory" } | ForEach-Object { Write-Host "    $_" }
$appCode = $LASTEXITCODE
if ($appCode -ne 0) { throw "MARS Sim failed (exit $appCode)" }

# And that mars-desktop knows how to find it: the Sidebar's button depends on it.
Push-Location "$repo\desktop\src-tauri"
try {
  cargo test --quiet --bin mars-desktop simlauncher
  if ($LASTEXITCODE -ne 0) { throw "mars-desktop's launcher does not find MARS Sim" }
} finally { Pop-Location }
  Write-Host "    mars-desktop launcher: finds MARS Sim" -ForegroundColor DarkGray

Write-Host "`nALL OK: 8 layers, from the contract to the simulation app." -ForegroundColor Green
