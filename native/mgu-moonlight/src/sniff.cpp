// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* `mgu-moonlight sniff SERVICE METHOD [S]`: print the payload bytes of SOME/IP messages (UDP, any interface)
 * with that service and method id (-1: any), S seconds (read-only, root): what a field's notifier really carries. */
#include <arpa/inet.h>
#include <linux/if_ether.h>
#include <netinet/ip.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

int sniff(int service, int method, int seconds)
{
    int fd = socket(AF_PACKET, SOCK_DGRAM, htons(ETH_P_IP));
    if (fd < 0) { perror("sniff: socket"); return 1; }
    timeval tv = {1, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    const time_t end = time(nullptr) + seconds;
    unsigned char b[65536];
    while (time(nullptr) < end) {
        ssize_t n = recv(fd, b, sizeof b, 0);
        if (n < 28 || (b[0] >> 4) != 4 || b[9] != 17) continue;   /* IPv4 UDP only */
        size_t ihl = (b[0] & 15) * 4, off = ihl + 8;
        while (off + 16 <= (size_t)n) {   /* one datagram may carry several SOME/IP messages */
            const int svc = b[off] << 8 | b[off + 1], mth = b[off + 2] << 8 | b[off + 3];
            const size_t len = (size_t)b[off + 4] << 24 | b[off + 5] << 16 | b[off + 6] << 8 | b[off + 7];
            if (len < 8 || off + 8 + len > (size_t)n) break;
            if ((service < 0 || svc == service) && (method < 0 || mth == method)) {
                timespec t; clock_gettime(CLOCK_REALTIME, &t);
                printf("%ld.%03ld %04x %04x", (long)t.tv_sec, t.tv_nsec / 1000000, svc, mth);
                for (size_t i = off + 16; i < off + 8 + len; i++) printf(" %02x", b[i]);
                printf("\n");
                fflush(stdout);
            }
            off += 8 + len;
        }
    }
    close(fd);
    return 0;
}
