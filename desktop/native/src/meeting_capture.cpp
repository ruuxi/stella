// meeting_capture.exe - Granola-style dual-stream meeting recorder for Stella.
//
// Windows counterpart of src/meeting_capture.swift. Captures system audio
// (everyone else on the call, no meeting bot required) via WASAPI loopback on
// the default render endpoint, AND the local microphone (you) via WASAPI
// capture on the default capture endpoint, as two independent PCM streams
// written to disk as rolling WAV segments. Keeping the streams separate gives a
// downstream transcriber clean "you vs them" speaker separation for free.
//
// On-disk layout matches the macOS helper exactly so the downstream consumer is
// platform-agnostic (all under <stellaHome>\meetings\):
//   meeting_capture.pid           Daemon pid (best-effort, cleaned on exit)
//   meeting_capture.state.json    { running, recording, paused, sessionId, startedAtMs, segmentSeconds }
//   <sessionId>\session.json      { sessionId, startedAtMs, endedAtMs, segmentSeconds, streams: {...} }
//   <sessionId>\segments.jsonl    One line per finalized WAV segment
//   <sessionId>\system\seg-<idx>-<startMs>.wav
//   <sessionId>\mic\seg-<idx>-<startMs>.wav
//
// IPC: a named pipe (\\.\pipe\stella-mtgcap-<hash-of-root>) is the Windows
// analog of the macOS AF_UNIX socket. Commands are single line/message:
//   daemon | start [id] [seg] | pause | resume | stop | status | ping | shutdown
//
// Permissions: WASAPI loopback needs no special permission. The microphone is
// governed by the Windows mic privacy setting; capture is best-effort and a
// recording still proceeds system-audio-only if the mic is unavailable.
//
// Compile (MSVC):
//   cl /O2 /EHsc meeting_capture.cpp /link ole32.lib oleaut32.lib uuid.lib /OUT:meeting_capture.exe
// Compile (mingw-w64):
//   g++ -O2 -static meeting_capture.cpp -o meeting_capture.exe -lole32 -loleaut32 -luuid

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <initguid.h>
#include <windows.h>
#include <shellapi.h>
#include <mmreg.h>
#include <mmdeviceapi.h>
#include <audioclient.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <cwctype>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

static const int64_t REFTIMES_PER_SEC = 10000000; // 100-ns units in one second

static int64_t nowMs()
{
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    ULARGE_INTEGER uli;
    uli.LowPart = ft.dwLowDateTime;
    uli.HighPart = ft.dwHighDateTime;
    // FILETIME is 100-ns ticks since 1601-01-01; convert to ms since 1970.
    const int64_t EPOCH_DIFF_100NS = 116444736000000000LL;
    return (int64_t)((uli.QuadPart - EPOCH_DIFF_100NS) / 10000);
}

static std::string utf8(const std::wstring& ws)
{
    if (ws.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, ws.data(), (int)ws.size(), NULL, 0, NULL, NULL);
    if (n <= 0) return std::string();
    std::string out((size_t)n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, ws.data(), (int)ws.size(), &out[0], n, NULL, NULL);
    return out;
}

static std::wstring lowerW(const std::wstring& s)
{
    std::wstring out = s;
    for (auto& c : out) c = (wchar_t)towlower(c);
    return out;
}

// Stable per-root pipe name. The Electron host passes an identical --root to
// the daemon and to every client command, so both derive the same name.
static std::wstring pipeNameForRoot(const std::wstring& root)
{
    std::wstring norm = lowerW(root);
    while (!norm.empty() && (norm.back() == L'\\' || norm.back() == L'/')) norm.pop_back();
    uint64_t h = 1469598103934665603ULL;
    for (wchar_t c : norm) {
        h ^= (uint64_t)(c & 0xFF);
        h *= 1099511628211ULL;
        h ^= (uint64_t)((c >> 8) & 0xFF);
        h *= 1099511628211ULL;
    }
    wchar_t buf[64];
    swprintf(buf, 64, L"\\\\.\\pipe\\stella-mtgcap-%016llx", (unsigned long long)h);
    return std::wstring(buf);
}

// ---------------------------------------------------------------------------
// Filesystem (wide Win32 APIs so non-ASCII home paths work)
// ---------------------------------------------------------------------------

static std::wstring joinW(const std::wstring& a, const std::wstring& b)
{
    if (a.empty()) return b;
    wchar_t last = a.back();
    if (last == L'\\' || last == L'/') return a + b;
    return a + L"\\" + b;
}

static void ensureDirW(const std::wstring& path)
{
    std::wstring acc;
    size_t i = 0;
    while (i < path.size()) {
        wchar_t c = path[i];
        acc.push_back(c);
        if (c == L'\\' || c == L'/') {
            if (acc.size() > 1) CreateDirectoryW(acc.c_str(), NULL);
        }
        ++i;
    }
    CreateDirectoryW(path.c_str(), NULL);
}

