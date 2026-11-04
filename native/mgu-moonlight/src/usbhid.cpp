// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
#include "usbhid.h"
#include "log.h"
#include "usbfs.h"
extern "C" {
#include <Limelight.h>
}
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <atomic>
#include <mutex>
#include <set>
#include <string>
#include <thread>

namespace {

/* HID usage (keyboard page) -> Windows VK, by position; 0 = not sent. */
unsigned char vk_of(int u)
{
    static const unsigned char t[0x66] = {
        0, 0, 0, 0,                                                           /* 00-03 */
        'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', /* 04-11 */
        'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',           /* 12-1D */
        '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',                     /* 1E-27 */
        0x0D, 0x1B, 0x08, 0x09, 0x20, 0xBD, 0xBB, 0xDB, 0xDD, 0xDC,           /* 28-31 enter esc bksp tab space - = [ ] \ */
        0xDC, 0xBA, 0xDE, 0xC0, 0xBC, 0xBE, 0xBF, 0x14,                      /* 32-39 #~ ; ' ` , . / caps */
        0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x7B, /* 3A-45 F1-F12 */
        0x2C, 0x91, 0x13, 0x2D, 0x24, 0x21, 0x2E, 0x23, 0x22,                 /* 46-4E prtsc scroll pause ins home pgup del end pgdn */
        0x27, 0x25, 0x28, 0x26, 0x90,                                         /* 4F-53 right left down up numlock */
        0x6F, 0x6A, 0x6D, 0x6B, 0x0D,                                         /* 54-58 keypad / * - + enter */
        0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x60, 0x6E,     /* 59-63 keypad 1-9 0 . */
        0xE2, 0x5D,                                                           /* 64-65 ISO <> key, menu */
    };
    return u >= 0 && u < (int)sizeof t ? t[u] : 0;
}
/* boot report modifier bits 0..7: LCtrl LShift LAlt LGui RCtrl RShift RAlt RGui */
const unsigned char MOD_VK[8] = {0xA2, 0xA0, 0xA4, 0x5B, 0xA3, 0xA1, 0xA5, 0x5C};
char mods_of(int m)
{
    return (char)(((m & 0x22) ? MODIFIER_SHIFT : 0) | ((m & 0x11) ? MODIFIER_CTRL : 0) |
                  ((m & 0x44) ? MODIFIER_ALT : 0) | ((m & 0x88) ? MODIFIER_META : 0));
}

std::atomic<bool> g_run{false};
std::atomic<int> g_readers{0};
bool g_print = false;
std::thread g_thread;
std::mutex g_m;
std::set<std::string> g_open;   /* "node#iface" being read */

void key(int vk, bool down, char mods)
{
    if (g_print) log_line("hid: key %02x %s", vk, down ? "down" : "up");
    else LiSendKeyboardEvent((short)(0x8000 | vk), down ? KEY_ACTION_DOWN : KEY_ACTION_UP, mods);
}

/* Boot keyboard report: mods, 0, up to 6 usages. Sends what changed since the last one. */
void keyboard(const unsigned char *r, int n, unsigned char *last)
{
    if (n < 8 || r[2] == 1) return;   /* 01 x6 = rollover error: keep the last state */
    const char mods = mods_of(r[0]);
    for (int b = 0; b < 8; b++)
        if ((r[0] ^ last[0]) & (1 << b)) key(MOD_VK[b], (r[0] >> b) & 1, mods);
    for (int i = 2; i < 8; i++)
        if (last[i] && !memchr(r + 2, last[i], 6) && vk_of(last[i])) key(vk_of(last[i]), false, mods);
    for (int i = 2; i < 8; i++)
        if (r[i] && !memchr(last + 2, r[i], 6) && vk_of(r[i])) key(vk_of(r[i]), true, mods);
    memcpy(last, r, 8);
}

/* Boot mouse report: buttons, dx, dy[, wheel] (int8). */
void mouse(const unsigned char *r, int n, unsigned char *last)
{
    if (n < 3) return;
    static const int BTN[5] = {BUTTON_LEFT, BUTTON_RIGHT, BUTTON_MIDDLE, BUTTON_X1, BUTTON_X2};
    const int dx = (signed char)r[1], dy = (signed char)r[2], wheel = n >= 4 ? (signed char)r[3] : 0;
    if (g_print) {
        log_line("hid: mouse buttons %02x move %d,%d wheel %d", r[0], dx, dy, wheel);
    } else {
        if (dx || dy) LiSendMouseMoveEvent((short)dx, (short)dy);
        for (int b = 0; b < 5; b++)
            if ((r[0] ^ last[0]) & (1 << b))
                LiSendMouseButtonEvent((r[0] >> b) & 1 ? BUTTON_ACTION_PRESS : BUTTON_ACTION_RELEASE, BTN[b]);
        if (wheel) LiSendScrollEvent((signed char)wheel);
    }
    last[0] = r[0];
}

void reader(UsbIf u, std::string tag)
{
    const bool kbd = u.proto == 1;
    unsigned iface = (unsigned)u.iface;
    int fd = open(u.node.c_str(), O_RDWR | O_CLOEXEC);
    if (fd < 0 || ioctl(fd, USBDEVFS_CLAIMINTERFACE, &iface) != 0) {
        log_line("usbhid: %s: %s", tag.c_str(), strerror(errno));   /* EACCES: the user lacks group mgu_usb */
        if (fd >= 0) close(fd);
        sleep(2);
    } else {
        usb_ctrl(fd, 0x21, 0x0B, 0, u.iface, 200);   /* SET_PROTOCOL boot: fixed report layout */
        usb_ctrl(fd, 0x21, 0x0A, 0, u.iface, 200);   /* SET_IDLE 0: report on change only */
        log_line("usbhid: %s on %s", kbd ? "keyboard" : "mouse", tag.c_str());
        unsigned char buf[64], last[8] = {0};
        while (g_run) {
            int n = usb_xfer(fd, u.in, buf, sizeof buf, 200);
            if (n < 0 && errno == ETIMEDOUT) continue;
            if (n < 0) {
                log_line("usbhid: %s: %s", tag.c_str(), strerror(errno));   /* ENODEV: unplugged */
                break;
            }
            if (kbd) keyboard(buf, n, last);
            else mouse(buf, n, last);
        }
        if (kbd) {   /* release whatever was held */
            unsigned char none[8] = {0};
            keyboard(none, 8, last);
        } else if (last[0] && !g_print) {
            unsigned char none[4] = {0};
            mouse(none, 4, last);
        }
        ioctl(fd, USBDEVFS_RELEASEINTERFACE, &iface);
        close(fd);
    }
    std::lock_guard<std::mutex> l(g_m);
    g_open.erase(tag);
    g_readers--;
}

void loop()
{
    while (g_run) {
        for (const UsbIf &u : usb_interfaces()) {
            if (u.cls != 3 || u.sub != 1 || (u.proto != 1 && u.proto != 2) || u.in < 0) continue;
            // shortcut: boot-protocol interfaces only (subclass 1); a mouse without one is skipped, parse report descriptors if one shows up
            const std::string tag = u.node + "#" + std::to_string(u.iface);
            std::lock_guard<std::mutex> l(g_m);
            if (!g_open.insert(tag).second) continue;
            g_readers++;
            std::thread(reader, u, tag).detach();
        }
        for (int i = 0; i < 10 && g_run; i++) usleep(100 * 1000);
    }
}

}  // namespace

void usbhid_start(bool print)
{
    g_print = print;
    g_run = true;
    g_thread = std::thread(loop);
}

void usbhid_stop()
{
    g_run = false;
    if (g_thread.joinable()) g_thread.join();
    for (int i = 0; i < 30 && g_readers > 0; i++) usleep(100 * 1000);   /* readers wake within 200 ms */
}

int usbhid_test(int seconds)
{
    unsigned char last[8] = {0};
    const unsigned char a[8] = {0x02, 0, 0x04, 0, 0, 0, 0, 0};   /* LShift + A */
    g_print = true;
    keyboard(a, 8, last);
    if (last[0] != 0x02 || last[2] != 0x04 || vk_of(0x04) != 'A' || vk_of(0x27) != '0' || vk_of(0x64) != 0xE2 ||
        mods_of(0x20) != MODIFIER_SHIFT || mods_of(0x40) != MODIFIER_ALT) {
        fprintf(stderr, "hidtest: keyboard table self-check FAILED\n");
        return 1;
    }
    log_line("hidtest: tables ok; reading for %d s", seconds);
    usbhid_start(true);
    for (int i = 0; i < seconds * 10; i++) usleep(100 * 1000);
    usbhid_stop();
    return 0;
}
