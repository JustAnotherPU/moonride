/* SPDX-License-Identifier: MIT
 * Copyright (C) 2026 JustAnotherPU
 *
 * bt_proto.h: wire format between the mgu-moonlight daemon (client) and the private
 * mgu-moonlight-bt helper (server). Header only, no BTstack code: the GPL daemon may include it.
 * Transport: AF_UNIX SOCK_STREAM, one message per '\n'-terminated line (see PROTOCOL.md).
 *   daemon -> helper: plain text commands, e.g. "scan on\n", "rumble 0 65535 0\n"
 *   helper -> daemon: one JSON object per line, e.g. {"ev":"state",...}
 * Gamepad values are already in moonlight-common-c units, so a "state" line maps 1:1 onto
 *   LiSendMultiControllerEvent(idx, mask, buttons, lt, rt, lx, ly, rx, ry)
 * and a "connected" line onto
 *   LiSendControllerArrivalEvent(idx, mask, ctype, supported, caps).
 */
#ifndef BT_PROTO_H
#define BT_PROTO_H

#include <stdio.h>
#include <string.h>

#define BT_PROTO_VERSION      1
#define BT_PROTO_MAX_PADS     4
#define BT_PROTO_MAX_LINE     512
#define BT_PROTO_DEFAULT_SOCK "/run/jap-moonride/bt.sock"
#define BT_PROTO_DEFAULT_TLV  "/var/opt/jap-moonride/bt.tlv"

/* Fixed key order: the helper prints with this format and the daemon scans with it. */
#define BT_PROTO_STATE_FMT                                                                  \
    "{\"ev\":\"state\",\"idx\":%d,\"mask\":%d,\"buttons\":%d,\"lt\":%d,\"rt\":%d,"         \
    "\"lx\":%d,\"ly\":%d,\"rx\":%d,\"ry\":%d}"
#define BT_PROTO_RUMBLE_FMT "rumble %d %d %d %d %d\n" /* idx lo hi lt rt, all 0..65535 */

/* Same values as Limelight.h (A_FLAG ..., LI_CTYPE_*, LI_CCAP_*); the daemon may static_assert them. */
#define BT_UP_FLAG       0x0001
#define BT_DOWN_FLAG     0x0002
#define BT_LEFT_FLAG     0x0004
#define BT_RIGHT_FLAG    0x0008
#define BT_PLAY_FLAG     0x0010
#define BT_BACK_FLAG     0x0020
#define BT_LS_CLK_FLAG   0x0040
#define BT_RS_CLK_FLAG   0x0080
#define BT_LB_FLAG       0x0100
#define BT_RB_FLAG       0x0200
#define BT_SPECIAL_FLAG  0x0400
#define BT_A_FLAG        0x1000
#define BT_B_FLAG        0x2000
#define BT_X_FLAG        0x4000
#define BT_Y_FLAG        0x8000
#define BT_MISC_FLAG     0x200000
#define BT_CTYPE_UNKNOWN  0x00
#define BT_CTYPE_XBOX     0x01
#define BT_CTYPE_PS       0x02
#define BT_CTYPE_NINTENDO 0x03
#define BT_CTYPE_STEAM    0x04
#define BT_CCAP_ANALOG_TRIGGERS 0x01
#define BT_CCAP_RUMBLE          0x02
#define BT_CCAP_TRIGGER_RUMBLE  0x04
#define BT_CCAP_BATTERY_STATE   0x40

typedef struct {
    int idx;     /* 0..3 */
    int mask;    /* activeGamepadMask: bit n = pad n connected */
    int buttons; /* moonlight-common-c *_FLAG bits (A_FLAG 0x1000, ...) */
    int lt, rt;  /* 0..255 */
    int lx, ly, rx, ry; /* -32768..32767, up = positive */
} bt_proto_state;

/* Returns 1 if `line` is a well-formed "state" event and fills *s, else 0. */
static inline int bt_proto_parse_state(const char *line, bt_proto_state *s) {
    return sscanf(line, BT_PROTO_STATE_FMT, &s->idx, &s->mask, &s->buttons, &s->lt, &s->rt,
                  &s->lx, &s->ly, &s->rx, &s->ry) == 9 &&
           s->idx >= 0 && s->idx < BT_PROTO_MAX_PADS;
}

/* Copies the "ev" name of a helper line into out (e.g. "connected"); returns 1 on success. */
static inline int bt_proto_event_name(const char *line, char *out, size_t n) {
    const char *p = strstr(line, "\"ev\":\"");
    size_t i = 0;
    if (!p || n == 0) return 0;
    for (p += 6; *p && *p != '"' && i + 1 < n; p++) out[i++] = *p;
    out[i] = 0;
    return *p == '"';
}

/* Integer field lookup in a helper line: "idx", "pct", "ctype", "caps", "supported", ... */
static inline int bt_proto_int_field(const char *line, const char *key, int *out) {
    char pat[40];
    const char *p;
    snprintf(pat, sizeof pat, "\"%s\":", key);
    p = strstr(line, pat);
    return p && sscanf(p + strlen(pat), "%d", out) == 1;
}

#endif /* BT_PROTO_H */
