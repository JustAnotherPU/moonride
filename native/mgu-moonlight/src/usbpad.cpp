// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
#include "usbpad.h"
#include "log.h"
#include "usbfs.h"
extern "C" {
#include <Limelight.h>
}
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/ioctl.h>
#include <time.h>
#include <unistd.h>
#include <atomic>
#include <mutex>
#include <string>
#include <thread>

namespace {

struct Pad { int buttons, lt, rt, lx, ly, rx, ry; };
struct Dev { std::string node; int iface = -1, in = -1, out = -1; };

/* The XInput button word has Moonlight's layout bit for bit (UP_FLAG .. Y_FLAG). */
static_assert(UP_FLAG == 0x0001 && PLAY_FLAG == 0x0010 && LB_FLAG == 0x0100 && SPECIAL_FLAG == 0x0400 &&
              A_FLAG == 0x1000 && Y_FLAG == 0x8000, "XInput button bits");
const int BUTTONS = A_FLAG | B_FLAG | X_FLAG | Y_FLAG | UP_FLAG | DOWN_FLAG | LEFT_FLAG | RIGHT_FLAG | LB_FLAG |
                    RB_FLAG | PLAY_FLAG | BACK_FLAG | LS_CLK_FLAG | RS_CLK_FLAG | SPECIAL_FLAG;

/* Input report: 00 14 btnLo btnHi LT RT LX LY RX RY (int16 LE, +Y = up, as Moonlight wants). */
bool parse(const unsigned char *d, int n, Pad *p)
{
    if (n < 14 || d[0] != 0x00 || d[1] < 0x14) return false;
    auto s16 = [d](int i) { return (int)(short)(d[i] | d[i + 1] << 8); };
    p->buttons = (d[2] | d[3] << 8) & BUTTONS;
    p->lt = d[4], p->rt = d[5];
    p->lx = s16(6), p->ly = s16(8), p->rx = s16(10), p->ry = s16(12);
    return true;
}

/* First Xbox 360 vendor interface (ff/5d/01) of an attached device. */
bool find(Dev *out)
{
    for (const UsbIf &u : usb_interfaces())
        if (u.cls == 0xff && u.sub == 0x5d && u.proto == 0x01 && u.in >= 0) {
            out->node = u.node, out->iface = u.iface, out->in = u.in, out->out = u.out;
            return true;
        }
    return false;
}

std::atomic<bool> g_run{false};
bool g_print = false;
std::thread g_thread;
std::mutex g_m;   /* fd + out endpoint, for rumble from common-c's thread */
int g_fd = -1, g_out = -1;

/* View + Menu held QUIT_MS: the daemon ends the stream and quits the game (leave at once) */
const int QUIT = BACK_FLAG | PLAY_FLAG, QUIT_MS = 1500;
long long g_quit_t = 0;
long long now_ms() { timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1000LL + t.tv_nsec / 1000000; }
void quit_combo(int buttons)
{
    if ((buttons & QUIT) != QUIT) { g_quit_t = 0; return; }
    if (!g_quit_t) g_quit_t = now_ms();
    else if (g_quit_t > 0 && now_ms() - g_quit_t >= QUIT_MS) {
        g_quit_t = -1;   /* once per hold */
        printf("{\"ev\":\"quit\"}\n");
        fflush(stdout);
    }
}

void send(const Pad &p)
{
    if (g_print) {
        log_line("pad: buttons %04x lt %3d rt %3d left %6d,%6d right %6d,%6d", p.buttons, p.lt, p.rt, p.lx, p.ly, p.rx, p.ry);
        printf("{\"ev\":\"pad\",\"b\":%d,\"lt\":%d,\"rt\":%d,\"lx\":%d,\"ly\":%d,\"rx\":%d,\"ry\":%d}\n", p.buttons, p.lt,
               p.rt, p.lx, p.ly, p.rx, p.ry);   /* moonlightd's pad tester reads these */
        fflush(stdout);
    } else
        LiSendMultiControllerEvent(0, 1, p.buttons, (unsigned char)p.lt, (unsigned char)p.rt, (short)p.lx, (short)p.ly,
                                   (short)p.rx, (short)p.ry);
}

void loop()
{
    bool told = false;
    while (g_run) {
        Dev d;
        if (!find(&d)) {
            if (!told) log_line("usbpad: no XInput pad (pair the controller to the 8BitDo adapter)"), told = true;
            sleep(1);
            continue;
        }
        told = false;
        int fd = open(d.node.c_str(), O_RDWR | O_CLOEXEC);
        unsigned iface = (unsigned)d.iface;
        if (fd < 0 || ioctl(fd, USBDEVFS_CLAIMINTERFACE, &iface) != 0) {
            log_line("usbpad: %s: %s", d.node.c_str(), strerror(errno));   /* EACCES: the user lacks group mgu_usb */
            if (fd >= 0) close(fd);
            sleep(2);
            continue;
        }
        if (d.out >= 0) {   /* LED "player 1", as Linux xpad sends: the 8BitDo adapter keeps XInput mode only once a driver talks to it, else it cycles to Switch Pro every ~2 s */
            unsigned char led[3] = {0x01, 0x03, 0x06};
            usb_xfer(fd, d.out, led, sizeof led, 100);
        }
        log_line("usbpad: pad on %s (interface %d, in %02x, out %02x)", d.node.c_str(), d.iface, d.in, d.out);
        {
            std::lock_guard<std::mutex> l(g_m);
            g_fd = fd, g_out = d.out;
        }
        if (!g_print)
            LiSendControllerArrivalEvent(0, 1, LI_CTYPE_XBOX, (uint32_t)BUTTONS, LI_CCAP_ANALOG_TRIGGERS | LI_CCAP_RUMBLE);
        Pad last = {-1, 0, 0, 0, 0, 0, 0}, p;
        unsigned char buf[64];
        while (g_run) {
            int n = usb_xfer(fd, d.in, buf, sizeof buf, 200);
            if (n < 0 && errno == ETIMEDOUT) {   /* a held pad sends nothing new: the combo's clock runs here */
                if (!g_print && last.buttons > 0) quit_combo(last.buttons);
                continue;
            }
            if (n < 0) {
                log_line("usbpad: read: %s", strerror(errno));   /* ENODEV: unplugged, or the adapter switched mode */
                break;
            }
            if (parse(buf, n, &p)) {
                if (!g_print) quit_combo(p.buttons);
                if (memcmp(&p, &last, sizeof p)) send(p), last = p;
            }
        }
        if (!g_print) LiSendMultiControllerEvent(0, 1, 0, 0, 0, 0, 0, 0, 0);
        else printf("{\"ev\":\"pad\",\"gone\":true}\n"), fflush(stdout);
        std::lock_guard<std::mutex> l(g_m);
        g_fd = g_out = -1;
        ioctl(fd, USBDEVFS_RELEASEINTERFACE, &iface);
        close(fd);
        sleep(1);   /* a pad that keeps failing must not spin */
    }
}

}  // namespace

