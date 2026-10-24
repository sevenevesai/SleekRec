#!/usr/bin/env bash
# Builds the trimmed FFmpeg 6.1.1 that SleekRec ships on Windows and writes it to
# vendor/ffmpeg/win32-x64. Run inside the MSYS2 MINGW64 environment; see README.md here.
# Usage: build-ffmpeg-win.sh [--clean]   (FFMPEG_BUILD_DIR overrides the work directory)
set -euo pipefail

# Pins. FFmpeg, x264 and nv-codec-headers match the gyan.dev 6.1.1 essentials build that
# ffmpeg-static shipped before; docs/recording.md relies on that FFmpeg's behaviour.
FFMPEG_TAG=n6.1.1
FFMPEG_COMMIT=e38092ef9395d7049f871ef4d5411eb410e283e0
X264_COMMIT=c1c9931dc87289b8aeba78150467f17bdb97d019     # r3172 (core 164), on the stable branch
NVCODEC_BRANCH=sdk/12.1
NVCODEC_COMMIT=75f032b24263c2b684b9921755cafc1c08e41b9d  # n12.1.14.0-1
LIBVPX_TAG=v1.14.1
LIBVPX_COMMIT=12f3a2ac603e8f10742105519e0cd03c3b8f71dd
OPUS_VERSION=1.6.1
OPUS_SHA256=6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1

die() { echo "build-ffmpeg-win: $*" >&2; exit 1; }
[ "${MSYSTEM:-}" = MINGW64 ] || die "run inside the MSYS2 MINGW64 environment (MSYSTEM=MINGW64)"

root=$(cd "$(dirname "$0")/../.." && pwd)
# POSIX form: tar reads a drive-letter path such as S:/x as a remote host:path.
work=$(cygpath -u "${FFMPEG_BUILD_DIR:-$root/.test-output/ffmpeg-build}")
src=$work/src
prefix=$work/prefix
out=$root/vendor/ffmpeg/win32-x64
jobs=$(nproc)
[ "${1:-}" = --clean ] && rm -rf "$work"
mkdir -p "$src" "$prefix/stamps" "$out"
export PKG_CONFIG_PATH=$prefix/lib/pkgconfig
# strip writes the current time into the PE header unless this is set; the n6.1.1 commit time.
export SOURCE_DATE_EPOCH=1703971198

# Fetches one ref into a reusable clone and checks out the pinned commit on a pristine tree.
fetch() { # dir url refspec commit [git fetch options]
  local dir=$src/$1
  if [ ! -d "$dir/.git" ]; then
    git init -q "$dir"
    git -C "$dir" config core.autocrlf false
    git -C "$dir" remote add origin "$2"
  fi
  git -C "$dir" fetch -q "${@:5}" origin "$3"
  git -C "$dir" checkout -q --force --detach "$4"
  git -C "$dir" clean -q -fdx
  [ "$(git -C "$dir" rev-parse HEAD)" = "$4" ] || die "$1 is not at $4"
}
built() { [ -f "$prefix/stamps/$1" ]; }
stamp() { touch "$prefix/stamps/$1"; }

if ! built "nvcodec-$NVCODEC_COMMIT"; then
  fetch nv-codec-headers https://git.videolan.org/git/ffmpeg/nv-codec-headers.git \
    "+refs/heads/$NVCODEC_BRANCH:refs/remotes/origin/$NVCODEC_BRANCH" "$NVCODEC_COMMIT"
  make -C "$src/nv-codec-headers" PREFIX="$prefix" install
  stamp "nvcodec-$NVCODEC_COMMIT"
fi

if ! built "x264-$X264_COMMIT"; then
  # Full history: x264's version.sh derives "r3172" from the commit count against origin/master.
  fetch x264 https://code.videolan.org/videolan/x264.git \
    "+refs/heads/master:refs/remotes/origin/master" "$X264_COMMIT"
  (cd "$src/x264" && ./configure --prefix="$prefix" --enable-static --disable-cli \
    --disable-opencl --disable-avs --disable-swscale --disable-lavf --disable-ffms \
    --disable-gpac --disable-lsmash && make -j"$jobs" && make install)
  stamp "x264-$X264_COMMIT"
fi

