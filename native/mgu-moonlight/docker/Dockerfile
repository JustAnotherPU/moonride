# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 JustAnotherPU
#
# mgu-moonlight build image. Runs NATIVELY on the arm64 Mac (colima, linux/arm64): no qemu, no Rosetta.
# Ubuntu 18.04 arm64 + its x86_64 cross toolchain = gcc 7.5, libstdc++ 6.0.24, glibc 2.27 (the head
# unit's). Every static dependency is built twice into /opt/deps/<triplet>:
#   x86_64-linux-gnu   the car binary (cross)
#   aarch64-linux-gnu  the Mac test binary (native, same sources, null decoder)
# Pins: tarballs by sha256 (from the projects' own sha256 files, 2026-11-03), common-c by commit.
FROM ubuntu:18.04@sha256:152dc042452c496007f07ca9127571cb9c29697f42acbfad72324b2bb2e43c98
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      gcc g++ make binutils cmake python3 python3-pyelftools pkg-config git ca-certificates curl bzip2 \
      gcc-x86-64-linux-gnu g++-x86-64-linux-gnu binutils-x86-64-linux-gnu \
      libc6-dev-amd64-cross libstdc++-7-dev-amd64-cross >/dev/null \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN printf '#!/bin/sh\nset -e\ncurl -fsSL -o "/src/${1##*/}" "$1"\necho "$2  /src/${1##*/}" | sha256sum -c -\n' > /usr/local/bin/fetch \
 && chmod +x /usr/local/bin/fetch \
 && for t in x86_64-linux-gnu aarch64-linux-gnu; do \
      cc=$t-gcc; [ $t = aarch64-linux-gnu ] && cc=gcc; \
      printf 'set(CMAKE_SYSTEM_NAME Linux)\nset(CMAKE_C_COMPILER %s)\nset(CMAKE_FIND_ROOT_PATH /opt/deps/%s)\nset(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)\nset(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)\n' $cc $t > /opt/$t.cmake; \
    done

# mbedTLS 3.6 LTS: common-c's USE_MBEDTLS path is PSA crypto; pairing cert generation uses x509write.
RUN fetch https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.7/mbedtls-3.6.7.tar.bz2 \
      a7e8bcbec0e6f761b4af24f25677626b35f762f68eef79c08677a363212d11f6 \
 && tar xjf mbedtls-3.6.7.tar.bz2 \
 && for t in x86_64-linux-gnu aarch64-linux-gnu; do \
      mkdir b-$t && (cd b-$t && cmake ../mbedtls-3.6.7 -DCMAKE_TOOLCHAIN_FILE=/opt/$t.cmake -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/opt/deps/$t -DENABLE_TESTING=OFF -DENABLE_PROGRAMS=OFF -DUSE_SHARED_MBEDTLS_LIBRARY=OFF \
        -DCMAKE_POSITION_INDEPENDENT_CODE=ON >/dev/null && make -s -j"$(nproc)" install >/dev/null) || exit 1; \
    done && rm -rf /src/*

# opus (sha256 from downloads.xiph.org/releases/opus/SHA256SUMS.txt).
RUN fetch https://downloads.xiph.org/releases/opus/opus-1.5.2.tar.gz \
      65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1 \
 && tar xzf opus-1.5.2.tar.gz \
 && for t in x86_64-linux-gnu aarch64-linux-gnu; do \
      cc=$t-gcc; [ $t = aarch64-linux-gnu ] && cc=gcc; \
      mkdir b-$t && (cd b-$t && CC=$cc ../opus-1.5.2/configure -q --host=$t --prefix=/opt/deps/$t --disable-shared \
        --disable-doc --disable-extra-programs >/dev/null && make -s -j"$(nproc)" install >/dev/null) || exit 1; \
    done && rm -rf /src/*

# moonlight-common-c upstream master 2026-11-03 (bundled ENet submodule, nanors vendored). GPL-3.0.
ARG COMMON_C=e80a786afedeaccff63e839e68c8f3d8a057c13d
RUN git clone -q https://github.com/moonlight-stream/moonlight-common-c.git && cd moonlight-common-c \
 && git checkout -q $COMMON_C && git submodule -q update --init \
 # gcc 7 has no GFNI intrinsics: nanors falls back to its reference GF(2^8) code on x86 (FEC runs only on loss)
 && sed -i 's/^#if defined(__x86_64__) || defined(_M_X64) || defined(__i386__) || defined(_M_IX86)$/#if (defined(__clang__) || !defined(__GNUC__) || __GNUC__ >= 8) \&\& (defined(__x86_64__) || defined(_M_X64) || defined(__i386__) || defined(_M_IX86))/' nanors/deps/obl/oblas_common.h \
 && grep -q '__GNUC__ >= 8' nanors/deps/obl/oblas_common.h \
 && for t in x86_64-linux-gnu aarch64-linux-gnu; do \
      mkdir b-$t && (cd b-$t && cmake .. -DCMAKE_TOOLCHAIN_FILE=/opt/$t.cmake -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF -DUSE_MBEDTLS=ON -DCMAKE_PREFIX_PATH=/opt/deps/$t >/dev/null \
        && make -s -j"$(nproc)" >/dev/null \
        && cp libmoonlight-common-c.a enet/libenet.a /opt/deps/$t/lib/ && cp ../src/Limelight.h /opt/deps/$t/include/) || exit 1; \
    done && echo "$COMMON_C" > /opt/deps/COMMON_C_COMMIT && cd /src && rm -rf /src/*
