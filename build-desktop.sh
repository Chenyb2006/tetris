#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$PROJECT_DIR/desktop/.build"
APP_DIR="$PROJECT_DIR/Tetris.app"
STAGING_APP="$BUILD_DIR/Tetris.app"

if ! command -v xcrun >/dev/null 2>&1; then
    printf '%s\n' '构建需要 macOS Command Line Tools。也可直接在浏览器打开 index.html。' >&2
    exit 1
fi
node "$PROJECT_DIR/build-coach-worker.js"
for required in index.html engine.js audio.js effects.js app.js styles.css coach.js coach-worker.js coach-worker-source.js coach-client.js; do
    if [[ ! -f "$PROJECT_DIR/$required" ]]; then
        printf '缺少游戏文件：%s\n' "$required" >&2
        exit 1
    fi
done

mkdir -p "$BUILD_DIR" "$STAGING_APP/Contents/MacOS" "$STAGING_APP/Contents/Resources/web"
# Replace bundled resources so removed modules cannot survive from an older build.
rm -rf "$STAGING_APP/Contents/Resources/web" "$STAGING_APP/Contents/Resources/sounds"
mkdir -p "$STAGING_APP/Contents/Resources/web"
node "$PROJECT_DIR/build-sounds.js" "$STAGING_APP/Contents/Resources/sounds"
printf '%s\n' '正在构建 Tetris…'
xcrun swiftc "$PROJECT_DIR/desktop/PixelStack.swift" "$PROJECT_DIR/desktop/PixelAudio.swift" -o "$STAGING_APP/Contents/MacOS/PixelStack" \
    -O -swift-version 5 -target "$(uname -m)-apple-macosx12.0" -framework AppKit -framework WebKit -framework AVFoundation
cp "$PROJECT_DIR/desktop/Info.plist" "$STAGING_APP/Contents/Info.plist"
for resource in index.html engine.js audio.js effects.js app.js styles.css coach.js coach-worker.js coach-worker-source.js coach-client.js; do
    cp "$PROJECT_DIR/$resource" "$STAGING_APP/Contents/Resources/web/$resource"
done
if [[ -f "$PROJECT_DIR/icon.svg" ]]; then
    cp "$PROJECT_DIR/icon.svg" "$STAGING_APP/Contents/Resources/web/icon.svg"
fi
if [[ -d "$PROJECT_DIR/assets" ]]; then
    ditto "$PROJECT_DIR/assets" "$STAGING_APP/Contents/Resources/web/assets"
fi

ICONSET="$BUILD_DIR/AppIcon.iconset"
mkdir -p "$ICONSET"
xcrun swift "$PROJECT_DIR/desktop/Icon.swift" "$BUILD_DIR/AppIcon.png"
for pixel_size in 16 32 128 256 512; do
    sips -z "$pixel_size" "$pixel_size" "$BUILD_DIR/AppIcon.png" --out "$ICONSET/icon_${pixel_size}x${pixel_size}.png" >/dev/null
    retina_size=$((pixel_size * 2))
    sips -z "$retina_size" "$retina_size" "$BUILD_DIR/AppIcon.png" --out "$ICONSET/icon_${pixel_size}x${pixel_size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$STAGING_APP/Contents/Resources/AppIcon.icns"
codesign --force --deep --sign - "$STAGING_APP" >/dev/null 2>&1

mkdir -p "$APP_DIR"
# Keep the app directory's identity while removing obsolete bundled resources.
rm -rf "$APP_DIR/Contents/Resources/web" "$APP_DIR/Contents/Resources/sounds"
ditto "$STAGING_APP" "$APP_DIR"
printf '已构建：%s\n' "$APP_DIR"
