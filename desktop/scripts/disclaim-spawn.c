/*
 * disclaim-spawn — Launch a child process with macOS TCC responsibility
 * disclaimed so the child becomes its own "responsible process."
 *
 * Without this, macOS attributes permission prompts (microphone, camera, etc.)
 * to an ancestor in the process tree, which can silently prevent them from
 * appearing when the ancestor is not a proper app bundle.
 *
 * Uses the same undocumented-but-stable API that LLDB, Qt Creator, Chromium,
 * Firefox, and Electron's own utility processes rely on.
 *
 * Usage:  disclaim-spawn <binary> [args...]
 * Build:  clang -O2 -o disclaim-spawn disclaim-spawn.c
 */

#include <dlfcn.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

typedef int (*disclaim_func_t)(posix_spawnattr_t *, int);

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "usage: disclaim-spawn <binary> [args...]\n");
        return 1;
    }

    posix_spawnattr_t attr;
    posix_spawnattr_init(&attr);

    sigset_t no_signals;
    sigemptyset(&no_signals);
    posix_spawnattr_setsigmask(&attr, &no_signals);

    sigset_t all_signals;
    sigfillset(&all_signals);
    posix_spawnattr_setsigdefault(&attr, &all_signals);

    short flags = POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF;
    posix_spawnattr_setflags(&attr, flags);

    disclaim_func_t disclaim_fn = (disclaim_func_t)dlsym(
        RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
    if (disclaim_fn) {
        disclaim_fn(&attr, 1);
    }

    pid_t pid = 0;
    int ret = posix_spawnp(&pid, argv[1], NULL, &attr, &argv[1], environ);
    posix_spawnattr_destroy(&attr);

    if (ret != 0) {
        fprintf(stderr, "disclaim-spawn: posix_spawnp: %s\n", strerror(ret));
        return ret;
    }

    int status;
    waitpid(pid, &status, 0);

    if (WIFEXITED(status))
        return WEXITSTATUS(status);
    if (WIFSIGNALED(status))
        return 128 + WTERMSIG(status);
    return 1;
}