if ! built "libvpx-$LIBVPX_COMMIT"; then
  # libvpx-vp9 encodes a test fixture only (scripts/test-recording.cjs); VP9 decoding uses
  # FFmpeg's native decoder, so libvpx is built encoder-only. libvpx embeds its configure
  # arguments in the binary, so it gets no --prefix (no build path in ffmpeg.exe) and installs
  # through DIST_DIR, with vpx.pc pointed at the prefix afterwards.
  fetch libvpx https://chromium.googlesource.com/webm/libvpx \
    "+refs/tags/$LIBVPX_TAG:refs/tags/$LIBVPX_TAG" "$LIBVPX_COMMIT" --depth=1
  (cd "$src/libvpx" && ./configure --target=x86_64-win64-gcc \
    --enable-static --disable-shared --disable-vp8 --disable-vp9-decoder --disable-examples \
    --disable-tools --disable-docs --disable-unit-tests --disable-webm-io --disable-libyuv \
    && make -j"$jobs" && make install DIST_DIR="$prefix")
  sed -i "s|^prefix=.*|prefix=$prefix|" "$prefix/lib/pkgconfig/vpx.pc"
  stamp "libvpx-$LIBVPX_COMMIT"
fi

if ! built "opus-$OPUS_VERSION"; then
  # libopus encodes a test fixture only; Opus decoding uses FFmpeg's native decoder.
  archive=$src/opus-$OPUS_VERSION.tar.gz
  [ -f "$archive" ] || curl -fsSL -o "$archive" "https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz"
  echo "$OPUS_SHA256  $archive" | sha256sum -c --quiet || die "opus archive checksum mismatch"
  rm -rf "$src/opus-$OPUS_VERSION"
  tar -xzf "$archive" -C "$src"
  (cd "$src/opus-$OPUS_VERSION" && ./configure --prefix="$prefix" --enable-static --disable-shared \
    --disable-doc --disable-extra-programs && make -j"$jobs" && make install)
  stamp "opus-$OPUS_VERSION"
fi

fetch ffmpeg https://git.ffmpeg.org/ffmpeg.git "+refs/tags/$FFMPEG_TAG:refs/tags/$FFMPEG_TAG" \
  "$FFMPEG_COMMIT" --depth=1

# Every component below is used by electron/*.ts, scripts/test-recording.cjs or
# scripts/smoke-recording.cjs, or is inserted by the ffmpeg CLI for those commands.
# A missing component fails as FFmpeg error text; add it here and rebuild.
config=(
  --pkg-config=pkgconf --pkg-config-flags=--static
  --extra-version=sleekrec
  --enable-gpl --enable-static --disable-shared
  --extra-ldflags=-static
  --disable-autodetect --disable-w32threads
  --disable-doc --disable-ffplay --disable-ffprobe --disable-network --disable-postproc
  --disable-everything
  --enable-d3d11va --enable-ffnvcodec --enable-nvenc
  --enable-libx264 --enable-libvpx --enable-libopus
  --enable-indev=lavfi
  --enable-protocol=file,pipe
  --enable-demuxer=matroska,mov,concat
  --enable-muxer=matroska,webm,mp4,mov,null,framecrc,hash,pcm_f32le
  --enable-decoder=h264,hevc,vp8,vp9,opus,aac,ffv1,rawvideo,wrapped_avframe,pcm_s16le,pcm_f32le
  --enable-encoder=h264_nvenc,hevc_nvenc,libx264,aac,libopus,libvpx_vp9,ffv1,rawvideo,wrapped_avframe,pcm_s16le,pcm_f32le
  --enable-parser=h264,hevc,aac,opus,vp8,vp9
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc,extract_extradata,vp9_superframe,null
  --enable-filter=ddagrab,color,testsrc,testsrc2,sine,select,settb,setpts,asetpts,aresample,aformat,format,scale,null,anull,trim,atrim
)
(cd "$src/ffmpeg" && ./configure "${config[@]}" && make -j"$jobs" ffmpeg.exe)

cp "$src/ffmpeg/ffmpeg.exe" "$out/ffmpeg.exe"
{
  echo "FFmpeg $FFMPEG_TAG ($FFMPEG_COMMIT), built by scripts/ffmpeg/build-ffmpeg-win.sh."
  echo "Configure line, sources and versions: scripts/ffmpeg/README.md. FFmpeg with libx264 is"
  echo "distributed under the GNU GPL version 2 or later (below), followed by the notices of the"
  echo "statically linked libvpx, libopus and nv-codec-headers."
  for notice in ffmpeg/COPYING.GPLv2 libvpx/LICENSE libvpx/PATENTS "opus-$OPUS_VERSION/COPYING"; do
    printf '\n==== %s ====\n\n' "$notice"
    cat "$src/$notice"
  done
  printf '\n==== nv-codec-headers (include/ffnvcodec/nvEncodeAPI.h) ====\n\n'
  sed -n '/Copyright/,/\*\//p' "$src/nv-codec-headers/include/ffnvcodec/nvEncodeAPI.h"
} | sed 's/\r$//' > "$out/LICENSE.txt"

sha256sum "$out/ffmpeg.exe"
stat -c '%s bytes' "$out/ffmpeg.exe"
"$out/ffmpeg.exe" -hide_banner -version