void usbpad_start(bool print)
{
    g_print = print;
    g_run = true;
    g_thread = std::thread(loop);
}

void usbpad_rumble(unsigned short idx, unsigned short lo, unsigned short hi)
{
    unsigned char m[8] = {0x00, 0x08, 0x00, (unsigned char)(lo >> 8), (unsigned char)(hi >> 8), 0, 0, 0};
    std::lock_guard<std::mutex> l(g_m);
    if (idx == 0 && g_fd >= 0 && g_out >= 0) usb_xfer(g_fd, g_out, m, sizeof m, 50);
}

void usbpad_stop()
{
    g_run = false;
    if (g_thread.joinable()) g_thread.join();
}

int usbpad_test(int seconds)
{
    const unsigned char r[20] = {0x00, 0x14, 0x11, 0x90, 0x40, 0xff, 0x00, 0x80, 0xff, 0x7f, 0x01, 0x00, 0xfe, 0xff};
    Pad p;
    if (!parse(r, sizeof r, &p) || p.buttons != (UP_FLAG | PLAY_FLAG | A_FLAG | Y_FLAG) || p.lt != 0x40 ||
        p.rt != 255 || p.lx != -32768 || p.ly != 32767 || p.rx != 1 || p.ry != -2 || parse(r, 13, &p)) {
        fprintf(stderr, "padtest: report parser self-check FAILED\n");
        return 1;
    }
    log_line("padtest: parser ok; reading for %d s", seconds);
    usbpad_start(true);
    for (int i = 0; i < seconds * 10; i++) usleep(100 * 1000);
    usbpad_stop();
    return 0;
}
