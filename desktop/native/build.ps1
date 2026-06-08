# Build script for native helpers
# Tries MSVC first, falls back to MinGW, then clang

$outputDir = Join-Path $PSScriptRoot "out\win32"
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

# Pinned parakeet.cpp (C++/ggml ASR) revision for the Windows local dictation
# helper. Keep in sync with desktop/native/build.sh.
$ParakeetCppRepo = "https://github.com/mudler/parakeet.cpp"
$ParakeetCppCommit = "9edf17c3ada66e0f881dcff155492867db7ac4cf"

$defaultLibs = @("user32.lib", "gdi32.lib", "gdiplus.lib", "ole32.lib", "oleaut32.lib", "uuid.lib")
$defaultGccLibs = @("-luser32", "-lgdi32", "-lgdiplus", "-lole32", "-loleaut32", "-luuid")
$windowInfoLibs = $defaultLibs + @("dwmapi.lib")
$windowInfoGccLibs = $defaultGccLibs + @("-ldwmapi")

$targets = @(
    @{ kind = "cpp"; src = "src\startup_feedback_launcher.cpp"; out = (Join-Path $outputDir "startup_feedback_launcher.exe"); libs = @("shell32.lib"); gccLibs = @("-lshell32") },
    @{ kind = "cpp"; src = "src\window_info.cpp"; out = (Join-Path $outputDir "window_info.exe"); libs = $windowInfoLibs; gccLibs = $windowInfoGccLibs },
    @{ kind = "cpp"; src = "src\window_text.cpp"; out = (Join-Path $outputDir "window_text.exe"); libs = $defaultLibs; gccLibs = $defaultGccLibs },
    @{ kind = "cpp"; src = "src\selected_text.cpp"; out = (Join-Path $outputDir "selected_text.exe"); libs = $defaultLibs; gccLibs = $defaultGccLibs },
    @{ kind = "cpp"; src = "src\dictation_bridge.cpp"; out = (Join-Path $outputDir "dictation_bridge.exe"); libs = @("ole32.lib", "oleaut32.lib", "uuid.lib", "user32.lib"); gccLibs = @("-lole32", "-loleaut32", "-luuid", "-luser32") },
    @{ kind = "cpp"; src = "src\stella_computer_helper.cpp"; out = (Join-Path $outputDir "stella-computer-helper.exe"); libs = @("ole32.lib", "oleaut32.lib", "uuid.lib", "user32.lib", "gdi32.lib", "gdiplus.lib", "shell32.lib", "advapi32.lib", "dwmapi.lib"); gccLibs = @("-lole32", "-loleaut32", "-luuid", "-luser32", "-lgdi32", "-lgdiplus", "-lshell32", "-ladvapi32", "-ldwmapi") },
    @{ kind = "cpp"; src = "src\meeting_capture.cpp"; out = (Join-Path $outputDir "meeting_capture.exe"); libs = @("ole32.lib", "oleaut32.lib", "uuid.lib", "shell32.lib"); gccLibs = @("-lole32", "-loleaut32", "-luuid", "-lshell32") }
)

