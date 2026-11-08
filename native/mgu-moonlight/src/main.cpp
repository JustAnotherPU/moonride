// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* mgu-moonlight: the streaming half of the MGU Moonlight client.
 *
 *   mgu-moonlight stream --host IP --rtsp URL --appver V --gfever V [--codecs N]
 *                        --rikey HEX32 --rikeyid N [--w 1920 --h 720 --fps 60 --kbps 10000]
 *                        [--decoder msdk|null] [--audio null|wav:PATH|alsa:DEVICE]
 *                        [--shm PATH] [--pads SOCK] [--log FILE] [--dump FILE.h264] [--packet 1392] [--codec h264|hevc]
 *                        (--dump: the H.264 stream as received, Annex B, for checking what the car gets: ffmpeg decodes it)
 *   mgu-moonlight mkcert DIR       RSA-2048 key + self-signed cert for pairing (DIR/key.pem, DIR/cert.pem)
 *   mgu-moonlight launchparams     the string common-c wants appended to /launch
 *   mgu-moonlight tone DEVICE [S]  the G1 click test: clicks into an ALSA device (e.g. plug:smartx:SDARS_IP_CF_48_STEREO)
 *   mgu-moonlight probe [W H]      read-only: MSDK version, H.264 / HEVC decode support (car build)
 *   mgu-moonlight padtest [S]      print what a USB XInput pad (8BitDo adapter) sends, S seconds (default 30)
 *   mgu-moonlight hidtest [S]      print what USB keyboards/mice send, S seconds (default 30)
 *   mgu-moonlight sniff SVC MTH [S] print SOME/IP payloads of that service/method (root, read-only)
 *
 * The control plane (pairing, /launch, /cancel, the ctl socket) is Node 22
 * (daemon). It spawns `stream` with what /launch returned.
 * stdin, one command a line (EOF = stop): pos X Y | btn 1..5 0|1 | key VK 0|1 |
 * scroll N | move DX DY | idr | stop. stdout, JSON lines: state, stats (every second), error, quit (the pad's View + Menu held).
 *
 * Latency rules: decoding order, AsyncDepth 1, one frame in flight; a frame
 * is presented as soon as it is decoded (no audio-clock pacing); when newer
 * frames are already queued it is decoded without a picture (references
 * must be decoded) and not presented; a decode failure returns DR_NEED_IDR.
 *
 * A core dump reboots the head unit: dumping is off before anything else,
 * every fatal signal writes one line and _exit(70)s. */
#include "audio.h"
#include "log.h"
#include "mgvf.h"
#include "pads.h"
#include "usbhid.h"
#include "usbpad.h"
#ifdef MGU_MSDK
#include "decoder_msdk.h"
#endif
extern "C" {
#include <Limelight.h>
}
#include <errno.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>
#include <atomic>
#include <exception>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifndef MGU_VERSION
#define MGU_VERSION "dev"
#endif

int mkcert(const char *dir, std::string *err);   /* mkcert.cpp */
int probe(int w, int h);                          /* probe.cpp (car build only) */

static int g_log = 2;

void log_line(const char *fmt, ...)
{
    char b[1024];
    struct timespec t;
    clock_gettime(CLOCK_REALTIME, &t);
    struct tm tm;
    localtime_r(&t.tv_sec, &tm);
    size_t n = strftime(b, sizeof b, "%Y-%m-%d %H:%M:%S", &tm);
    n += snprintf(b + n, sizeof b - n, ".%03ld ", t.tv_nsec / 1000000);
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(b + n, sizeof b - n, fmt, ap);
    va_end(ap);
    n = strlen(b);
    if (n && b[n - 1] != '\n' && n < sizeof b - 1) b[n++] = '\n';
    if (write(g_log, b, n) < 0) {
    }
}

namespace {

std::mutex g_out;

void emit(const std::string &json)
{
    std::lock_guard<std::mutex> l(g_out);
    std::string s = json + "\n";
    if (write(1, s.data(), s.size()) < 0 && errno == EPIPE) _exit(0);
}

std::string jstr(const char *s)
{
    std::string o = "\"";
    for (; *s; s++) o += (*s == '"' || *s == '\\') ? '\'' : (unsigned char)*s < 32 ? ' ' : *s;
    return o + "\"";
}

void on_fatal(int sig)
{
    char b[48] = "mgu-moonlight: fatal signal ";
    size_t n = strlen(b);
    if (sig >= 10) b[n++] = (char)('0' + sig / 10);
    b[n++] = (char)('0' + sig % 10);
    b[n++] = '\n';
    if (write(g_log, b, n) < 0) {
    }
    _exit(70);
}

void crash_hygiene()
{
    prctl(PR_SET_DUMPABLE, 0);
    struct rlimit no_core = {0, 0};
    setrlimit(RLIMIT_CORE, &no_core);
    static char altstack[64 * 1024];
    stack_t ss;
    memset(&ss, 0, sizeof ss);
    ss.ss_sp = altstack;
    ss.ss_size = sizeof altstack;
    sigaltstack(&ss, nullptr);
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_fatal;
    sa.sa_flags = SA_ONSTACK | SA_RESETHAND;
    sigemptyset(&sa.sa_mask);
    for (int s : {SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGABRT, SIGQUIT, SIGTRAP, SIGSYS}) sigaction(s, &sa, nullptr);
    std::set_terminate([] {
        static const char m[] = "mgu-moonlight: std::terminate\n";
        if (write(g_log, m, sizeof m - 1) < 0) {
        }
        _exit(70);
    });
    signal(SIGPIPE, SIG_IGN);
}

/* ---- stats: written by the decoder and audio threads, read once a second ---- */
struct Acc {
    double sum = 0, max = 0;
    unsigned n = 0;
    void add(double v) { sum += v, n++, max = v > max ? v : max; }
    double avg() const { return n ? sum / n : 0; }
};
struct Counters {
    unsigned frames = 0, shown = 0, skipped = 0, failed = 0, idr = 0, bytes = 0, lost = 0;
    Acc host, assembly, queue, decode, present, total;
};
struct Stats {
    std::mutex m;
    Counters c;
} g_st;

std::atomic<bool> g_stop{false};
std::atomic<int> g_state{0};   /* 0 connecting, 1 streaming, 2 stopped */
std::string g_decoder = "msdk", g_shm = "/dev/shm/mgu-video-jap-moonride";
ytdec::Mgvf g_mgvf;
int g_w = 1920, g_h = 720, g_hz = 60;
int g_last = 0;   /* last frame number submitted (outside Counters: they reset every second) */
std::vector<uint8_t> g_au;
FILE *g_dump = nullptr;
#ifdef MGU_MSDK
woc::Decoder g_dec;
#endif

double now_ms() { return LiGetMicroseconds() / 1000.0; }

/* frames the network lost before frame n (common-c numbers them from 1 and skips the ones it drops
 * waiting for an IDR, as Moonlight's "dropped by your network"); nothing before the first one */
constexpr unsigned frame_gap(int last, int n) { return last > 0 && n > last + 1 ? (unsigned)(n - last - 1) : 0; }
static_assert(frame_gap(0, 1) == 0 && frame_gap(0, 7) == 0 && frame_gap(4, 5) == 0 && frame_gap(4, 8) == 3 &&
              frame_gap(4, 4) == 0 && frame_gap(9, 3) == 0, "frame_gap");

/* ---- video ---- */
int dr_setup(int fmt, int w, int h, int fps, void *, int)
{
    log_line("video: format 0x%x %dx%d@%d, decoder %s", fmt, w, h, fps, g_decoder.c_str());
    const bool hevc = (fmt & VIDEO_FORMAT_MASK_H265) != 0;
    if (!hevc && !(fmt & VIDEO_FORMAT_H264)) {
        log_line("video: only H.264 and HEVC Main are wired up");
        return -1;
    }
    g_au.reserve(1 << 20);
    g_w = w, g_h = h, g_hz = fps, g_last = 0;
    if (g_decoder == "null") return 0;
    std::string err, warn;
    if (!g_mgvf.open(g_shm.c_str(), (uint32_t)w, (uint32_t)h, 3, &err, &warn)) {
        log_line("mgvf: %s", err.c_str());
        return -1;
    }
    if (!warn.empty()) log_line("mgvf: %s", warn.c_str());
#ifdef MGU_MSDK
    /* output = stream size: VPP does no scaling (the host renders 1920x720 natively) */
    if (!g_dec.init("/dev/dri/renderD128", (uint32_t)w, (uint32_t)h, false, &err, hevc)) {
        log_line("msdk: %s", err.c_str());
        return -1;
    }
    return 0;
#else
    log_line("video: this build has no MSDK decoder; use --decoder null");
    return -1;
#endif
}

void dr_cleanup()
{
#ifdef MGU_MSDK
    if (g_decoder == "msdk") g_dec.shutdown();
#endif
    g_mgvf.close();
    if (g_dump) fflush(g_dump);
}

int dr_submit(PDECODE_UNIT du)
{
    const double t0 = now_ms();
    g_au.clear();
    for (PLENTRY e = du->bufferList; e; e = e->next) g_au.insert(g_au.end(), e->data, e->data + e->length);
    if (g_dump) fwrite(g_au.data(), 1, g_au.size(), g_dump);
    /* newer frames are already waiting: decode this one for its references only */
    const bool picture = LiGetPendingVideoFrames() == 0;
    int rc = DR_OK;
    unsigned shown = 0;
    double t_dec = t0;
#ifdef MGU_MSDK
    if (g_decoder == "msdk") {
        std::string err;
        const bool ok = g_dec.feed(g_au.data(), g_au.size(), [&](const woc::VideoFrame &f) {
            t_dec = now_ms();
            if (!f.y) return;
            ytdec::nv12_to_i420(f.y, f.uv, f.pitch, f.w, f.h, g_mgvf.begin());
            g_mgvf.commit();
            shown++;
        }, &err, true, picture, (int64_t)(du->presentationTimeUs / 1000));
        if (!ok) {
            log_line("msdk: frame %d: %s", du->frameNumber, err.c_str());
            rc = DR_NEED_IDR;
        }
    }
#endif
    const double t1 = now_ms();
    std::lock_guard<std::mutex> l(g_st.m);
    Counters &c = g_st.c;
    c.frames++;
    c.lost += frame_gap(g_last, du->frameNumber);
    g_last = du->frameNumber > g_last ? du->frameNumber : g_last;
    c.bytes += (unsigned)g_au.size();
    c.shown += shown;
    if (!picture) c.skipped++;
    if (rc != DR_OK) c.failed++, c.idr++;
    c.host.add(du->frameHostProcessingLatency / 10.0);
    c.assembly.add((du->enqueueTimeUs - du->receiveTimeUs) / 1000.0);
    c.queue.add(t0 - du->enqueueTimeUs / 1000.0);
    c.decode.add(t_dec - t0);
    if (shown) c.present.add(t1 - t_dec);
    /* first packet in -> frame in the MGVF slot (or decode returned, for null) */
    c.total.add(t1 - du->receiveTimeUs / 1000.0);
    return rc;
}

/* ---- connection ---- */
void cl_started()
{
    g_state = 1;
    emit("{\"ev\":\"state\",\"state\":\"streaming\"}");
}
void cl_terminated(int err)
{
    log_line("connection terminated: %d", err);
    emit("{\"ev\":\"state\",\"state\":\"stopped\",\"code\":" + std::to_string(err) + "}");
    g_stop = true;
}
void cl_stage_failed(int stage, int err)
{
    log_line("stage %s failed: %d", LiGetStageName(stage), err);
    emit("{\"ev\":\"error\",\"msg\":" + jstr(LiGetStageName(stage)) + ",\"code\":" + std::to_string(err) + "}");
}
void cl_log(const char *fmt, ...)
{
    char b[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(b, sizeof b, fmt, ap);
    va_end(ap);
    log_line("common-c: %s", b);
}
void cl_status(int s) { log_line("connection status: %s", s == CONN_STATUS_OKAY ? "okay" : "poor"); }
void cl_rumble(unsigned short idx, unsigned short lo, unsigned short hi) { pads_rumble(idx, lo, hi), usbpad_rumble(idx, lo, hi); }

void stats_loop()
{
    while (!g_stop) {
        for (int i = 0; i < 10 && !g_stop; i++) usleep(100 * 1000);
        if (g_state != 1) continue;
        uint32_t rtt = 0, var = 0;
        LiGetEstimatedRttInfo(&rtt, &var);
        char b[1024];
        {
            std::lock_guard<std::mutex> l(g_st.m);
            Counters &s = g_st.c;
            snprintf(b, sizeof b,
                     "{\"ev\":\"stats\",\"fps\":%u,\"shown\":%u,\"skipped\":%u,\"failed\":%u,\"lost\":%u,\"kbps\":%u,"
                     "\"host_ms\":%.1f,\"host_max\":%.1f,\"assembly_ms\":%.2f,\"queue_ms\":%.2f,\"queue_max\":%.2f,"
                     "\"decode_ms\":%.2f,\"decode_max\":%.2f,\"present_ms\":%.2f,\"client_ms\":%.2f,\"client_max\":%.2f,"
                     "\"rtt\":%u,\"rttvar\":%u,\"w\":%d,\"h\":%d,\"hz\":%d,\"codec\":\"H.264\",%s}",
                     s.frames, s.shown, s.skipped, s.failed, s.lost, s.bytes * 8 / 1000, s.host.avg(), s.host.max,
                     s.assembly.avg(), s.queue.avg(), s.queue.max, s.decode.avg(), s.decode.max, s.present.avg(),
                     s.total.avg(), s.total.max, rtt, var, g_w, g_h, g_hz, audio_stats_json().c_str());
            s = Counters();
        }
        emit(b);
    }
}

void stdin_loop()
{
    char line[256];
    FILE *in = stdin;
    while (fgets(line, sizeof line, in)) {
        int a = 0, b = 0;
        if (sscanf(line, "pos %d %d", &a, &b) == 2)
            LiSendMousePositionEvent((short)a, (short)b, (short)g_w, (short)g_h);
        else if (sscanf(line, "move %d %d", &a, &b) == 2)   /* relative: the iDrive controller's touchpad */
            LiSendMouseMoveEvent((short)a, (short)b);
        else if (sscanf(line, "btn %d %d", &a, &b) == 2)
            LiSendMouseButtonEvent(b ? BUTTON_ACTION_PRESS : BUTTON_ACTION_RELEASE, a);
        else if (sscanf(line, "key %d %d", &a, &b) == 2)
            LiSendKeyboardEvent((short)(0x8000 | a), b ? KEY_ACTION_DOWN : KEY_ACTION_UP, 0);
        else if (sscanf(line, "scroll %d", &a) == 1)
            LiSendScrollEvent((signed char)a);
        else if (!strncmp(line, "idr", 3))
            LiRequestIdrFrame();
        else if (!strncmp(line, "stop", 4))
            break;
    }
    g_stop = true;
}

int hexkey(const char *hex, char out[16])
{
    if (strlen(hex) != 32) return -1;
    for (int i = 0; i < 16; i++) {
        unsigned v;
        if (sscanf(hex + 2 * i, "%2x", &v) != 1) return -1;
        out[i] = (char)v;
    }
    return 0;
}

int stream(int argc, char **argv)
{
    std::string host, rtsp, appver, gfever, rikey, audio = "null", pads, logpath;
    int rikeyid = 0, codecs = 0, fps = 60, kbps = 10000, packet = 1392;
    bool hevc = false;
    for (int i = 2; i + 1 < argc; i += 2) {
        std::string k = argv[i];
        const char *v = argv[i + 1];
        if (k == "--host") host = v;
        else if (k == "--rtsp") rtsp = v;
        else if (k == "--appver") appver = v;
        else if (k == "--gfever") gfever = v;
        else if (k == "--codecs") codecs = atoi(v);
        else if (k == "--rikey") rikey = v;
        else if (k == "--rikeyid") rikeyid = atoi(v);
        else if (k == "--w") g_w = atoi(v);
        else if (k == "--h") g_h = atoi(v);
        else if (k == "--fps") fps = atoi(v);
        else if (k == "--kbps") kbps = atoi(v);
        else if (k == "--packet") packet = atoi(v);
        else if (k == "--codec") hevc = std::string(v) == "hevc";
        else if (k == "--decoder") g_decoder = v;
        else if (k == "--audio") audio = v;
        else if (k == "--shm") g_shm = v;
        else if (k == "--pads") pads = v;
        else if (k == "--log") logpath = v;
        else if (k == "--dump") {
            if (!(g_dump = fopen(v, "wbe"))) { perror(v); return 2; }
        }
        else {
            fprintf(stderr, "unknown option %s\n", k.c_str());
            return 2;
        }
    }
    if (!logpath.empty()) {
        int fd = open(logpath.c_str(), O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
        if (fd >= 0) g_log = fd;
    }
    if (host.empty() || appver.empty() || rikey.empty()) {
        fprintf(stderr, "stream needs --host, --appver and --rikey (from /launch)\n");
        return 2;
    }
    if (g_decoder != "null" && g_decoder != "msdk") {
        fprintf(stderr, "--decoder msdk|null\n");
        return 2;
    }
    if (audio_select(audio.c_str()) < 0) {
        fprintf(stderr, "--audio null|wav:PATH|alsa:DEVICE\n");
        return 2;
    }

    STREAM_CONFIGURATION sc;
    LiInitializeStreamConfiguration(&sc);
    sc.width = g_w, sc.height = g_h, sc.fps = fps, sc.bitrate = kbps;
    sc.packetSize = packet >= 512 && packet <= 1392 ? packet : 1392;   // 1024 through the tunnel (moonlightd's relay)
    sc.streamingRemotely = STREAM_CFG_LOCAL;
    sc.audioConfiguration = AUDIO_CONFIGURATION_STEREO;
    sc.supportedVideoFormats = VIDEO_FORMAT_H264 | (hevc ? VIDEO_FORMAT_H265 : 0);   // HEVC: the host picks it when offered
    sc.clientRefreshRateX100 = fps * 100;
    sc.colorSpace = COLORSPACE_REC_709;   /* must match the MGVF header (BT.709 limited) */
    sc.colorRange = COLOR_RANGE_LIMITED;
    sc.encryptionFlags = ENCFLG_AUDIO;    /* video in the clear: no per-frame AES on the Atom */
    if (hexkey(rikey.c_str(), sc.remoteInputAesKey) < 0) {
        fprintf(stderr, "--rikey wants 32 hex digits\n");
        return 2;
    }
    memset(sc.remoteInputAesIv, 0, sizeof sc.remoteInputAesIv);
    const uint32_t iv = htonl((uint32_t)rikeyid);
    memcpy(sc.remoteInputAesIv, &iv, 4);

    SERVER_INFORMATION si;
    LiInitializeServerInformation(&si);
    si.address = host.c_str();
    si.serverInfoAppVersion = appver.c_str();
    si.serverInfoGfeVersion = gfever.empty() ? nullptr : gfever.c_str();
    si.rtspSessionUrl = rtsp.empty() ? nullptr : rtsp.c_str();
    si.serverCodecModeSupport = codecs;

    CONNECTION_LISTENER_CALLBACKS cl;
    LiInitializeConnectionCallbacks(&cl);
    cl.connectionStarted = cl_started;
    cl.connectionTerminated = cl_terminated;
    cl.stageFailed = cl_stage_failed;
    cl.logMessage = cl_log;
    cl.connectionStatusUpdate = cl_status;
    cl.rumble = cl_rumble;

    DECODER_RENDERER_CALLBACKS dr;
    LiInitializeVideoCallbacks(&dr);
    dr.setup = dr_setup;
    dr.cleanup = dr_cleanup;
    dr.submitDecodeUnit = dr_submit;
    dr.capabilities = 0;   /* common-c's decoder thread: the receive path never waits for MSDK */

    AUDIO_RENDERER_CALLBACKS ar;
    LiInitializeAudioCallbacks(&ar);
    audio_callbacks(&ar);

    log_line("mgu-moonlight %s: %s %dx%d@%d %d kbit/s, decoder %s, audio %s", MGU_VERSION, host.c_str(), g_w, g_h,
             fps, kbps, g_decoder.c_str(), audio.c_str());
    emit("{\"ev\":\"state\",\"state\":\"connecting\"}");
    std::thread(stdin_loop).detach();   /* blocks in fgets; exit() reaps it */
    if (LiStartConnection(&si, &sc, &cl, &dr, &ar, nullptr, 0, nullptr, 0) != 0) {
        emit("{\"ev\":\"state\",\"state\":\"stopped\",\"code\":-1}");
        return 1;
    }
    if (!pads.empty()) pads_start(pads.c_str());
    usbpad_start(false);
    usbhid_start(false);
    std::thread st(stats_loop);
    while (!g_stop) usleep(50 * 1000);
    pads_stop();
    usbhid_stop();
    usbpad_stop();
    LiStopConnection();
    st.join();
    emit("{\"ev\":\"state\",\"state\":\"stopped\"}");
    log_line("stopped");
    return 0;
}

}  // namespace

int sniff(int service, int method, int seconds);   /* sniff.cpp */

int main(int argc, char **argv)
{
    crash_hygiene();
    try {
        const std::string cmd = argc > 1 ? argv[1] : "";
        if (cmd == "stream") return stream(argc, argv);
        if (cmd == "launchparams") {
            printf("%s\n", LiGetLaunchUrlQueryParameters());
            return 0;
        }
        if (cmd == "mkcert" && argc == 3) {
            std::string err;
            if (mkcert(argv[2], &err) == 0) return 0;
            fprintf(stderr, "mkcert: %s\n", err.c_str());
            return 1;
        }
#ifdef MGU_MSDK
        if (cmd == "probe") return probe(argc > 3 ? atoi(argv[2]) : 1920, argc > 3 ? atoi(argv[3]) : 720);
#endif
        if (cmd == "padtest") return usbpad_test(argc > 2 ? atoi(argv[2]) : 30);
        if (cmd == "hidtest") return usbhid_test(argc > 2 ? atoi(argv[2]) : 30);
        if (cmd == "sniff" && argc >= 4) return sniff(strtol(argv[2], nullptr, 0), strtol(argv[3], nullptr, 0), argc > 4 ? atoi(argv[4]) : 30);
        if (cmd == "tone" && argc >= 3) return audio_tone(argv[2], argc > 3 ? atoi(argv[3]) : 120);
        if (cmd == "--version") {
            printf("mgu-moonlight %s\n", MGU_VERSION);
            return 0;
        }
        fprintf(stderr, "usage: mgu-moonlight stream ... | mkcert DIR | launchparams | --version\n");
        return 2;
    } catch (const std::exception &e) {
        log_line("exception: %s", e.what());
        return 70;
    }
}
