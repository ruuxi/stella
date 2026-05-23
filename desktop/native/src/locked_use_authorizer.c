#include <CoreFoundation/CoreFoundation.h>
#include <Security/Authorization.h>
#include <Security/AuthorizationTags.h>
#include <errno.h>
#include <libgen.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int print_usage(void) {
  fputs("usage: Stella install|uninstall RESOURCE_DIR\n", stderr);
  return 2;
}

static int print_authorization_error(OSStatus status) {
  if (status == errAuthorizationCanceled) {
    fputs("User canceled.\n", stderr);
    return 128;
  }
  fprintf(stderr, "Authorization failed: %d\n", (int)status);
  return 1;
}

static int build_installer_path(const char *resource_dir, char *out, size_t out_size) {
  int written = snprintf(out, out_size, "%s/locked_use_installer", resource_dir);
  if (written < 0 || (size_t)written >= out_size) {
    fputs("Installer path is too long.\n", stderr);
    return 1;
  }
  if (access(out, X_OK) != 0) {
    fprintf(stderr, "Installer is not executable at %s: %s\n", out, strerror(errno));
    return 1;
  }
  return 0;
}

static int run_authorized_installer(const char *action, const char *resource_dir) {
  char installer_path[PATH_MAX];
  int path_status = build_installer_path(resource_dir, installer_path, sizeof(installer_path));
  if (path_status != 0) {
    return path_status;
  }

  AuthorizationRef authorization = NULL;
  OSStatus status = AuthorizationCreate(
    NULL,
    kAuthorizationEmptyEnvironment,
    kAuthorizationFlagDefaults,
    &authorization
  );
  if (status != errAuthorizationSuccess) {
    return print_authorization_error(status);
  }

  AuthorizationItem item = { kAuthorizationRightExecute, 0, NULL, 0 };
  AuthorizationRights rights = { 1, &item };
  AuthorizationFlags flags =
    kAuthorizationFlagDefaults |
    kAuthorizationFlagInteractionAllowed |
    kAuthorizationFlagPreAuthorize |
    kAuthorizationFlagExtendRights;

  status = AuthorizationCopyRights(authorization, &rights, NULL, flags, NULL);
  if (status != errAuthorizationSuccess) {
    AuthorizationFree(authorization, kAuthorizationFlagDestroyRights);
    return print_authorization_error(status);
  }

  char *tool_args[] = {
    (char *)action,
    (char *)resource_dir,
    NULL,
  };
  FILE *pipe = NULL;

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  status = AuthorizationExecuteWithPrivileges(
    authorization,
    installer_path,
    kAuthorizationFlagDefaults,
    tool_args,
    &pipe
  );
#pragma clang diagnostic pop

  if (status != errAuthorizationSuccess) {
    AuthorizationFree(authorization, kAuthorizationFlagDestroyRights);
    return print_authorization_error(status);
  }

  if (pipe == NULL) {
    AuthorizationFree(authorization, kAuthorizationFlagDestroyRights);
    return 0;
  }

  char buffer[4096];
  while (!feof(pipe)) {
    size_t count = fread(buffer, 1, sizeof(buffer), pipe);
    if (count > 0) {
      fwrite(buffer, 1, count, stdout);
    }
  }

  int close_status = fclose(pipe);
  AuthorizationFree(authorization, kAuthorizationFlagDestroyRights);
  if (close_status != 0) {
    fprintf(stderr, "Failed to close installer stream: %s\n", strerror(errno));
    return 1;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 3) {
    return print_usage();
  }

  const char *action = argv[1];
  if (strcmp(action, "install") != 0 && strcmp(action, "uninstall") != 0) {
    return print_usage();
  }

  return run_authorized_installer(action, argv[2]);
}