static void writeFileW(const std::wstring& path, const std::string& contents)
{
    HANDLE h = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, NULL,
                           CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    DWORD written = 0;
    WriteFile(h, contents.data(), (DWORD)contents.size(), &written, NULL);
    CloseHandle(h);
}

static void appendFileW(const std::wstring& path, const std::string& line)
{
    HANDLE h = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    SetFilePointer(h, 0, NULL, FILE_END);
    DWORD written = 0;
    WriteFile(h, line.data(), (DWORD)line.size(), &written, NULL);
    CloseHandle(h);
}

static void removeFileW(const std::wstring& path)
{
    DeleteFileW(path.c_str());
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

struct MeetingArgs {
    std::wstring command;
    std::wstring stellaHome;
    std::wstring sessionId;
    bool hasSessionId = false;
    int segmentSeconds = 30;
};

static MeetingArgs parseArgs()
{
    MeetingArgs args;
    int wArgc = 0;
    LPWSTR* wArgv = CommandLineToArgvW(GetCommandLineW(), &wArgc);
    if (!wArgv) return args;
    std::vector<std::wstring> raw;
    for (int i = 1; i < wArgc; ++i) raw.push_back(wArgv[i]);
    LocalFree(wArgv);

    if (!raw.empty()) args.command = raw[0];
    size_t i = 1;
    auto eq = [](const std::wstring& s, const wchar_t* p) {
        size_t n = wcslen(p);
        return s.size() >= n && wcsncmp(s.c_str(), p, n) == 0;
    };
    while (i < raw.size()) {
        const std::wstring& a = raw[i];
        if (a == L"--root" && i + 1 < raw.size()) { args.stellaHome = raw[i + 1]; i += 2; }
        else if (eq(a, L"--root=")) { args.stellaHome = a.substr(7); i += 1; }
        else if (a == L"--session-id" && i + 1 < raw.size()) { args.sessionId = raw[i + 1]; args.hasSessionId = true; i += 2; }
        else if (eq(a, L"--session-id=")) { args.sessionId = a.substr(13); args.hasSessionId = true; i += 1; }
        else if (a == L"--segment-seconds" && i + 1 < raw.size()) { args.segmentSeconds = _wtoi(raw[i + 1].c_str()); i += 2; }
        else if (eq(a, L"--segment-seconds=")) { args.segmentSeconds = _wtoi(a.substr(18).c_str()); i += 1; }
        else { i += 1; }
    }
    if (args.segmentSeconds <= 0) args.segmentSeconds = 30;
    return args;
}

static std::string generateSessionId()
{
    unsigned r = ((unsigned)nowMs() ^ GetCurrentProcessId()) & 0xFFFF;
    char buf[64];
    snprintf(buf, sizeof(buf), "mtg-%lld-%04x", (long long)nowMs(), r);
    return std::string(buf);
}

static std::string sanitizeSessionId(const std::string& id)
{
    std::string out;
    for (char c : id) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_') {
            out.push_back(c);
        }
    }
    return out.empty() ? generateSessionId() : out;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

struct MeetingPaths {
    std::wstring root;
    std::wstring stateDir() const { return joinW(root, L"meetings"); }
    std::wstring pidPath() const { return joinW(stateDir(), L"meeting_capture.pid"); }
    std::wstring statePath() const { return joinW(stateDir(), L"meeting_capture.state.json"); }
    std::wstring sessionDir(const std::string& id) const {
        std::wstring wid(id.begin(), id.end());
        return joinW(stateDir(), wid);
    }
};

// ---------------------------------------------------------------------------
// WAV writer (Win32 handles for MSVC/MinGW/clang portability)
// ---------------------------------------------------------------------------

class WavWriter {
public:
    std::wstring path;
    uint32_t sampleRate;
    uint16_t channels;
    int64_t startedAtMs;
    uint32_t dataBytes = 0;

