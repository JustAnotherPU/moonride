# Third-party components

Moonride is GPL-3.0-or-later (`../LICENSE`). It is built with, or ships, the components below. Each licence text
is in this folder; files that carry their own copyright headers keep them.

| Component | Where | Licence | File |
|---|---|---|---|
| moonlight-common-c, commit `e80a786afedeaccff63e839e68c8f3d8a057c13d` (github.com/moonlight-stream/moonlight-common-c) | linked into `mgu-moonlight` (fetched by `native/mgu-moonlight/docker/Dockerfile`) | GPL-3.0 | `moonlight-common-c.LICENSE.txt` |
| ENet (moonlight-common-c submodule) | linked into `mgu-moonlight` | MIT | `enet.LICENSE` |
| nanors (moonlight-common-c submodule) | linked into `mgu-moonlight` | MIT | `nanors.LICENSE` |
| Opus 1.5.2 | linked into `mgu-moonlight` | BSD-3-Clause | `opus.COPYING` |
| Mbed TLS 3.6.7 | linked into `mgu-moonlight` | Apache-2.0 (or GPL-2.0-or-later) | `mbedtls.LICENSE` |
| Intel Media SDK headers | `native/mgu-moonlight/abi/include/mfx` (headers only, to build against the head unit's library) | MIT | `intel-mediasdk-headers.LICENSE` |
| App kit (`kit/`), from github.com/cauliflowermossgrape/idrive7-apps, modified | `kit/`, in the `jap_moonride` package | MIT | `app-kit.LICENSE` (also `kit/LICENSE`) |
| Noto Sans SC glyphs (in the kit's fonts) | `kit/runtime/fonts/cjk.json` | SIL OFL 1.1 | `noto-sans-sc.OFL.txt` (also beside the fonts) |
| Ubuntu font glyphs, rasterised (in the kit's fonts) | `kit/runtime/fonts/{label,bold,num,light,gear}.json` | Ubuntu Font Licence 1.0 | `ubuntu-font.UFL-1.0.txt` (also beside the fonts) |

The `jap-moonride` tool package carries `LICENSE` and the licences of what its binary links (moonlight-common-c,
ENet, nanors, Opus, Mbed TLS, the Media SDK headers) in `licenses/`; the app package carries `LICENSE`, the kit's
licence and the font licences.

Files copied from github.com/robertnisipeanu/idrive-apps (Copyright (C) 2026 Robert Nisipeanu, GPL-3.0-or-later
unless noted; their headers are kept):

- `native/mgu-moonlight/src/decoder_msdk.cpp`, `decoder_msdk.h` (from `native/waze-on-cluster/src`), modified
  2026-11 by JustAnotherPU, as noted in each file
- `native/mgu-moonlight/src/nal_reader.cpp`, `nal_reader.h` (from `native/waze-on-cluster/src`), unchanged
- `native/mgu-moonlight/abi/libmfx.symbols`, `libva.symbols`, `libva-drm.symbols` (from
  `native/waze-on-cluster/abi`), unchanged: exported symbol names of the head unit's libraries
- `native/mgu-moonlight/abi/libvsomeip3.so.3.symbols` (from `native/cluster-render/dcsm/abi`, MPL-2.0 as its
  header says: vsomeip's symbol names), unchanged
- `native/mgu-moonlight/tools/abi.py` (from `native/cluster-render/dcsm/tools`), `ramses_abi.py` (from
  `native/cluster-render/tools`), `woc_abi.py` (from `native/waze-on-cluster/tools`), unchanged

The symbol lists are used only to check the binary's imports.

