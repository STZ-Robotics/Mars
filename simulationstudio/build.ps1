# Builds the simulation engine on Windows.
#
#   .\simulationstudio\build.ps1              configure and build
#   .\simulationstudio\build.ps1 -Clean       wipe the CMake cache first
#   .\simulationstudio\build.ps1 -Smoke       build and run 500 physics steps
#
# This script exists because building by hand has three traps:
#
#  1. MSYS2. If C:\msys64\ucrt64\bin is on the PATH, CMake picks its g++ (or
#     worse: compiles with cl.exe and links with ld.exe, which fails looking
#     for shell32.lib). It is filtered out of the PATH here.
#
#  2. %PATH% expansion in cmd. Putting conda on the PATH AFTER calling
#     vcvars64.bat does not work: cmd expands %PATH% when parsing the whole
#     line, before vcvars runs, and MSVC's PATH is lost. The PATH has to be
#     built first and vcvars called last.
#
#  3. A poisoned cache. If a configure fails halfway, CMakeCache.txt is left
#     with the wrong compiler and later attempts reuse it. For any odd error:
#     -Clean.
param(
  [switch]$Clean,
  [switch]$Smoke
)

$ErrorActionPreference = "Stop"
# The script lives INSIDE the folder it builds, and that folder has a
# different name depending on where it is: simulationstudio/ in the
# repository, sim/ in an installation, which is how it travels inside the
# package. That is why it starts from $PSScriptRoot and not from a name: that
# way both places work the same.
$sim  = $PSScriptRoot
$repo = Split-Path -Parent $sim

# --- Locate the conda environment -------------------------------------
# The order is the same the app uses (app/src/supervisor.rs): first what is
# asked for by hand, then whichever environment is active, and only then the
# default places. CONDA_PREFIX is not a luxury: in CI the environment is
# installed by setup-miniconda in its own path, and without that line this
# script finds nothing even with the environment created and activated.
$candidates = @()
if ($env:MARS_CONDA_ENV) { $candidates += $env:MARS_CONDA_ENV }
if ($env:CONDA_PREFIX)   { $candidates += $env:CONDA_PREFIX }
foreach ($root in @("$env:USERPROFILE\miniforge3", "$env:LOCALAPPDATA\miniforge3",
                    "$env:USERPROFILE\miniconda3", "$env:USERPROFILE\anaconda3")) {
  $candidates += (Join-Path $root "envs\mars-sim")
}
$condaEnv = $candidates |
  Where-Object { $_ -and (Test-Path (Join-Path $_ "Library\lib\cmake\gz-sim")) } |
  Select-Object -First 1
if (-not $condaEnv) {
  throw "The 'mars-sim' environment was not found. Create it with: conda env create -f simulationstudio\environment.yml"
}

# --- Locate MSVC -------------------------------------------------------
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { throw "Visual Studio is not installed (vswhere.exe is missing)." }
$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) { $vsPath = & $vswhere -latest -products * -property installationPath }
$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) { throw "The C++ workload is missing from Visual Studio ($vcvars does not exist)." }

if ($Clean) {
  Remove-Item -Recurse -Force (Join-Path $sim "build\CMakeCache.txt"),
                              (Join-Path $sim "build\CMakeFiles") -ErrorAction SilentlyContinue
  Write-Host "CMake cache wiped" -ForegroundColor Yellow
}

# Trap 1: MSYS2 out. Trap 2: the PATH is built before vcvars.
$cleanPath = ($env:PATH -split ';' | Where-Object { $_ -and $_ -notmatch 'msys64' }) -join ';'
$prefix = "$(Split-Path -Parent $vswhere);$condaEnv\Library\bin;$condaEnv\Scripts;$cleanPath"

$steps = @(
  "cmake -S `"$sim\engine`" -B `"$sim\build`" -G Ninja -DCMAKE_CXX_COMPILER=cl -DCMAKE_PREFIX_PATH=`"$condaEnv\Library`" -DCMAKE_BUILD_TYPE=Release",
  "cmake --build `"$sim\build`""
)
if ($Smoke) { $steps += "cd /d `"$sim`" && build\mars-sim-server.exe worlds\empty.sdf 500" }

$cmd = "set `"PATH=$prefix`" && call `"$vcvars`" >nul && " + ($steps -join " && ")
# PowerShell 5.1 turns every stderr line of an .exe into an ErrorRecord.
# Gazebo writes benign warnings to stderr (the gz-msgs descriptor one, for
# instance), so with ErrorActionPreference=Stop the build would "fail" without
# having failed. The guard is lowered and only the exit code is trusted.
$ErrorActionPreference = "Continue"
cmd /c $cmd
$code = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($code -ne 0) { throw "the build failed with code $code" }
Write-Host "`nOK -> $sim\build\mars-sim-server.exe" -ForegroundColor Green
