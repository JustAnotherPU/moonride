// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
#include "audio.h"
#include <errno.h>
#include <dlfcn.h>
#include <math.h>
#include <poll.h>
#include <stdlib.h>
#include <unistd.h>
#include <opus/opus_multistream.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <mutex>

#include "log.h"

namespace {

/* libasound.so.2 prototypes, by hand: the build image has no ALSA headers and
 * the car binary must not link it (only the alsa sink needs it, at run time). */
typedef struct snd_pcm snd_pcm_t;
struct Alsa {
    int (*open)(snd_pcm_t **, const char *, int, int);
    int (*set_params)(snd_pcm_t *, int, int, unsigned, unsigned, int, unsigned);
    long (*writei)(snd_pcm_t *, const void *, unsigned long);
    int (*recover)(snd_pcm_t *, int, int);
    int (*delay)(snd_pcm_t *, long *);
    int (*close)(snd_pcm_t *);
    const char *(*strerror)(int);
} A;
const int kPlayback = 0, kS16LE = 2, kRwInterleaved = 3;
/* ALSA buffer target. smartx imposes 1024-frame periods x 3 (64 ms, measured on the car): MGU_ALSA_US=64000 there. */
unsigned buffer_us() { const char *e = getenv("MGU_ALSA_US"); return e ? (unsigned)atoi(e) : 20000; }
long drop_above_ms() { return (long)(buffer_us() / 1000) + 25; }   /* device this far behind: drop the packet */

enum Kind { NUL, WAV, ALSA } g_kind = NUL;
std::string g_target;
OpusMSDecoder *g_dec;
int g_ch = 2, g_spf = 240;
short g_pcm[5760 * 8];
FILE *g_wav;
uint32_t g_wav_bytes;
snd_pcm_t *g_pcm_dev;

std::mutex g_m;
unsigned g_packets, g_dropped, g_errors, g_xruns, g_drop_late, g_drop_full, g_partial;   /* late: device too far behind; full: EAGAIN; partial: writei took fewer frames */
double g_dec_sum, g_dec_max, g_delay_sum;
unsigned g_delay_n;

double mono_ms()
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000.0 + t.tv_nsec / 1e6;
}

void say(const char *m, const char *a = "")
{
    log_line("audio: %s %s", m, a);
}

void wav_header(uint32_t data)
{
    const uint32_t rate = 48000, br = rate * 2 * g_ch, riff = 36 + data;
    const uint16_t pcm = 1, ch = (uint16_t)g_ch, ba = (uint16_t)(2 * g_ch), bits = 16;
    const uint32_t fmt = 16;
    fseek(g_wav, 0, SEEK_SET);
    fwrite("RIFF", 1, 4, g_wav), fwrite(&riff, 4, 1, g_wav), fwrite("WAVEfmt ", 1, 8, g_wav);
    fwrite(&fmt, 4, 1, g_wav), fwrite(&pcm, 2, 1, g_wav), fwrite(&ch, 2, 1, g_wav), fwrite(&rate, 4, 1, g_wav);
    fwrite(&br, 4, 1, g_wav), fwrite(&ba, 2, 1, g_wav), fwrite(&bits, 2, 1, g_wav), fwrite("data", 1, 4, g_wav);
    fwrite(&data, 4, 1, g_wav);
    fseek(g_wav, 0, SEEK_END);
}

bool alsa_load()
{
    void *h = dlopen("libasound.so.2", RTLD_NOW);
    if (!h) {
        say("dlopen libasound.so.2 failed:", dlerror());
        return false;
    }
#define SYM(f, n) (*(void **)&A.f = dlsym(h, n))
    return SYM(open, "snd_pcm_open") && SYM(set_params, "snd_pcm_set_params") && SYM(writei, "snd_pcm_writei") &&
           SYM(recover, "snd_pcm_recover") && SYM(delay, "snd_pcm_delay") && SYM(close, "snd_pcm_close") &&
           SYM(strerror, "snd_strerror");
#undef SYM
}

