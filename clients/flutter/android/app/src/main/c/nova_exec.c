/* SPDX-License-Identifier: GPL-3.0-or-later
 * Start one PRoot command in its own session, publishing the process-group ID
 * before exec. The host can stop this command without touching another run.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
int main(int argc, char **argv) {
    if (argc < 3) return 64;
    if (setsid() < 0) { perror("setsid"); return 70; }
    int fd = open(argv[1], O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (fd < 0) { perror("pidfile"); return 70; }
    if (dprintf(fd, "%ld\n", (long)getpid()) < 0 || close(fd) < 0) return 70;
    execv(argv[2], argv + 2);
    perror("execv");
    return 127;
}
