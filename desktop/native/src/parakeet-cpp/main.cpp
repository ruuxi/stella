// parakeet_cpp_transcriber — local dictation helper for platforms without the
// CoreML/ANE path (Windows, Intel macOS). Wraps parakeet.cpp's flat C-API
// (libparakeet) and speaks the exact same newline-delimited JSON protocol as
// the Swift CoreML helper (`parakeet_transcriber`) so the Electron service in
// `desktop/electron/dictation/local-parakeet.ts` is engine-agnostic.
//
// Commands:
//   --probe                                  -> {"ok":true,"model":...}
//   --transcribe --audio <wav> --model <gguf>
//   --serve --model <gguf>                   load once, then read one JSON
//                                            request per line from stdin:
//                                              {"id":"...","audioPath":"..."}
//                                            and emit one JSON response per line.
//
// The model is downloaded/cached on the TypeScript side; this binary only ever
// receives a concrete `--model <path>` and never touches the network.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <iostream>

#include "parakeet_capi.h"

namespace {

constexpr const char* kModelId = "parakeet-tdt-0.6b-v3-gguf";

std::string jsonEscape(const std::string& in) {
  std::string out;
  out.reserve(in.size() + 16);
  for (char c : in) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += c;
        }
    }
  }
  return out;
}

void emit(bool ok, const char* transcript, const char* error, const char* id) {
  std::string line = "{\"ok\":";
  line += ok ? "true" : "false";
  line += ",\"model\":\"";
  line += kModelId;
  line += "\"";
  line += ",\"transcript\":";
  if (transcript) {
    line += "\"";
    line += jsonEscape(transcript);
    line += "\"";
  } else {
    line += "null";
  }
  line += ",\"error\":";
  if (error) {
    line += "\"";
    line += jsonEscape(error);
    line += "\"";
  } else {
    line += "null";
  }
  if (id) {
    line += ",\"id\":\"";
    line += jsonEscape(id);
    line += "\"";
  }
  line += "}\n";
  std::fputs(line.c_str(), stdout);
  std::fflush(stdout);
}

// Extract a string field's value from a single-line JSON object. The input is
// always produced by our own TS service, so this only needs to handle
// well-formed `"key":"value"` pairs with standard JSON string escapes.
bool extractJsonString(const std::string& json, const std::string& key,
                       std::string& out) {
  const std::string needle = "\"" + key + "\"";
  size_t pos = json.find(needle);
  if (pos == std::string::npos) return false;
  pos = json.find(':', pos + needle.size());
  if (pos == std::string::npos) return false;
  pos = json.find('"', pos);
  if (pos == std::string::npos) return false;
  ++pos;
  out.clear();
  while (pos < json.size()) {
    char c = json[pos];
    if (c == '"') return true;
    if (c == '\\' && pos + 1 < json.size()) {
      char n = json[pos + 1];
      switch (n) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'u': {
          if (pos + 5 < json.size()) {
            // Pass through BMP escapes as-is in UTF-8 for the ASCII range we
            // realistically see in file paths; higher code points are left
            // encoded since paths from our TS layer don't contain them.
            unsigned int code = 0;
            std::sscanf(json.substr(pos + 2, 4).c_str(), "%4x", &code);
            if (code < 0x80) {
              out += static_cast<char>(code);
            } else if (code < 0x800) {
              out += static_cast<char>(0xC0 | (code >> 6));
              out += static_cast<char>(0x80 | (code & 0x3F));
            } else {
              out += static_cast<char>(0xE0 | (code >> 12));
              out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
              out += static_cast<char>(0x80 | (code & 0x3F));
            }
            pos += 4;
          }
          break;
        }
        default: out += n; break;
      }
      pos += 2;
      continue;
    }
    out += c;
    ++pos;
  }
  return false;
}

const char* argValue(int argc, char** argv, const char* name) {
  for (int i = 0; i < argc - 1; ++i) {
    if (std::strcmp(argv[i], name) == 0) return argv[i + 1];
  }
  return nullptr;
}

bool hasArg(int argc, char** argv, const char* name) {
  for (int i = 0; i < argc; ++i) {
    if (std::strcmp(argv[i], name) == 0) return true;
  }
  return false;
}

int transcribeOnce(parakeet_ctx* ctx, const char* wavPath, std::string& out,
                   std::string& err) {
  char* text = parakeet_capi_transcribe_path(ctx, wavPath, 0);
  if (!text) {
    const char* last = parakeet_capi_last_error(ctx);
    err = (last && *last) ? last : "transcription failed";
    return 1;
  }
  out = text;
  parakeet_capi_free_string(text);
  return 0;
}

int runServe(const char* modelPath) {
  if (!modelPath) {
    emit(false, nullptr, "Missing required argument --model.", nullptr);
    return 1;
  }
  parakeet_ctx* ctx = parakeet_capi_load(modelPath);
  if (!ctx) {
    emit(false, nullptr, "Failed to load Parakeet model.", nullptr);
    return 1;
  }
  // Ready signal (no id), matching the Swift helper's serve handshake.
  emit(true, nullptr, nullptr, nullptr);

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    std::string id;
    std::string audioPath;
    extractJsonString(line, "id", id);
    if (!extractJsonString(line, "audioPath", audioPath)) {
      emit(false, nullptr, "Missing audioPath.", id.empty() ? nullptr : id.c_str());
      continue;
    }
    std::string transcript;
    std::string err;
    if (transcribeOnce(ctx, audioPath.c_str(), transcript, err) == 0) {
      emit(true, transcript.c_str(), nullptr, id.empty() ? nullptr : id.c_str());
    } else {
      emit(false, nullptr, err.c_str(), id.empty() ? nullptr : id.c_str());
    }
  }

  parakeet_capi_free(ctx);
  return 0;
}

int runTranscribe(int argc, char** argv) {
  const char* modelPath = argValue(argc, argv, "--model");
  const char* audioPath = argValue(argc, argv, "--audio");
  if (!modelPath) {
    emit(false, nullptr, "Missing required argument --model.", nullptr);
    return 1;
  }
  if (!audioPath) {
    emit(false, nullptr, "Missing required argument --audio.", nullptr);
    return 1;
  }
  parakeet_ctx* ctx = parakeet_capi_load(modelPath);
  if (!ctx) {
    emit(false, nullptr, "Failed to load Parakeet model.", nullptr);
    return 1;
  }
  std::string transcript;
  std::string err;
  int rc = transcribeOnce(ctx, audioPath, transcript, err);
  if (rc == 0) {
    emit(true, transcript.c_str(), nullptr, nullptr);
  } else {
    emit(false, nullptr, err.c_str(), nullptr);
  }
  parakeet_capi_free(ctx);
  return rc;
}

}  // namespace

int main(int argc, char** argv) {
  if (hasArg(argc, argv, "--probe")) {
    emit(true, nullptr, nullptr, nullptr);
    return 0;
  }
  if (hasArg(argc, argv, "--download")) {
    // Model fetch/caching is owned by the TS service; nothing to do here.
    emit(true, nullptr, nullptr, nullptr);
    return 0;
  }
  if (hasArg(argc, argv, "--serve")) {
    return runServe(argValue(argc, argv, "--model"));
  }
  if (hasArg(argc, argv, "--transcribe")) {
    return runTranscribe(argc, argv);
  }
  emit(false, nullptr,
       "Usage: parakeet_cpp_transcriber --probe | --download | "
       "--serve --model <gguf> | --transcribe --audio <wav> --model <gguf>",
       nullptr);
  return 1;
}
