# Build script for native helpers
# Tries MSVC first, falls back to MinGW, then clang

$outputDir = Join-Path $PSScriptRoot "out\win32"
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$defaultLibs = @("user32.lib", "gdi32.lib", "gdiplus.lib", "ole32.lib", "oleaut32.lib", "uuid.lib")
$defaultGccLibs = @("-luser32", "-lgdi32", "-lgdiplus", "-lole32", "-loleaut32", "-luuid")

$targets = @(
    @{ kind = "cpp"; src = "src\window_info.cpp"; out = (Join-Path $outputDir "window_info.exe"); libs = $defaultLibs; gccLibs = $defaultGccLibs },
    @{ kind = "cpp"; src = "src\window_text.cpp"; out = (Join-Path $outputDir "window_text.exe"); libs = $defaultLibs; gccLibs = $defaultGccLibs },
    @{ kind = "cpp"; src = "src\selected_text.cpp"; out = (Join-Path $outputDir "selected_text.exe"); libs = $defaultLibs; gccLibs = $defaultGccLibs },
    @{ kind = "cpp"; src = "src\dictation_bridge.cpp"; out = (Join-Path $outputDir "dictation_bridge.exe"); libs = @("ole32.lib", "oleaut32.lib", "uuid.lib", "user32.lib"); gccLibs = @("-lole32", "-loleaut32", "-luuid", "-luser32") }
)

function Build-WithMSVC($vcvars, $srcFile, $outFile, $libs) {
    if (Test-Path $outFile) {
        Remove-Item $outFile -Force
    }
    $cwd = (Get-Location).Path
    $libArgs = ($libs -join " ")
    $cmd = "call `"$vcvars`" && cd /d `"$cwd`" && cl /O2 /EHsc /nologo `"$srcFile`" /link $libArgs /OUT:`"$outFile`""
    cmd /c $cmd
    return ($LASTEXITCODE -eq 0 -and (Test-Path $outFile))
}

function Build-WithGpp($srcFile, $outFile, $gccLibs) {
    if (Test-Path $outFile) {
        Remove-Item $outFile -Force
    }
    & g++ -O2 -static $srcFile -o $outFile @gccLibs
    return ($LASTEXITCODE -eq 0 -and (Test-Path $outFile))
}

function Build-WithClang($srcFile, $outFile, $gccLibs) {
    if (Test-Path $outFile) {
        Remove-Item $outFile -Force
    }
    & clang++ -O2 $srcFile -o $outFile @gccLibs
    return ($LASTEXITCODE -eq 0 -and (Test-Path $outFile))
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
    Write-Host "Building $(Split-Path $t.out -Leaf)..."
    $built = $false

    if ($vcvars -and -not $built) {
        Write-Host "  Using MSVC..."
        $built = Build-WithMSVC $vcvars $t.src $t.out $t.libs
    }
    if ($hasGpp -and -not $built) {
        Write-Host "  Using MinGW g++..."
        $built = Build-WithGpp $t.src $t.out $t.gccLibs
    }
    if ($hasClang -and -not $built) {
        Write-Host "  Using clang++..."
        $built = Build-WithClang $t.src $t.out $t.gccLibs
    }

    if ($built) {
        Write-Host "  Build successful: $($t.out)"
    } else {
        Write-Host "  ERROR: Failed to build $($t.out)"
        $allOk = $false
    }
}

if (-not $allOk) { exit 1 }

# wakeword_listener — Rust binary, x86_64 Windows via cargo. Skipped silently
# when cargo is unavailable so non-Rust contributors aren't blocked.
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if ($cargo) {
    Write-Host "Building wakeword_listener.exe..."
    Push-Location (Join-Path $PSScriptRoot "wakeword")
    try {
        & cargo build --release --quiet --target x86_64-pc-windows-msvc
        if ($LASTEXITCODE -eq 0) {
            $src = Join-Path (Get-Location) "target\x86_64-pc-windows-msvc\release\wakeword_listener.exe"
            $dst = Join-Path $outputDir "wakeword_listener.exe"
            Copy-Item -Force $src $dst
            $modelsDir = Join-Path $outputDir "wakeword_models"
            New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
            Copy-Item -Force (Join-Path $PSScriptRoot "wakeword\models\hey_stella.onnx") (Join-Path $modelsDir "hey_stella.onnx")
            Write-Host "  Build successful: $dst"
        } else {
            Write-Host "  ERROR: cargo build failed"
            exit 1
        }
    } finally {
        Pop-Location
    }
} else {
    Write-Host "Skipping wakeword_listener: cargo not on PATH (install rustup to enable)."
}

exit 0
