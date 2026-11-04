#!/bin/sh
# Packs the tool artifact dist/jap-moonride@<version>.tgz with the MGU Store's packer (deploy/hu artifact:
# sha256 per file). Needs a checkout of https://github.com/robertnisipeanu/mgu-store in $MGU_STORE.
# Build the binary first: make -C ../../native/mgu-moonlight target
set -eu
# what the binary links (THIRD_PARTY_LICENSES/README.md), shipped with it
LICS="moonlight-common-c.LICENSE.txt enet.LICENSE nanors.LICENSE opus.COPYING mbedtls.LICENSE intel-mediasdk-headers.LICENSE"
here=$(cd "$(dirname "$0")" && pwd)
root=$here/../..
store=${MGU_STORE:?set MGU_STORE to a checkout of github.com/robertnisipeanu/mgu-store}
bin=$root/native/mgu-moonlight/build/target/mgu-moonlight.stripped
file "$bin" | grep -q 'ELF 64-bit.*x86-64' || { echo "build.sh: $bin is not an x86-64 ELF (make target first)" >&2; exit 1; }
mkdir -p "$here/build/licenses"
cp "$bin" "$here/build/mgu-moonlight"
cp "$root/daemon/moonlightd.js" "$root/daemon/gs.js" "$root/daemon/png.js" "$root/daemon/relay.js" "$here/build/"
cp "$root/LICENSE" "$here/build/LICENSE"
for f in $LICS; do cp "$root/THIRD_PARTY_LICENSES/$f" "$here/build/licenses/$f"; done
node --check "$here/build/moonlightd.js"
node "$store/deploy/hu" artifact "$here" --out "$root/dist"