int ar_init(int, const POPUS_MULTISTREAM_CONFIGURATION c, void *, int)
{
    int err = 0;
    g_ch = c->channelCount, g_spf = c->samplesPerFrame;
    g_dec = opus_multistream_decoder_create(c->sampleRate, c->channelCount, c->streams, c->coupledStreams,
                                            c->mapping, &err);
    if (!g_dec) {
        say("opus decoder:", opus_strerror(err));
        return -1;
    }
    char b[96];
    snprintf(b, sizeof b, "%d Hz, %d ch, %d samples/packet", c->sampleRate, c->channelCount, c->samplesPerFrame);
    say("opus", b);
    if (g_kind == WAV) {
        g_wav = fopen(g_target.c_str(), "wb");
        if (!g_wav) return say("cannot create", g_target.c_str()), -1;
        wav_header(0);
    } else if (g_kind == ALSA) {
        /* nonblocking: an unconnected source (no consumer) must never park the audio thread; a failure costs
         * the sound, never the stream */
        int rc = alsa_load() ? A.open(&g_pcm_dev, g_target.c_str(), kPlayback, 1 /* SND_PCM_NONBLOCK */) : -1;
        if (rc < 0) say("snd_pcm_open:", rc == -1 ? "libasound" : A.strerror(rc));
        else if ((rc = A.set_params(g_pcm_dev, kS16LE, kRwInterleaved, (unsigned)g_ch, 48000, 1, buffer_us())) < 0)
            say("snd_pcm_set_params:", A.strerror(rc));
        if (rc < 0) {
            say("alsa unavailable: streaming without sound");
            if (g_pcm_dev) A.close(g_pcm_dev), g_pcm_dev = nullptr;
            g_kind = NUL;
        } else say("alsa open", g_target.c_str());
    }
    return 0;
}

void ar_cleanup()
{
    if (g_dec) opus_multistream_decoder_destroy(g_dec), g_dec = nullptr;
    if (g_wav) wav_header(g_wav_bytes), fclose(g_wav), g_wav = nullptr;
    if (g_pcm_dev) A.close(g_pcm_dev), g_pcm_dev = nullptr;
}

void ar_play(char *data, int len)
{
    const double t0 = mono_ms();
    const int n = opus_multistream_decode(g_dec, (const unsigned char *)data, len, g_pcm, (int)(sizeof g_pcm / sizeof *g_pcm / g_ch), 0);
    const double t1 = mono_ms();
    bool drop = false, err = n < 0, xrun = false, late = false, full = false, partial = false;
    long delay_ms = -1;
    if (n > 0 && g_kind == WAV) {
        fwrite(g_pcm, 2 * (size_t)g_ch, (size_t)n, g_wav);
        g_wav_bytes += (uint32_t)(2 * g_ch * n);
    } else if (n > 0 && g_kind == ALSA) {
        long d = 0;
        if (A.delay(g_pcm_dev, &d) == 0) delay_ms = d / 48;
        if (delay_ms > drop_above_ms()) {
            drop = late = true;
        } else {
            long w = A.writei(g_pcm_dev, g_pcm, (unsigned long)n);
            if (w == -EAGAIN) drop = full = true;   /* full (nobody reads: the source is not connected): the next packet is 5 ms away */
            else if (w < 0) xrun = true, A.recover(g_pcm_dev, (int)w, 1);
            else if (w < n) partial = true;
        }
    }
    std::lock_guard<std::mutex> l(g_m);
    g_packets++, g_dropped += drop, g_errors += err, g_xruns += xrun, g_drop_late += late, g_drop_full += full, g_partial += partial;
    g_dec_sum += t1 - t0;
    if (t1 - t0 > g_dec_max) g_dec_max = t1 - t0;
    if (delay_ms >= 0) g_delay_sum += delay_ms, g_delay_n++;
}

}  // namespace

