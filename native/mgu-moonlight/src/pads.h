// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* Pads from the private Bluetooth helper (native/mgu-moonlight-bt, its
 * PROTOCOL.md): one thread reads pad states from its socket and sends them
 * with LiSendMultiControllerEvent; rumble goes back the same way. */
#ifndef MGU_PADS_H
#define MGU_PADS_H
void pads_start(const char *sock);
void pads_rumble(unsigned short idx, unsigned short lo, unsigned short hi);
void pads_stop();
#endif
