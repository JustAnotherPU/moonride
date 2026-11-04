// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* USB keyboards and mice read straight through usbfs in the HID boot protocol
 * (the MGU kernel has no HID driver): keys go to the host as Windows VK codes
 * by physical position (the host's own layout applies, AZERTY included), mouse
 * moves are relative. Any number of devices, hot-plugged by rescanning. */
#ifndef MGU_USBHID_H
#define MGU_USBHID_H
void usbhid_start(bool print);   /* print: log what arrives instead of sending it (hidtest) */
void usbhid_stop();
int usbhid_test(int seconds);    /* `mgu-moonlight hidtest [S]` */
#endif