function Build-WithMSVC($vcvars, $srcFile, $outFile, $libs) {
    if (Test-Path $outFile) {
        Remove-Item $outFile -Force
    }
    $cwd = (Get-Location).Path
    $libArgs = ($libs -join " ")
    $cmd = "call `"$vcvars`" && cd /d `"$cwd`" && cl /O2 /EHsc /nologo `"$srcFile`" /link $libArgs /OUT:`"$outFile`""
    # Stream cmd's stdout/stderr to the host so they don't bleed into the
    # function's pipeline output (which would make the returned boolean
    # array-truthy regardless of actual success).
    cmd /c $cmd 2>&1 | ForEach-Object { Write-Host $_ }
    $exit = $LASTEXITCODE
    $exists = Test-Path $outFile
    Write-Host "    cl exit=$exit, output exists=$exists, target=$outFile"
    return ($exit -eq 0 -and $exists)
}

function Build-WithGpp($srcFile, $outFile, $gccLibs) {
    if (Test-Path $outFile) {
        Remove-Item $outFile -Force
    }
    & g++ -O2 -static $srcFile -o $outFile @gccLibs 2>&1 | ForEach-Object { Write-Host $_ }
    $exit = $LASTEXITCODE
    $exists = Test-Path $outFile
    Write-Host "    g++ exit=$exit, output exists=$exists, target=$outFile"
    return ($exit -eq 0 -and $exists)
}

function Build-WithClang($srcFile, $outFile, $gccLibs) {
    if (Test-Path $outFile) {
        Remove-Item $outFile -Force
    }
    & clang++ -O2 $srcFile -o $outFile @gccLibs 2>&1 | ForEach-Object { Write-Host $_ }
    $exit = $LASTEXITCODE
    $exists = Test-Path $outFile
    Write-Host "    clang++ exit=$exit, output exists=$exists, target=$outFile"
    return ($exit -eq 0 -and $exists)
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

# Optional helpers: a build failure here logs a warning but does NOT fail the
# job, so a compiler-specific quirk in a non-critical helper can never block
# the required Windows native tarball. The desktop falls back to its previous
# code path (e.g. the PowerShell snapshot for recent apps) when the binary is
# absent.
$optionalTargets = @(
    @{ kind = "cpp"; src = "src\recent_apps.cpp"; out = (Join-Path $outputDir "recent_apps.exe"); libs = @("user32.lib", "dwmapi.lib"); gccLibs = @("-luser32", "-ldwmapi") }
)
foreach ($t in $optionalTargets) {
    Write-Host "Building optional $(Split-Path $t.out -Leaf)..."
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
        Write-Host "  WARNING: optional helper failed to build (non-fatal): $($t.out)"
    }
}

# parakeet_cpp_transcriber.exe — local on-device dictation (parakeet.cpp / ggml).
# Best-effort and fully non-fatal: a failure here just leaves Windows users on
# cloud dictation rather than blocking the required native tarball.
function Build-ParakeetCpp {
    $cmake = Get-Command cmake -ErrorAction SilentlyContinue
    if (-not $cmake) { Write-Host "Skipping parakeet_cpp_transcriber: cmake not on PATH."; return }
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { Write-Host "Skipping parakeet_cpp_transcriber: git not on PATH."; return }

    $work = Join-Path $env:TEMP ("parakeet-cpp-" + [System.Guid]::NewGuid().ToString("N"))
    $src = Join-Path $work "parakeet.cpp"
    $log = Join-Path $work "build.log"
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    try {
        Write-Host "Cloning parakeet.cpp ($ParakeetCppCommit)..."
        & git clone --quiet $ParakeetCppRepo $src 2>&1 | Out-File -FilePath $log -Encoding utf8
        if ($LASTEXITCODE -ne 0) { Write-Host "  WARNING: clone failed (non-fatal)"; return }
        & git -C $src checkout --quiet $ParakeetCppCommit 2>&1 | Add-Content $log
        if ($LASTEXITCODE -ne 0) { Write-Host "  WARNING: checkout failed (non-fatal)"; return }
        & git -C $src submodule update --init --recursive --quiet 2>&1 | Add-Content $log
        if ($LASTEXITCODE -ne 0) { Write-Host "  WARNING: submodule init failed (non-fatal)"; return }

        $stella = Join-Path $src "examples\stella"
        New-Item -ItemType Directory -Force -Path $stella | Out-Null
        Copy-Item -Force (Join-Path $PSScriptRoot "src\parakeet-cpp\main.cpp") (Join-Path $stella "main.cpp")
        Copy-Item -Force (Join-Path $PSScriptRoot "src\parakeet-cpp\CMakeLists.txt") (Join-Path $stella "CMakeLists.txt")
        Add-Content -Path (Join-Path $src "CMakeLists.txt") -Value "add_subdirectory(examples/stella)"

        Write-Host "Building parakeet_cpp_transcriber (static, x64)..."
        # /FIcstdint: parakeet.cpp's backend.hpp uses int64_t without including
        # <cstdint>; force-include keeps the build robust across MSVC versions.
        # Static CRT (/MT) so the shipped helper needs no VC++ redistributable.
        & cmake -S $src -B (Join-Path $src "build") -A x64 `
            -DCMAKE_BUILD_TYPE=Release `
            -DCMAKE_CXX_FLAGS="/FIcstdint" `
            -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded `
            -DPARAKEET_SHARED=OFF `
            -DBUILD_SHARED_LIBS=OFF `
            -DPARAKEET_BUILD_CLI=OFF `
            -DPARAKEET_BUILD_TESTS=OFF `
            -DGGML_NATIVE=OFF 2>&1 | Add-Content $log
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  WARNING: cmake configure failed (non-fatal)"
            Get-Content $log -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
            return
        }
        & cmake --build (Join-Path $src "build") --config Release --target parakeet_cpp_transcriber 2>&1 | Add-Content $log
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  WARNING: cmake build failed (non-fatal)"
            Get-Content $log -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
            return
        }

        $built = Join-Path $src "build\stella-helper\parakeet_cpp_transcriber.exe"
        if (-not (Test-Path $built)) { Write-Host "  WARNING: binary not found after build (non-fatal)"; return }
        Copy-Item -Force $built (Join-Path $outputDir "parakeet_cpp_transcriber.exe")
        Write-Host "  Build successful: parakeet_cpp_transcriber.exe"
    } finally {
        Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    }
}
Write-Host "Building parakeet_cpp_transcriber.exe..."
Build-ParakeetCpp

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
