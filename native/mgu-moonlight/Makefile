# mgu-moonlight: the streaming binary. Built in docker/ (Ubuntu 18.04 arm64, native on
# the Mac, no emulation) for two targets from the same sources:
#   make target   build/target/mgu-moonlight   x86_64 glibc 2.27, MSDK decoder, the car binary;
#                 linked against stubs of the unit's libmfxhw64/libva/libva-drm, every import checked
#   make host     build/host/mgu-moonlight     aarch64 Linux, --decoder null only: streams on the Mac
#                 (colima) to null sinks, for the protocol, pairing and latency numbers
# Docker cannot mount macOS's /var/folders: export TMPDIR=~/Dev/.tmp first.

IMAGE   ?= mgu-moonlight-build:1
COLIMA  ?= $(HOME)/.colima
BUILD   ?= build
PYTHON  ?= python3
VERSION := $(shell git describe --always --dirty 2>/dev/null || echo dev)
RUN     = COLIMA_HOME=$(COLIMA) docker run --rm --platform linux/arm64 --user "$$(id -u):$$(id -g)" \
          -v "$(CURDIR):/w" -w /w $(IMAGE)

CXXFLAGS = -std=c++14 -O2 -g -Wall -Wextra -Werror -Wno-missing-field-initializers -DNDEBUG \
           -DMGU_VERSION='"$(VERSION)"' -Isrc -Iabi/include
SRC  = src/main.cpp src/audio.cpp src/mkcert.cpp src/pads.cpp src/usbpad.cpp src/usbhid.cpp src/sniff.cpp src/mgvf.cpp
MSDK = src/decoder_msdk.cpp src/nal_reader.cpp src/probe.cpp
HDR  = $(wildcard src/*.h)
LIBS = -lmoonlight-common-c -lenet -lopus -lmbedtls -lmbedx509 -lmbedcrypto -pthread -ldl -lm
T = $(BUILD)/target
H = $(BUILD)/host

.PHONY: all target host image in-target in-host clean
all: target host

image:
	COLIMA_HOME=$(COLIMA) docker image inspect $(IMAGE) >/dev/null 2>&1 || \
		COLIMA_HOME=$(COLIMA) docker build -q --platform linux/arm64 -t $(IMAGE) docker
target: image
	$(RUN) make -s BUILD=$(BUILD) VERSION=$(VERSION) in-target
host: image
	$(RUN) make -s BUILD=$(BUILD) VERSION=$(VERSION) in-host

in-target: $(T)/mgu-moonlight
in-host: $(H)/mgu-moonlight

X = x86_64-linux-gnu
$(T)/stub/libmfxhw64.so: abi/libmfx.symbols
	mkdir -p $(@D)
	$(PYTHON) tools/ramses_abi.py stub-source $< > $(@D)/mfx_stub.c
	$(X)-gcc -shared -Wl,-soname,libmfxhw64.so -o $@ $(@D)/mfx_stub.c
$(T)/stub/libva.so.1: abi/libva.symbols
	mkdir -p $(@D)
	$(PYTHON) tools/ramses_abi.py stub-source $< > $(@D)/va_stub.c
	$(X)-gcc -shared -Wl,-soname,libva.so.1 -o $@ $(@D)/va_stub.c
$(T)/stub/libva-drm.so.1: abi/libva-drm.symbols
	mkdir -p $(@D)
	$(PYTHON) tools/ramses_abi.py stub-source $< > $(@D)/va_drm_stub.c
	$(X)-gcc -shared -Wl,-soname,libva-drm.so.1 -o $@ $(@D)/va_drm_stub.c
STUBS = $(T)/stub/libmfxhw64.so $(T)/stub/libva.so.1 $(T)/stub/libva-drm.so.1

# libstdc++/libgcc static: the unit's libstdc++ 6.0.24 is the same gcc 7, but fewer NEEDED is fewer traps.
$(T)/mgu-moonlight: $(SRC) $(MSDK) $(HDR) $(STUBS)
	mkdir -p $(@D)
	$(X)-g++ $(CXXFLAGS) -DMGU_MSDK -I/opt/deps/$(X)/include -L/opt/deps/$(X)/lib \
		-Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 -static-libstdc++ -static-libgcc \
		-o $@ $(SRC) $(MSDK) $(STUBS) $(LIBS)
	$(PYTHON) tools/abi.py check $@ abi/libvsomeip3.so.3.symbols   # loader, glibc/libstdc++ limits
	$(PYTHON) tools/woc_abi.py check-imports $@ --prefix MFX va -- \
		abi/libmfx.symbols abi/libva.symbols abi/libva-drm.symbols
	readelf -d $@ | grep NEEDED
	$(X)-strip -o $@.stripped $@   # the shipped copy; the -g one stays for debugging

$(H)/mgu-moonlight: $(SRC) $(HDR)
	mkdir -p $(@D)
	g++ $(CXXFLAGS) -I/opt/deps/aarch64-linux-gnu/include -L/opt/deps/aarch64-linux-gnu/lib -o $@ $(SRC) $(LIBS)

clean:
	rm -rf $(BUILD)