    WavWriter(const std::wstring& p, uint32_t sr, uint16_t ch, int64_t startMs)
        : path(p), sampleRate(sr), channels(ch), startedAtMs(startMs)
    {
        handle_ = CreateFileW(p.c_str(), GENERIC_WRITE, FILE_SHARE_READ, NULL,
                              CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
        if (handle_ != INVALID_HANDLE_VALUE) writeHeaderPlaceholder();
    }

    bool ok() const { return handle_ != INVALID_HANDLE_VALUE; }

    void appendSamples(const int16_t* samples, size_t count)
    {
        if (handle_ == INVALID_HANDLE_VALUE || count == 0) return;
        DWORD bytes = (DWORD)(count * sizeof(int16_t));
        DWORD written = 0;
        WriteFile(handle_, samples, bytes, &written, NULL);
        dataBytes += written;
    }

    void appendSilenceFrames(uint32_t frames)
    {
        if (handle_ == INVALID_HANDLE_VALUE || frames == 0 || channels == 0) return;
        std::vector<int16_t> zeros((size_t)frames * channels, 0);
        appendSamples(zeros.data(), zeros.size());
    }

    int64_t close()
    {
        if (handle_ == INVALID_HANDLE_VALUE) return 0;
        uint32_t byteRate = sampleRate * channels * 2;
        DWORD written = 0;
        uint32_t riffSize = 36 + dataBytes;
        SetFilePointer(handle_, 4, NULL, FILE_BEGIN);
        WriteFile(handle_, &riffSize, 4, &written, NULL);
        SetFilePointer(handle_, 40, NULL, FILE_BEGIN);
        WriteFile(handle_, &dataBytes, 4, &written, NULL);
        CloseHandle(handle_);
        handle_ = INVALID_HANDLE_VALUE;
        if (byteRate == 0) return 0;
        return (int64_t)((double)dataBytes / (double)byteRate * 1000.0);
    }

private:
    HANDLE handle_ = INVALID_HANDLE_VALUE;

    void writeU32(uint32_t v) { DWORD w = 0; WriteFile(handle_, &v, 4, &w, NULL); }
    void writeU16(uint16_t v) { DWORD w = 0; WriteFile(handle_, &v, 2, &w, NULL); }
    void writeTag(const char* t) { DWORD w = 0; WriteFile(handle_, t, 4, &w, NULL); }

    void writeHeaderPlaceholder()
    {
        uint16_t bits = 16;
        uint32_t byteRate = sampleRate * channels * (bits / 8);
        uint16_t blockAlign = channels * (bits / 8);
        writeTag("RIFF");
        writeU32(0); // patched on close
        writeTag("WAVE");
        writeTag("fmt ");
        writeU32(16);
        writeU16(1); // PCM
        writeU16(channels);
        writeU32(sampleRate);
        writeU32(byteRate);
        writeU16(blockAlign);
        writeU16(bits);
        writeTag("data");
        writeU32(0); // patched on close
    }
};

// ---------------------------------------------------------------------------
// Per-stream segmenter (rolling WAV segments + wall-clock silence padding)
// ---------------------------------------------------------------------------

class StreamSegmenter {
public:
    std::string streamName;
    std::wstring dir;
    std::wstring segmentsLogPath;
    int segmentSeconds;
    uint32_t sampleRate = 0;
    uint16_t channels = 0;
    int segmentCount = 0;

    StreamSegmenter(const std::string& name, const std::wstring& sessionDir,
                    const std::wstring& segLog, int segSeconds)
        : streamName(name), segmentsLogPath(segLog),
          segmentSeconds(segSeconds < 1 ? 1 : segSeconds)
    {
        std::wstring wname(name.begin(), name.end());
        dir = joinW(sessionDir, wname);
        ensureDirW(dir);
    }

    void ingest(const int16_t* samples, size_t count, uint32_t sr, uint16_t ch, int64_t now)
    {
        if (ch == 0 || sr == 0) return;
        if (sampleRate == 0) {
            sampleRate = sr;
            channels = ch;
            streamStartMs_ = now;
            totalFrames_ = 0;
        }

        if (current_ && now - current_->startedAtMs >= (int64_t)segmentSeconds * 1000) {
            finalizeCurrent(now);
        }
        if (!current_) {
            std::wstring file = dir + L"\\seg-" + std::to_wstring(index_) + L"-" +
                                std::to_wstring((long long)now) + L".wav";
            current_.reset(new WavWriter(file, sr, ch, now));
        }
        if (!current_) return;

        // Pad with silence to keep the file wall-clock aligned (WASAPI loopback
        // delivers no packets while the system is silent). Bounded so a stalled
        // thread can't write a runaway block.
        int64_t elapsedMs = now - streamStartMs_;
        uint64_t expectedFrames = (uint64_t)((double)elapsedMs * (double)sampleRate / 1000.0);
        if (expectedFrames > totalFrames_) {
            uint64_t deficit = expectedFrames - totalFrames_;
            uint64_t minPad = sampleRate / 50; // ignore < ~20ms jitter
            uint64_t maxPad = (uint64_t)sampleRate * 5;
            if (deficit >= minPad) {
                if (deficit > maxPad) deficit = maxPad;
                current_->appendSilenceFrames((uint32_t)deficit);
                totalFrames_ += deficit;
            }
        }

        current_->appendSamples(samples, count);
        totalFrames_ += count / (channels == 0 ? 1 : channels);
    }

