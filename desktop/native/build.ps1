# Build script for mouse_block.exe
# Tries MSVC first, falls back to MinGW

$srcFile = "src\mouse_block.cpp"
$outFile = "mouse_block.exe"

Write-Host "Building mouse_block.exe..."

# Try MSVC (Visual Studio)
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vsWhere) {
    $vsPath = & $vsWhere -latest -property installationPath
    $vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
    
    if (Test-Path $vcvars) {
        Write-Host "Using MSVC..."
        # Run cl in a VS environment
        $cmd = "`"$vcvars`" && cl /O2 /EHsc /nologo $srcFile /link user32.lib /OUT:$outFile"
        cmd /c $cmd
        
        if (Test-Path $outFile) {
            Write-Host "Build successful: $outFile"
            exit 0
        }
    }
}

# Try MinGW (g++)
$gpp = Get-Command g++ -ErrorAction SilentlyContinue
if ($gpp) {
    Write-Host "Using MinGW g++..."
    & g++ -O2 -static $srcFile -o $outFile -luser32
    
    if (Test-Path $outFile) {
        Write-Host "Build successful: $outFile"
        exit 0
    }
}

# Try clang
$clang = Get-Command clang++ -ErrorAction SilentlyContinue
if ($clang) {
    Write-Host "Using clang++..."
    & clang++ -O2 $srcFile -o $outFile -luser32
    
    if (Test-Path $outFile) {
        Write-Host "Build successful: $outFile"
        exit 0
    }
}

Write-Host "ERROR: No C++ compiler found. Install one of:"
Write-Host "  - Visual Studio with C++ workload"
Write-Host "  - MinGW-w64 (g++)"
Write-Host "  - LLVM/Clang"
exit 1
