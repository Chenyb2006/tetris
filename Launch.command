#!/bin/bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ ! -x "$PROJECT_DIR/Tetris.app/Contents/MacOS/PixelStack" ]]; then
    /bin/bash "$PROJECT_DIR/build-desktop.sh"
fi
open "$PROJECT_DIR/Tetris.app"