    void finalizeCurrent(int64_t endedAtMs)
    {
        if (!current_) return;
        int64_t durationMs = current_->close();
        std::wstring wfile = current_->path;
        size_t slash = wfile.find_last_of(L"\\/");
        std::wstring base = slash == std::wstring::npos ? wfile : wfile.substr(slash + 1);
        std::string entry = "{";
        entry += "\"stream\":\"" + streamName + "\",";
        entry += "\"index\":" + std::to_string(index_) + ",";
        entry += "\"file\":\"" + utf8(base) + "\",";
        entry += "\"startedAtMs\":" + std::to_string((long long)current_->startedAtMs) + ",";
        entry += "\"endedAtMs\":" + std::to_string((long long)endedAtMs) + ",";
        entry += "\"durationMs\":" + std::to_string((long long)durationMs) + ",";
        entry += "\"sampleRate\":" + std::to_string((unsigned)current_->sampleRate) + ",";
        entry += "\"channels\":" + std::to_string((unsigned)current_->channels);
        entry += "}\n";
        appendFileW(segmentsLogPath, entry);
        index_ += 1;
        segmentCount += 1;
        current_.reset();
    }

private:
    std::unique_ptr<WavWriter> current_;
    int index_ = 0;
    int64_t streamStartMs_ = 0;
    uint64_t totalFrames_ = 0;
};

// ---------------------------------------------------------------------------
// WASAPI capture
// ---------------------------------------------------------------------------

struct CaptureFormat {
    uint32_t sampleRate = 0;
    uint16_t channels = 0;
    int bytesPerSample = 0; // source bytes per single channel sample
    int kind = 0;           // 0 = unknown, 1 = float32, 2 = pcm16, 3 = pcm32
};

static CaptureFormat classifyFormat(const WAVEFORMATEX* wfx)
{
    CaptureFormat fmt;
    fmt.sampleRate = wfx->nSamplesPerSec;
    fmt.channels = wfx->nChannels;
    fmt.bytesPerSample = wfx->wBitsPerSample / 8;

    WORD tag = wfx->wFormatTag;
    if (tag == WAVE_FORMAT_EXTENSIBLE) {
        const WAVEFORMATEXTENSIBLE* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(wfx);
        // KSDATAFORMAT_SUBTYPE_{IEEE_FLOAT,PCM} carry the legacy format tag in
        // SubFormat.Data1, so we can classify without linking the KS GUIDs.
        tag = (WORD)ext->SubFormat.Data1;
    }
    if (tag == WAVE_FORMAT_IEEE_FLOAT && wfx->wBitsPerSample == 32) fmt.kind = 1;
    else if (tag == WAVE_FORMAT_PCM && wfx->wBitsPerSample == 16) fmt.kind = 2;
    else if (tag == WAVE_FORMAT_PCM && wfx->wBitsPerSample == 32) fmt.kind = 3;
    return fmt;
}

static void convertToInt16(const BYTE* data, uint32_t numFrames, const CaptureFormat& fmt,
                           std::vector<int16_t>& out)
{
    size_t totalSamples = (size_t)numFrames * fmt.channels;
    out.resize(totalSamples);
    if (fmt.kind == 1) {
        const float* src = reinterpret_cast<const float*>(data);
        for (size_t i = 0; i < totalSamples; ++i) {
            float v = src[i];
            if (v > 1.0f) v = 1.0f;
            if (v < -1.0f) v = -1.0f;
            out[i] = (int16_t)(v * 32767.0f);
        }
    } else if (fmt.kind == 2) {
        memcpy(out.data(), data, totalSamples * sizeof(int16_t));
    } else if (fmt.kind == 3) {
        const int32_t* src = reinterpret_cast<const int32_t*>(data);
        for (size_t i = 0; i < totalSamples; ++i) {
            out[i] = (int16_t)(src[i] >> 16);
        }
    }
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

class Recorder {
public:
    explicit Recorder(const MeetingPaths& paths) : paths_(paths) {}

    bool isRecording()
    {
        std::lock_guard<std::mutex> lock(mutex_);
        return recording_;
    }

    std::string start(bool hasId, const std::string& requestedId, int segmentSeconds)
    {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (recording_) return "{\"ok\":false,\"error\":\"already-recording\"}";
        }

        std::string id = hasId ? sanitizeSessionId(requestedId) : generateSessionId();
        std::wstring dir = paths_.sessionDir(id);
        ensureDirW(dir);
        std::wstring segLog = joinW(dir, L"segments.jsonl");

        {
            std::lock_guard<std::mutex> lock(mutex_);
            recording_ = true;
            paused_ = false;
            stopFlag_ = false;
            sessionId_ = id;
            sessionDir_ = dir;
            startedAtMs_ = nowMs();
            segmentSeconds_ = segmentSeconds;
            systemSeg_.reset(new StreamSegmenter("system", dir, segLog, segmentSeconds));
            micSeg_.reset(new StreamSegmenter("mic", dir, segLog, segmentSeconds));
        }

        std::promise<bool> sysProm;
        std::promise<bool> micProm;
        std::future<bool> sysFut = sysProm.get_future();
        std::future<bool> micFut = micProm.get_future();
        systemThread_ = std::thread(&Recorder::captureLoop, this, true, std::move(sysProm));
        micThread_ = std::thread(&Recorder::captureLoop, this, false, std::move(micProm));

        bool sysOk = sysFut.wait_for(std::chrono::seconds(3)) == std::future_status::ready && sysFut.get();
        bool micOk = micFut.wait_for(std::chrono::seconds(3)) == std::future_status::ready && micFut.get();

        if (!sysOk && !micOk) {
            stop();
            return "{\"ok\":false,\"error\":\"no-audio-streams\"}";
        }

        writeSessionJson(false);

        std::string out = "{";
        out += "\"ok\":true,";
        out += "\"sessionId\":\"" + id + "\",";
        out += "\"dir\":\"" + jsonEscape(utf8(dir)) + "\",";
        out += "\"segmentSeconds\":" + std::to_string(segmentSeconds) + ",";
        out += "\"system\":" + std::string(sysOk ? "true" : "false") + ",";
        out += "\"mic\":" + std::string(micOk ? "true" : "false") + ",";
        out += "\"startedAtMs\":" + std::to_string((long long)startedAtMs_);
        out += "}";
        return out;
    }

    bool setPaused(bool value)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!recording_) return false;
        paused_ = value;
        if (value) {
            int64_t now = nowMs();
            if (systemSeg_) systemSeg_->finalizeCurrent(now);
            if (micSeg_) micSeg_->finalizeCurrent(now);
        }
        return true;
    }

    std::string stop()
    {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (!recording_) return "{\"ok\":false,\"error\":\"not-recording\"}";
        }

        // Signal threads without holding the mutex (they take it in ingest()).
        stopFlag_ = true;
        if (systemThread_.joinable()) systemThread_.join();
        if (micThread_.joinable()) micThread_.join();

        std::string out;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            int64_t endedAt = nowMs();
            if (systemSeg_) systemSeg_->finalizeCurrent(endedAt);
            if (micSeg_) micSeg_->finalizeCurrent(endedAt);
            int systemSegments = systemSeg_ ? systemSeg_->segmentCount : 0;
            int micSegments = micSeg_ ? micSeg_->segmentCount : 0;
            int64_t durationMs = endedAt - startedAtMs_;
            out = "{";
            out += "\"ok\":true,";
            out += "\"sessionId\":\"" + sessionId_ + "\",";
            out += "\"dir\":\"" + jsonEscape(utf8(sessionDir_)) + "\",";
            out += "\"durationMs\":" + std::to_string((long long)durationMs) + ",";
            out += "\"systemSegments\":" + std::to_string(systemSegments) + ",";
            out += "\"micSegments\":" + std::to_string(micSegments);
            out += "}";
        }

        writeSessionJson(true);

        {
            std::lock_guard<std::mutex> lock(mutex_);
            recording_ = false;
            paused_ = false;
            sessionId_.clear();
            sessionDir_.clear();
            startedAtMs_ = 0;
            systemSeg_.reset();
            micSeg_.reset();
        }
        return out;
    }

    std::string statusJson()
    {
        std::lock_guard<std::mutex> lock(mutex_);
        std::string out = "{";
        out += "\"running\":true,";
        out += "\"recording\":" + std::string(recording_ ? "true" : "false") + ",";
        out += "\"paused\":" + std::string(paused_ ? "true" : "false") + ",";
        out += "\"sessionId\":\"" + sessionId_ + "\",";
        out += "\"startedAtMs\":" + std::to_string((long long)(recording_ ? startedAtMs_ : 0)) + ",";
        out += "\"segmentSeconds\":" + std::to_string(segmentSeconds_) + ",";
        out += "\"screenPermission\":true,";
        out += "\"pid\":" + std::to_string((unsigned long)GetCurrentProcessId());
        out += "}";
        return out;
    }

    std::string stateJson(bool running)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        std::string out = "{";
        out += "\"running\":" + std::string(running ? "true" : "false") + ",";
        out += "\"recording\":" + std::string(recording_ ? "true" : "false") + ",";
        out += "\"paused\":" + std::string(paused_ ? "true" : "false") + ",";
        out += "\"sessionId\":\"" + sessionId_ + "\",";
        out += "\"startedAtMs\":" + std::to_string((long long)(recording_ ? startedAtMs_ : 0)) + ",";
        out += "\"segmentSeconds\":" + std::to_string(segmentSeconds_);
        out += "}";
        return out;
    }