int audio_select(const char *spec)
{
    if (!strcmp(spec, "null")) return g_kind = NUL, 0;
    if (!strncmp(spec, "wav:", 4) && spec[4]) return g_kind = WAV, g_target = spec + 4, 0;
    if (!strncmp(spec, "alsa:", 5) && spec[5]) return g_kind = ALSA, g_target = spec + 5, 0;
    return -1;
}

void audio_callbacks(AUDIO_RENDERER_CALLBACKS *ar)
{
    ar->init = ar_init;
    ar->cleanup = ar_cleanup;
    ar->decodeAndPlaySample = ar_play;
    /* null/wav: decode in the receive thread (no extra queue); alsa may block on the device: common-c's queue */
    ar->capabilities = g_kind == ALSA ? 0 : CAPABILITY_DIRECT_SUBMIT;
}

std::string audio_stats_json()
{
    std::lock_guard<std::mutex> l(g_m);
    char b[320];
    snprintf(b, sizeof b,
             "\"audio\":{\"packets\":%u,\"dropped\":%u,\"drop_late\":%u,\"drop_full\":%u,\"partial\":%u,\"errors\":%u,\"xruns\":%u,"
             "\"decode_ms\":%.3f,\"decode_max\":%.3f,\"device_ms\":%.1f,\"pending_ms\":%d}",
             g_packets, g_dropped, g_drop_late, g_drop_full, g_partial, g_errors, g_xruns, g_packets ? g_dec_sum / g_packets : 0.0, g_dec_max,
             g_delay_n ? g_delay_sum / g_delay_n : -1.0, LiGetPendingAudioDuration());
    g_packets = g_dropped = g_errors = g_xruns = g_delay_n = g_drop_late = g_drop_full = g_partial = 0;
    g_dec_sum = g_dec_max = g_delay_sum = 0;
    return b;
}

/* `mgu-moonlight tone DEVICE [SECONDS]`: the G1 car test. A 5 ms 1 kHz click at -30 dBFS
 * every 500 ms, and one at once on each Enter; logs CLOCK_MONOTONIC, the device delay and every error to
 * stderr. Stops at SECONDS (max 120), on EOF or Ctrl-C. Plays nothing it was not asked to. */
int audio_tone(const char *dev, int seconds)
{
    if (seconds <= 0 || seconds > 120) seconds = 120;
    if (!alsa_load()) return 1;
    snd_pcm_t *pcm = nullptr;
    int rc = A.open(&pcm, dev, kPlayback, 0);
    if (rc < 0) return fprintf(stderr, "snd_pcm_open %s: %s\n", dev, A.strerror(rc)), 1;
    rc = A.set_params(pcm, kS16LE, kRwInterleaved, 2, 48000, 1, buffer_us());
    if (rc < 0) return fprintf(stderr, "snd_pcm_set_params: %s\n", A.strerror(rc)), A.close(pcm), 1;
    static short silence[480 * 2], click[240 * 2];   /* 10 ms of silence, 5 ms click */
    for (int i = 0; i < 240; i++) click[2 * i] = click[2 * i + 1] = (short)(1036 * sin(2 * M_PI * 1000 * i / 48000.0));
    const double t_end = mono_ms() + seconds * 1000.0;
    double next = mono_ms();
    unsigned n = 0;
    while (mono_ms() < t_end) {
        bool now = false;
        pollfd p = {0, POLLIN, 0};
        if (poll(&p, 1, 0) > 0) {
            char b[64];
            if (read(0, b, sizeof b) <= 0) break;
            now = true;
        }
        const bool tick = now || mono_ms() >= next;
        if (tick && !now) next += 500;
        long d = -1;
        A.delay(pcm, &d);
        long w = A.writei(pcm, tick ? click : silence, tick ? 240 : 480);
        if (w < 0) fprintf(stderr, "%.1f write error %s\n", mono_ms(), A.strerror((int)w)), A.recover(pcm, (int)w, 1);
        if (tick) fprintf(stderr, "%.1f click %u%s delay_ms %.1f\n", mono_ms(), ++n, now ? " (enter)" : "", d / 48.0);
    }
    A.close(pcm);
    return 0;
}
