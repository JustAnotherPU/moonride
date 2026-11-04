// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* `mgu-moonlight probe`: read-only, what the unit's MSDK can decode. Opens the render node, initialises
 * VA and an MSDK hardware session and asks MFXVideoDECODE_Query for H.264 and HEVC Main at the stream
 * size; decodes nothing, writes nothing. One JSON line on stdout. HEVC goes to the host only if this
 * says hevc ok. HEVC is a plugin on the unit (no dispatcher): hevc_plugin() loads it by hand, then HEVC is
 * asked again ("hevc_plugin"). */
#include "mfx/mfxvideo.h"
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

extern "C" {
typedef void *VADisplay;
typedef int VAStatus;
VADisplay vaGetDisplayDRM(int fd);
VAStatus vaInitialize(VADisplay dpy, int *major_version, int *minor_version);
VAStatus vaTerminate(VADisplay dpy);
/* not in the trimmed vendored header; exported by the unit's libmfxhw64 (abi/libmfx.symbols) */
mfxStatus MFXVideoDECODE_Query(mfxSession session, mfxVideoParam *in, mfxVideoParam *out);
mfxStatus MFXVideoUSER_Register(mfxSession session, mfxU32 type, const void *plugin);
}

/* The HEVC hardware decoder plugin into session s, as libmfx's dispatcher would: CreatePlugin(MFX_PLUGINID_HEVCD_HW)
 * fills an mfxPlugin (kept opaque here: a struct of handles, well under 256 bytes), MFXVideoUSER_Register(DECODE)
 * hands it to the session. 0 = registered, else the failing step's code (dlopen -1000, symbol -1001). */
int hevc_plugin(mfxSession s, void *plugin)
{
    struct Uid { unsigned char d[16]; };
    static const Uid HEVCD_HW = {{0x33, 0xa6, 0x1c, 0x0b, 0x4c, 0x27, 0x45, 0x4c, 0xa8, 0xd8, 0x5d, 0xde, 0x75, 0x7c, 0x6f, 0x8e}};
    static void *lib = nullptr;   // plugin: 256 bytes, 16-aligned, alive as long as the session uses it
    if (!lib) lib = dlopen("/usr/lib/mediasdk/libmfx_hevcd_hw64.so", RTLD_NOW | RTLD_LOCAL);
    if (!lib) return -1000;
    auto create = (mfxStatus(*)(Uid, void *))dlsym(lib, "CreatePlugin");
    if (!create) return -1001;
    memset(plugin, 0, 256);
    mfxStatus st = create(HEVCD_HW, plugin);
    if (st < MFX_ERR_NONE) return (int)st;
    return (int)MFXVideoUSER_Register(s, 1 /* MFX_PLUGINTYPE_VIDEO_DECODE */, plugin);
}

static int query(mfxSession s, mfxU32 codec, mfxU16 profile, int w, int h)
{
    mfxVideoParam in, out;
    memset(&in, 0, sizeof in);
    in.mfx.CodecId = codec;
    in.mfx.CodecProfile = profile;
    in.IOPattern = MFX_IOPATTERN_OUT_SYSTEM_MEMORY;
    mfxFrameInfo &f = in.mfx.FrameInfo;
    f.FourCC = MFX_FOURCC_NV12, f.ChromaFormat = MFX_CHROMAFORMAT_YUV420, f.PicStruct = MFX_PICSTRUCT_PROGRESSIVE;
    f.Width = (mfxU16)((w + 15) & ~15), f.Height = (mfxU16)((h + 15) & ~15), f.CropW = (mfxU16)w, f.CropH = (mfxU16)h;
    f.FrameRateExtN = 60, f.FrameRateExtD = 1;
    out = in;
    return (int)MFXVideoDECODE_Query(s, &in, &out);
}

int probe(int w, int h)
{
    int fd = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    if (fd < 0) return printf("{\"ev\":\"probe\",\"error\":\"open renderD128\"}\n"), 1;
    VADisplay va = vaGetDisplayDRM(fd);
    int vmaj = 0, vmin = 0;
    if (!va || vaInitialize(va, &vmaj, &vmin) != 0) return printf("{\"ev\":\"probe\",\"error\":\"vaInitialize\"}\n"), close(fd), 1;
    mfxVersion ver = {{MFX_VERSION_MINOR, MFX_VERSION_MAJOR}};
    mfxSession s = nullptr;
    mfxStatus st = MFXInit(MFX_IMPL_HARDWARE | MFX_IMPL_VIA_VAAPI, &ver, &s);
    if (st < MFX_ERR_NONE) return printf("{\"ev\":\"probe\",\"error\":\"MFXInit %d\"}\n", (int)st), vaTerminate(va), close(fd), 1;
    MFXVideoCORE_SetHandle(s, MFX_HANDLE_VA_DISPLAY, va);
    mfxVersion got;
    mfxIMPL impl = 0;
    MFXQueryVersion(s, &got);
    MFXQueryIMPL(s, &impl);
    const int avc = query(s, MFX_CODEC_AVC, 100 /* MFX_PROFILE_AVC_HIGH */, w, h);
    int hevc = query(s, MFX_MAKEFOURCC('H', 'E', 'V', 'C'), 1 /* MFX_PROFILE_HEVC_MAIN */, w, h);
    alignas(16) static unsigned char plugin[256];
    const int plug = hevc < 0 ? hevc_plugin(s, plugin) : 0;
    if (hevc < 0 && plug == 0) hevc = query(s, MFX_MAKEFOURCC('H', 'E', 'V', 'C'), 1, w, h);
    printf("{\"ev\":\"probe\",\"va\":\"%d.%d\",\"mfx\":\"%u.%u\",\"impl\":%d,\"w\":%d,\"h\":%d,\"avc\":%d,\"hevc\":%d,"
           "\"hevc_plugin\":%d,\"avc_ok\":%s,\"hevc_ok\":%s}\n",
           vmaj, vmin, got.Major, got.Minor, (int)impl, w, h, avc, hevc, plug, avc >= 0 ? "true" : "false", hevc >= 0 ? "true" : "false");
    MFXClose(s);
    vaTerminate(va);
    close(fd);
    return 0;
}