private:
    static std::string jsonEscape(const std::string& s)
    {
        std::string out;
        for (char ch : s) {
            unsigned char c = (unsigned char)ch;
            switch (c) {
                case '"': out += "\\\""; break;
                case '\\': out += "\\\\"; break;
                case '\b': out += "\\b"; break;
                case '\f': out += "\\f"; break;
                case '\n': out += "\\n"; break;
                case '\r': out += "\\r"; break;
                case '\t': out += "\\t"; break;
                default:
                    if (c < 0x20) { char b[8]; snprintf(b, sizeof(b), "\\u%04x", c); out += b; }
                    else out.push_back((char)c);
            }
        }
        return out;
    }

    void ingest(bool system, const int16_t* samples, size_t count, uint32_t sr, uint16_t ch)
    {
        int64_t now = nowMs();
        std::lock_guard<std::mutex> lock(mutex_);
        if (!recording_ || paused_) return;
        StreamSegmenter* seg = system ? systemSeg_.get() : micSeg_.get();
        if (seg) seg->ingest(samples, count, sr, ch, now);
    }

    void captureLoop(bool loopback, std::promise<bool> initPromise)
    {
        bool announced = false;
        auto announce = [&](bool ok) {
            if (!announced) { announced = true; initPromise.set_value(ok); }
        };

        HRESULT hrCo = CoInitializeEx(NULL, COINIT_MULTITHREADED);
        bool needUninit = SUCCEEDED(hrCo);
        if (!needUninit && hrCo != RPC_E_CHANGED_MODE) { announce(false); return; }

        IMMDeviceEnumerator* enumerator = nullptr;
        IMMDevice* device = nullptr;
        IAudioClient* audioClient = nullptr;
        IAudioCaptureClient* captureClient = nullptr;
        WAVEFORMATEX* mixFormat = nullptr;
        bool started = false;

        auto cleanup = [&]() {
            if (captureClient) captureClient->Release();
            if (audioClient) { if (started) audioClient->Stop(); audioClient->Release(); }
            if (mixFormat) CoTaskMemFree(mixFormat);
            if (device) device->Release();
            if (enumerator) enumerator->Release();
            if (needUninit) CoUninitialize();
        };

        HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_INPROC_SERVER,
                                      __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
        if (FAILED(hr) || !enumerator) { announce(false); cleanup(); return; }

        // Loopback captures system output from the render endpoint; mic uses the
        // capture endpoint.
        hr = enumerator->GetDefaultAudioEndpoint(loopback ? eRender : eCapture, eConsole, &device);
        if (FAILED(hr) || !device) { announce(false); cleanup(); return; }

        hr = device->Activate(__uuidof(IAudioClient), CLSCTX_INPROC_SERVER, NULL, (void**)&audioClient);
        if (FAILED(hr) || !audioClient) { announce(false); cleanup(); return; }

        hr = audioClient->GetMixFormat(&mixFormat);
        if (FAILED(hr) || !mixFormat) { announce(false); cleanup(); return; }

        CaptureFormat fmt = classifyFormat(mixFormat);
        if (fmt.kind == 0 || fmt.channels == 0 || fmt.sampleRate == 0) { announce(false); cleanup(); return; }

        DWORD streamFlags = loopback ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0;
        hr = audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED, streamFlags,
                                     REFTIMES_PER_SEC, 0, mixFormat, NULL);
        if (FAILED(hr)) { announce(false); cleanup(); return; }

        hr = audioClient->GetService(__uuidof(IAudioCaptureClient), (void**)&captureClient);
        if (FAILED(hr) || !captureClient) { announce(false); cleanup(); return; }

        hr = audioClient->Start();
        if (FAILED(hr)) { announce(false); cleanup(); return; }
        started = true;
        announce(true);

        std::vector<int16_t> scratch;
        while (!stopFlag_) {
            UINT32 packetLength = 0;
            if (FAILED(captureClient->GetNextPacketSize(&packetLength))) break;
            while (packetLength != 0 && !stopFlag_) {
                BYTE* pData = nullptr;
                UINT32 numFrames = 0;
                DWORD flags = 0;
                hr = captureClient->GetBuffer(&pData, &numFrames, &flags, NULL, NULL);
                if (FAILED(hr)) break;
                if (numFrames > 0) {
                    if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                        scratch.assign((size_t)numFrames * fmt.channels, 0);
                    } else {
                        convertToInt16(pData, numFrames, fmt, scratch);
                    }
                    ingest(loopback, scratch.data(), scratch.size(), fmt.sampleRate, fmt.channels);
                }
                captureClient->ReleaseBuffer(numFrames);
                if (FAILED(captureClient->GetNextPacketSize(&packetLength))) { packetLength = 0; }
            }
            Sleep(10);
        }

        cleanup();
    }

    void writeSessionJson(bool ended)
    {
        std::string id, dir;
        int64_t started;
        int segSeconds;
        std::string sysMeta, micMeta;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            id = sessionId_;
            dir = utf8(sessionDir_);
            started = startedAtMs_;
            segSeconds = segmentSeconds_;
            auto meta = [](StreamSegmenter* s) -> std::string {
                if (!s) return "{\"available\":false}";
                std::string m = "{";
                m += "\"available\":" + std::string(s->sampleRate > 0 ? "true" : "false") + ",";
                m += "\"sampleRate\":" + std::to_string((unsigned)s->sampleRate) + ",";
                m += "\"channels\":" + std::to_string((unsigned)s->channels) + ",";
                m += "\"segments\":" + std::to_string(s->segmentCount);
                m += "}";
                return m;
            };
            sysMeta = meta(systemSeg_.get());
            micMeta = meta(micSeg_.get());
        }
        if (dir.empty()) return;

        std::string payload = "{";
        payload += "\"sessionId\":\"" + id + "\",";
        payload += "\"startedAtMs\":" + std::to_string((long long)started) + ",";
        payload += "\"segmentSeconds\":" + std::to_string(segSeconds) + ",";
        if (ended) {
            int64_t endedAt = nowMs();
            payload += "\"endedAtMs\":" + std::to_string((long long)endedAt) + ",";
            payload += "\"durationMs\":" + std::to_string((long long)(endedAt - started)) + ",";
        }
        payload += "\"streams\":{\"system\":" + sysMeta + ",\"mic\":" + micMeta + "}";
        payload += "}";

        // Rebuild the path from the wide field (the utf8 `dir` is only for JSON).
        std::wstring sessionPath;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            sessionPath = joinW(sessionDir_, L"session.json");
        }
        if (!sessionPath.empty()) writeFileW(sessionPath, payload);
    }

    MeetingPaths paths_;
    std::mutex mutex_;
    bool recording_ = false;
    bool paused_ = false;
    std::atomic<bool> stopFlag_{false};
    std::string sessionId_;
    std::wstring sessionDir_;
    int64_t startedAtMs_ = 0;
    int segmentSeconds_ = 30;
    std::unique_ptr<StreamSegmenter> systemSeg_;
    std::unique_ptr<StreamSegmenter> micSeg_;
    std::thread systemThread_;
    std::thread micThread_;
};

