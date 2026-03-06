# Build script for native helpers
# Tries MSVC first, falls back to MinGW, then clang

$targets = @(
    @{ kind = "cpp"; src = "src\mouse_block.cpp"; out = "mouse_block.exe" },
    @{ kind = "cpp"; src = "src\window_info.cpp"; out = "window_info.exe" },
    @{ kind = "csharp"; src = "src\audio_ducking.cs"; out = "audio_ducking.exe" }
)

function Build-WithMSVC($vcvars, $srcFile, $outFile) {
    if (Test-Path $outFile) {
        Remove-Item $outFile -Force
    }
    $cwd = (Get-Location).Path
    $cmd = "call `"$vcvars`" && cd /d `"$cwd`" && cl /O2 /EHsc /nologo `"$srcFile`" /link user32.lib gdi32.lib gdiplus.lib ole32.lib uuid.lib /OUT:`"$outFile`""
    cmd /c $cmd
    return ($LASTEXITCODE -eq 0 -and (Test-Path $outFile))
}

function Build-WithGpp($srcFile, $outFile) {
    if (Test-Path $outFile) {
        Remove-Item $outFile -Force
    }
    & g++ -O2 -static $srcFile -o $outFile -luser32 -lgdi32 -lgdiplus -lole32 -luuid
    return ($LASTEXITCODE -eq 0 -and (Test-Path $outFile))
}

function Build-WithClang($srcFile, $outFile) {
    if (Test-Path $outFile) {
        Remove-Item $outFile -Force
    }
    & clang++ -O2 $srcFile -o $outFile -luser32 -lgdi32 -lgdiplus -lole32 -luuid
    return ($LASTEXITCODE -eq 0 -and (Test-Path $outFile))
}

function Build-WithCSharp($cscPath, $srcFile, $outFile) {
    if (Test-Path $outFile) {
        Remove-Item $outFile -Force
    }
    & $cscPath /nologo /optimize+ /target:exe /out:$outFile $srcFile
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
$cscPath = $null
$cscCandidates = @()
if ($vsPath) {
    $cscCandidates += (Join-Path $vsPath "MSBuild\Current\Bin\Roslyn\csc.exe")
    $cscCandidates += (Join-Path $vsPath "MSBuild\Current\Bin\csc.exe")
}
$commandCsc = Get-Command csc.exe -ErrorAction SilentlyContinue
if ($commandCsc) {
    $cscCandidates += $commandCsc.Source
}
foreach ($candidate in $cscCandidates | Select-Object -Unique) {
    if ($candidate -and (Test-Path $candidate)) {
        $cscPath = $candidate
        break
    }
}

if (-not $vcvars -and -not $hasGpp -and -not $hasClang -and -not $cscPath) {
    Write-Host "ERROR: No C++ compiler found. Install one of:"
    Write-Host "  - Visual Studio with C++ workload"
    Write-Host "  - MinGW-w64 (g++)"
    Write-Host "  - LLVM/Clang"
    Write-Host "  - Visual Studio / Roslyn (csc.exe)"
    exit 1
}

$allOk = $true
foreach ($t in $targets) {
    Write-Host "Building $($t.out)..."
    $built = $false

    if ($t.kind -eq "csharp") {
        if ($cscPath -and -not $built) {
            Write-Host "  Using C# compiler..."
            $built = Build-WithCSharp $cscPath $t.src $t.out
        }
    } else {
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
