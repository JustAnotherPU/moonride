// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* A USB XInput pad read straight through usbfs (/dev/bus/usb): the MGU kernel
 * has no HID/input/xpad driver, so nothing else claims it. Made for the
 * 8BitDo USB Adapter 2, which shows up as an Xbox 360 pad (045e:028e) once a
 * controller is paired to it; any wired Xbox 360-protocol pad works the same.
 * It is controller 0; hot-plug and mode switches are handled by rescanning. */
#ifndef MGU_USBPAD_H
#define MGU_USBPAD_H
void usbpad_start(bool print);   /* print: log states instead of sending them (padtest) */
void usbpad_rumble(unsigned short idx, unsigned short lo, unsigned short hi);
void usbpad_stop();
int usbpad_test(int seconds);    /* `mgu-moonlight padtest [S]`: print what the pad sends */
#endif