// ---------------------------------------------------------------------------
// Named pipe IPC
// ---------------------------------------------------------------------------

static void writePipe(HANDLE pipe, const std::string& s)
{
    DWORD written = 0;
    WriteFile(pipe, s.data(), (DWORD)s.size(), &written, NULL);
    FlushFileBuffers(pipe);
}

static bool readPipeLine(HANDLE pipe, std::string& out)
{
    char buf[4096];
    DWORD read = 0;
    if (!ReadFile(pipe, buf, sizeof(buf) - 1, &read, NULL) || read == 0) return false;
    buf[read] = 0;
    out.assign(buf, read);
    // trim trailing whitespace/newlines
    while (!out.empty() && (out.back() == '\n' || out.back() == '\r' ||
                            out.back() == ' ' || out.back() == '\0')) {
        out.pop_back();
    }
    return true;
}

static std::vector<std::string> splitTokens(const std::string& s)
{
    std::vector<std::string> out;
    size_t i = 0;
    while (i < s.size()) {
        while (i < s.size() && s[i] == ' ') ++i;
        size_t start = i;
        while (i < s.size() && s[i] != ' ') ++i;
        if (i > start) out.push_back(s.substr(start, i - start));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

static MeetingPaths* g_paths = nullptr;
static Recorder* g_recorder = nullptr;

static void daemonCleanup()
{
    if (g_recorder && g_recorder->isRecording()) g_recorder->stop();
    if (g_paths) {
        removeFileW(g_paths->pidPath());
        if (g_recorder) writeFileW(g_paths->statePath(), g_recorder->stateJson(false));
    }
}

static BOOL WINAPI consoleCtrlHandler(DWORD)
{
    daemonCleanup();
    return FALSE; // allow default termination
}

static int runDaemon(const MeetingPaths& paths, int defaultSegmentSeconds)
{
    ensureDirW(paths.stateDir());

    Recorder recorder(paths);
    MeetingPaths pathsCopy = paths;
    g_paths = &pathsCopy;
    g_recorder = &recorder;

    {
        char pidbuf[32];
        snprintf(pidbuf, sizeof(pidbuf), "%lu", (unsigned long)GetCurrentProcessId());
        writeFileW(paths.pidPath(), std::string(pidbuf));
    }
    writeFileW(paths.statePath(), recorder.stateJson(true));

    SetConsoleCtrlHandler(consoleCtrlHandler, TRUE);

    std::wstring pipeName = pipeNameForRoot(paths.root);

    while (true) {
        HANDLE pipe = CreateNamedPipeW(
            pipeName.c_str(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            8192, 8192, 0, NULL);
        if (pipe == INVALID_HANDLE_VALUE) {
            Sleep(200);
            continue;
        }

        BOOL connected = ConnectNamedPipe(pipe, NULL) ? TRUE : (GetLastError() == ERROR_PIPE_CONNECTED);
        if (!connected) {
            CloseHandle(pipe);
            continue;
        }

        std::string line;
        if (!readPipeLine(pipe, line)) {
            DisconnectNamedPipe(pipe);
            CloseHandle(pipe);
            continue;
        }

        std::vector<std::string> parts = splitTokens(line);
        std::string command = parts.empty() ? "" : parts[0];

        if (command == "ping") {
            writePipe(pipe, "pong");
        } else if (command == "start") {
            bool hasId = parts.size() > 1 && parts[1] != "-";
            std::string id = hasId ? parts[1] : "";
            int seg = defaultSegmentSeconds;
            if (parts.size() > 2) { int p = atoi(parts[2].c_str()); if (p > 0) seg = p; }
            std::string reply = recorder.start(hasId, id, seg);
            writeFileW(paths.statePath(), recorder.stateJson(true));
            writePipe(pipe, reply);
        } else if (command == "pause") {
            bool ok = recorder.setPaused(true);
            writeFileW(paths.statePath(), recorder.stateJson(true));
            writePipe(pipe, ok ? "{\"ok\":true}" : "{\"ok\":false}");
        } else if (command == "resume") {
            bool ok = recorder.setPaused(false);
            writeFileW(paths.statePath(), recorder.stateJson(true));
            writePipe(pipe, ok ? "{\"ok\":true}" : "{\"ok\":false}");
        } else if (command == "stop") {
            std::string reply = recorder.stop();
            writeFileW(paths.statePath(), recorder.stateJson(true));
            writePipe(pipe, reply);
        } else if (command == "status") {
            writePipe(pipe, recorder.statusJson());
        } else if (command == "shutdown") {
            writePipe(pipe, "{\"ok\":true}");
            DisconnectNamedPipe(pipe);
            CloseHandle(pipe);
            daemonCleanup();
            return 0;
        } else {
            writePipe(pipe, "{\"ok\":false,\"error\":\"unknown-command\"}");
        }

        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
    }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

static int sendCommand(const MeetingPaths& paths, const std::string& command)
{
    std::wstring pipeName = pipeNameForRoot(paths.root);
    HANDLE pipe = INVALID_HANDLE_VALUE;
    for (int attempt = 0; attempt < 20; ++attempt) {
        pipe = CreateFileW(pipeName.c_str(), GENERIC_READ | GENERIC_WRITE, 0, NULL,
                           OPEN_EXISTING, 0, NULL);
        if (pipe != INVALID_HANDLE_VALUE) break;
        if (GetLastError() != ERROR_PIPE_BUSY) break;
        if (!WaitNamedPipeW(pipeName.c_str(), 1000)) break;
    }
    if (pipe == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "meeting_capture: daemon not reachable\n");
        return 4;
    }
    DWORD mode = PIPE_READMODE_MESSAGE;
    SetNamedPipeHandleState(pipe, &mode, NULL, NULL);

    writePipe(pipe, command);
    std::string reply;
    if (readPipeLine(pipe, reply)) {
        fwrite(reply.data(), 1, reply.size(), stdout);
    }
    CloseHandle(pipe);
    return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

int main()
{
    MeetingArgs args = parseArgs();
    if (args.stellaHome.empty()) {
        fprintf(stderr, "meeting_capture: --root <stellaHome> is required\n");
        return 64;
    }

    MeetingPaths paths;
    paths.root = args.stellaHome;

    std::string cmd = utf8(args.command);
    if (cmd == "daemon") {
        return runDaemon(paths, args.segmentSeconds);
    } else if (cmd == "start") {
        std::string id = args.hasSessionId ? sanitizeSessionId(utf8(args.sessionId)) : "-";
        std::string c = "start " + id + " " + std::to_string(args.segmentSeconds);
        return sendCommand(paths, c);
    } else if (cmd == "pause") {
        return sendCommand(paths, "pause");
    } else if (cmd == "resume") {
        return sendCommand(paths, "resume");
    } else if (cmd == "stop") {
        return sendCommand(paths, "stop");
    } else if (cmd == "status") {
        return sendCommand(paths, "status");
    } else if (cmd == "ping") {
        return sendCommand(paths, "ping");
    } else if (cmd == "shutdown") {
        return sendCommand(paths, "shutdown");
    }

    fprintf(stderr, "meeting_capture: unknown command '%s'\n", cmd.c_str());
    fprintf(stderr, "Usage: meeting_capture {daemon|start|pause|resume|stop|status|ping|shutdown} --root <stellaHome>\n");
    return 64;
}
