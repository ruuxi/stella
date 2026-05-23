#include <CoreFoundation/CoreFoundation.h>
#include <Security/AuthorizationPlugin.h>
#include <Security/SecTask.h>
#include <errno.h>
#include <libproc.h>
#include <mach/message.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#define STELLA_LOCKED_USE_SOCKET_PATH "/tmp/com.stella.app.LockedComputerUse/Authorization.sock"
#define STELLA_EXPECTED_SIGNING_ID "desktop_automation"
#define STELLA_EXPECTED_SIGNING_ID_ARM64 "desktop_automation-arm64"
#define STELLA_EXPECTED_SIGNING_ID_X64 "desktop_automation-x64"
#define STELLA_EXPECTED_APP_SIGNING_ID "com.stella.app"

typedef struct StellaLockedUsePlugin {
  const AuthorizationCallbacks *callbacks;
} StellaLockedUsePlugin;

typedef struct StellaLockedUseMechanism {
  const AuthorizationCallbacks *callbacks;
  AuthorizationEngineRef engine;
} StellaLockedUseMechanism;

static bool cfstring_equals_cstr(CFStringRef value, const char *expected) {
  if (value == NULL || expected == NULL) {
    return false;
  }
  char buffer[512];
  if (!CFStringGetCString(value, buffer, sizeof(buffer), kCFStringEncodingUTF8)) {
    return false;
  }
  return strcmp(buffer, expected) == 0;
}

static bool cfstring_has_expected_signing_id(CFStringRef signing_id) {
  return cfstring_equals_cstr(signing_id, STELLA_EXPECTED_SIGNING_ID) ||
         cfstring_equals_cstr(signing_id, STELLA_EXPECTED_SIGNING_ID_ARM64) ||
         cfstring_equals_cstr(signing_id, STELLA_EXPECTED_SIGNING_ID_X64) ||
         cfstring_equals_cstr(signing_id, STELLA_EXPECTED_APP_SIGNING_ID);
}

static bool path_has_expected_executable(audit_token_t token) {
  char pathbuf[PROC_PIDPATHINFO_MAXSIZE] = {0};
  int length = proc_pidpath_audittoken(&token, pathbuf, sizeof(pathbuf));
  if (length <= 0) {
    return false;
  }
  const char *base = strrchr(pathbuf, '/');
  base = base == NULL ? pathbuf : base + 1;
  return strcmp(base, "desktop_automation") == 0;
}

static bool socket_peer_is_expected_service(int fd) {
  audit_token_t token;
  socklen_t token_len = sizeof(token);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &token_len) != 0 ||
      token_len != sizeof(token)) {
    return false;
  }

  CFErrorRef error = NULL;
  SecTaskRef task = SecTaskCreateWithAuditToken(kCFAllocatorDefault, token);
  if (task == NULL) {
    return false;
  }

  CFStringRef signing_id = SecTaskCopySigningIdentifier(task, &error);
  if (error != NULL) {
    CFRelease(error);
    error = NULL;
  }
  bool signing_ok = cfstring_has_expected_signing_id(signing_id);
  bool path_ok = path_has_expected_executable(token);

  if (signing_id != NULL) {
    CFRelease(signing_id);
  }
  CFRelease(task);

  return signing_ok && path_ok;
}

static int connect_authorization_socket(void) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) {
    return -1;
  }

  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  strlcpy(address.sun_path, STELLA_LOCKED_USE_SOCKET_PATH, sizeof(address.sun_path));
  address.sun_len = (unsigned char)sizeof(address);

  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

static bool read_allow_response(int fd) {
  char buffer[32] = {0};
  ssize_t count = read(fd, buffer, sizeof(buffer) - 1);
  if (count <= 0) {
    return false;
  }
  buffer[count] = '\0';
  return strncmp(buffer, "allow", 5) == 0;
}

static AuthorizationResult request_locked_use_authorization(void) {
  int fd = connect_authorization_socket();
  if (fd < 0) {
    return kAuthorizationResultDeny;
  }

  if (!socket_peer_is_expected_service(fd)) {
    close(fd);
    return kAuthorizationResultDeny;
  }

  const char *request = "authorize\n";
  (void)write(fd, request, strlen(request));
  bool allowed = read_allow_response(fd);
  close(fd);
  return allowed ? kAuthorizationResultAllow : kAuthorizationResultDeny;
}

static OSStatus plugin_destroy(AuthorizationPluginRef inPlugin) {
  free(inPlugin);
  return errAuthorizationSuccess;
}

static OSStatus mechanism_create(
  AuthorizationPluginRef inPlugin,
  AuthorizationEngineRef inEngine,
  AuthorizationMechanismId mechanismId,
  AuthorizationMechanismRef *outMechanism
) {
  (void)mechanismId;
  StellaLockedUsePlugin *plugin = (StellaLockedUsePlugin *)inPlugin;
  StellaLockedUseMechanism *mechanism =
    (StellaLockedUseMechanism *)calloc(1, sizeof(StellaLockedUseMechanism));
  if (mechanism == NULL) {
    return errAuthorizationInternal;
  }
  mechanism->callbacks = plugin->callbacks;
  mechanism->engine = inEngine;
  *outMechanism = mechanism;
  return errAuthorizationSuccess;
}

static OSStatus mechanism_invoke(AuthorizationMechanismRef inMechanism) {
  StellaLockedUseMechanism *mechanism = (StellaLockedUseMechanism *)inMechanism;
  AuthorizationResult result = request_locked_use_authorization();
  return mechanism->callbacks->SetResult(mechanism->engine, result);
}

static OSStatus mechanism_deactivate(AuthorizationMechanismRef inMechanism) {
  StellaLockedUseMechanism *mechanism = (StellaLockedUseMechanism *)inMechanism;
  return mechanism->callbacks->DidDeactivate(mechanism->engine);
}

static OSStatus mechanism_destroy(AuthorizationMechanismRef inMechanism) {
  free(inMechanism);
  return errAuthorizationSuccess;
}

static AuthorizationPluginInterface gPluginInterface = {
  .version = kAuthorizationPluginInterfaceVersion,
  .PluginDestroy = plugin_destroy,
  .MechanismCreate = mechanism_create,
  .MechanismInvoke = mechanism_invoke,
  .MechanismDeactivate = mechanism_deactivate,
  .MechanismDestroy = mechanism_destroy,
};

OSStatus AuthorizationPluginCreate(
  const AuthorizationCallbacks *callbacks,
  AuthorizationPluginRef *outPlugin,
  const AuthorizationPluginInterface **outPluginInterface
) {
  StellaLockedUsePlugin *plugin =
    (StellaLockedUsePlugin *)calloc(1, sizeof(StellaLockedUsePlugin));
  if (plugin == NULL) {
    return errAuthorizationInternal;
  }
  plugin->callbacks = callbacks;
  *outPlugin = plugin;
  *outPluginInterface = &gPluginInterface;
  return errAuthorizationSuccess;
}
