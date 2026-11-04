// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* usbfs helpers shared by usbpad.cpp and usbhid.cpp: the MGU kernel has no
 * HID/input drivers, so USB input devices are read from /dev/bus/usb. */
#ifndef MGU_USBFS_H
#define MGU_USBFS_H
#include <dirent.h>
#include <linux/usbdevice_fs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <string>
#include <vector>

struct UsbIf { std::string node; int iface, cls, sub, proto, in, out; };

inline std::string usb_slurp(const std::string &path)
{
    std::string s;
    FILE *f = fopen(path.c_str(), "rb");
    if (!f) return s;
    char b[4096];
    size_t n;
    while ((n = fread(b, 1, sizeof b, f)) > 0) s.append(b, n);
    fclose(f);
    return s;
}

/* Every interface of every attached device with its first interrupt IN/OUT endpoints, from sysfs. */
inline std::vector<UsbIf> usb_interfaces()
{
    std::vector<UsbIf> v;
    DIR *dir = opendir("/sys/bus/usb/devices");
    if (!dir) return v;
    while (dirent *e = readdir(dir)) {
        const std::string sys = std::string("/sys/bus/usb/devices/") + e->d_name;
        if (strchr(e->d_name, ':')) continue;
        const std::string desc = usb_slurp(sys + "/descriptors");
        if (desc.size() < 18) continue;
        char node[64];
        snprintf(node, sizeof node, "/dev/bus/usb/%03d/%03d", atoi(usb_slurp(sys + "/busnum").c_str()),
                 atoi(usb_slurp(sys + "/devnum").c_str()));
        UsbIf *cur = nullptr;
        for (size_t i = 18; i + 2 <= desc.size() && desc[i] > 0; i += (unsigned char)desc[i]) {
            const unsigned char *x = (const unsigned char *)desc.data() + i;
            if (i + x[0] > desc.size()) break;
            if (x[1] == 4 && x[0] >= 9) {   /* interface (alt setting 0 only) */
                cur = nullptr;
                if (x[3] == 0) v.push_back(UsbIf{node, x[2], x[5], x[6], x[7], -1, -1}), cur = &v.back();
            } else if (x[1] == 5 && x[0] >= 7 && cur && (x[3] & 3) == 3) {   /* interrupt endpoint */
                int &ep = (x[2] & 0x80) ? cur->in : cur->out;
                if (ep < 0) ep = x[2];
            }
        }
    }
    closedir(dir);
    return v;
}

inline int usb_xfer(int fd, int ep, unsigned char *buf, int len, int timeout_ms)
{
    usbdevfs_bulktransfer t;   /* usb_bulk_msg also serves interrupt endpoints */
    t.ep = (unsigned)ep;
    t.len = (unsigned)len;
    t.timeout = (unsigned)timeout_ms;
    t.data = buf;
    return ioctl(fd, USBDEVFS_BULK, &t);
}

inline int usb_ctrl(int fd, int type, int req, int value, int index, int timeout_ms)
{
    usbdevfs_ctrltransfer c;
    memset(&c, 0, sizeof c);
    c.bRequestType = (unsigned char)type;
    c.bRequest = (unsigned char)req;
    c.wValue = (unsigned short)value;
    c.wIndex = (unsigned short)index;
    c.timeout = (unsigned)timeout_ms;
    return ioctl(fd, USBDEVFS_CONTROL, &c);
}

#endif
