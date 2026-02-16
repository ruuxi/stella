# Build script for native helpers
# Tries MSVC first, falls back to MinGW, then clang

$targets = @(
    @{ src = "src\mouse_block.cpp"; out = "mouse_block.exe" },
    @{ src = "src\window_info.cpp"; out = "window_info.exe" }
)

function Build-WithMSVC($vcvars, $srcFile, $outFile) {
    $cmd = "`"$vcvars`" && cl /O2 /EHsc /nologo $srcFile /link user32.lib gdi32.lib gdiplus.lib ole32.lib /OUT:$outFile"
    cmd /c $cmd
    return (Test-Path $outFile)
}

function Build-WithGpp($srcFile, $outFile) {
    & g++ -O2 -static $srcFile -o $outFile -luser32 -lgdi32 -lgdiplus -lole32
    return (Test-Path $outFile)
}

function Build-WithClang($srcFile, $outFile) {
    & clang++ -O2 $srcFile -o $outFile -luser32 -lgdi32 -lgdiplus -lole32
    return (Test-Path $outFile)
}

# Detect compiler
$vcvars = $null
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vsWhere) {
    $vsPath = & $vsWhere -latest -property installationPath
    $candidate = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
    if (Test-Path $candidate) { $vcvars = $candidate }
}
$hasGpp = [bool](Get-Command g++ -ErrorAction SilentlyContinue)
$hasClang = [bool](Get-Command clang++ -ErrorAction SilentlyContinue)

if (-not $vcvars -and -not $hasGpp -and -not $hasClang) {
    Write-Host "ERROR: No C++ compiler found. Install one of:"
    Write-Host "  - Visual Studio with C++ workload"
    Write-Host "  - MinGW-w64 (g++)"
    Write-Host "  - LLVM/Clang"
    exit 1
}

$allOk = $true
foreach ($t in $targets) {
    Write-Host "Building $($t.out)..."
    $built = $false

    if ($vcvars -and -not $built) {
        Write-Host "  Using MSVC..."
        $built = Build-WithMSVC $vcvars $t.src $t.out
    }
    if ($hasGpp -and -not $built) {
        Write-Host "  Using MinGW g++..."
        $built = Build-WithGpp $t.src $t.out
    }
    if ($hasClang -and -not $built) {
        Write-Host "  Using clang++..."
        $built = Build-WithClang $t.src $t.out
    }

    if ($built) {
        Write-Host "  Build successful: $($t.out)"
    } else {
        Write-Host "  ERROR: Failed to build $($t.out)"
        $allOk = $false
    }
}

if (-not $allOk) { exit 1 }
exit 0
