// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
#include "pads.h"
#include "bt_proto.h"   /* MIT, copied from native/mgu-moonlight-bt/include */
#include "log.h"
extern "C" {
#include <Limelight.h>
}
#include <errno.h>
#include <poll.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <atomic>
#include <mutex>
#include <string>
#include <thread>

static_assert(BT_A_FLAG == A_FLAG && BT_SPECIAL_FLAG == SPECIAL_FLAG && BT_MISC_FLAG == MISC_FLAG, "button bits");
static_assert(BT_CTYPE_XBOX == LI_CTYPE_XBOX && BT_CCAP_RUMBLE == LI_CCAP_RUMBLE, "controller constants");

namespace {

std::atomic<bool> g_run{false};
std::atomic<int> g_fd{-1};
std::thread g_thread;
std::mutex g_wm;
std::string g_path;

int dial()
{
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    sockaddr_un a;
    memset(&a, 0, sizeof a);
    a.sun_family = AF_UNIX;
    strncpy(a.sun_path, g_path.c_str(), sizeof a.sun_path - 1);
    if (fd >= 0 && connect(fd, (sockaddr *)&a, sizeof a) == 0) return fd;
    if (fd >= 0) close(fd);
    return -1;
}

void line(const char *l)
{
    char ev[24];
    if (!bt_proto_event_name(l, ev, sizeof ev)) return;
    bt_proto_state s;
    int idx = 0, mask = 0, ctype = 0, caps = 0, sup = 0;
    if (!strcmp(ev, "state") && bt_proto_parse_state(l, &s)) {
        LiSendMultiControllerEvent((short)s.idx, (short)s.mask, s.buttons, (unsigned char)s.lt, (unsigned char)s.rt,
                                   (short)s.lx, (short)s.ly, (short)s.rx, (short)s.ry);
    } else if (!strcmp(ev, "connected") && bt_proto_int_field(l, "idx", &idx) && bt_proto_int_field(l, "mask", &mask)) {
        bt_proto_int_field(l, "ctype", &ctype), bt_proto_int_field(l, "caps", &caps), bt_proto_int_field(l, "supported", &sup);
        LiSendControllerArrivalEvent((uint8_t)idx, (uint16_t)mask, (uint8_t)ctype, (uint32_t)sup, (uint16_t)caps);
        log_line("pads: pad %d connected (type %d)", idx, ctype);
    } else if (!strcmp(ev, "disconnected") && bt_proto_int_field(l, "idx", &idx) && bt_proto_int_field(l, "mask", &mask)) {
        LiSendMultiControllerEvent((short)idx, (short)mask, 0, 0, 0, 0, 0, 0, 0);
        log_line("pads: pad %d gone", idx);
    } else if (!strcmp(ev, "battery") && bt_proto_int_field(l, "idx", &idx) && bt_proto_int_field(l, "pct", &caps)) {
        LiSendControllerBatteryEvent((uint16_t)idx, LI_BATTERY_STATE_DISCHARGING, (uint8_t)caps);
    }
}

void loop()
{
    int wait_ms = 100;
    char buf[BT_PROTO_MAX_LINE * 4];
    while (g_run) {
        int fd = dial();
        if (fd < 0) {
            usleep(wait_ms * 1000);
            wait_ms = wait_ms < 1000 ? wait_ms * 2 : 1000;
            continue;
        }
        wait_ms = 100;
        g_fd = fd;
        log_line("pads: connected to %s", g_path.c_str());
        size_t have = 0;
        while (g_run) {
            pollfd p = {fd, POLLIN, 0};
            if (poll(&p, 1, 200) <= 0) continue;
            ssize_t n = read(fd, buf + have, sizeof buf - have - 1);
            if (n <= 0) break;
            have += (size_t)n;
            buf[have] = 0;
            char *start = buf, *nl;
            while ((nl = strchr(start, '\n'))) *nl = 0, line(start), start = nl + 1;
            have -= (size_t)(start - buf);
            memmove(buf, start, have);
            if (have >= sizeof buf - 1) have = 0;   /* a line over the limit: drop it */
        }
        std::lock_guard<std::mutex> l(g_wm);
        g_fd = -1;
        close(fd);
    }
}

}  // namespace

void pads_start(const char *sock)
{
    g_path = sock;
    g_run = true;
    g_thread = std::thread(loop);
}

void pads_rumble(unsigned short idx, unsigned short lo, unsigned short hi)
{
    char b[64];
    int n = snprintf(b, sizeof b, BT_PROTO_RUMBLE_FMT, idx, lo, hi, 0, 0);
    std::lock_guard<std::mutex> l(g_wm);
    if (g_fd >= 0 && send(g_fd, b, (size_t)n, MSG_DONTWAIT | MSG_NOSIGNAL) < 0 && errno != EAGAIN) {
    }
}

void pads_stop()
{
    g_run = false;
    if (g_thread.joinable()) g_thread.join();
}
