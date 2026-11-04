// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* Opus (48 kHz stereo) from common-c -> S16 PCM -> one sink:
 *   null           decode only (counts, decode time)
 *   wav:PATH       a WAV file (Mac/VM check that the audio is right)
 *   alsa:DEVICE    libasound.so.2, dlopen'd (the car: plug:smartx:<source>)
 * The sink is written from common-c's audio thread; when the device holds
 * more than the latency target, the packet is dropped instead of queued. */
#ifndef MGU_AUDIO_H
#define MGU_AUDIO_H

#include <string>
extern "C" {
#include <Limelight.h>
}

int audio_select(const char *spec);   /* -1: bad spec */
void audio_callbacks(AUDIO_RENDERER_CALLBACKS *ar);
std::string audio_stats_json();       /* "\"audio\":{...}" since the last call */
int audio_tone(const char *dev, int seconds);   /* the G1 click test */

#endif
