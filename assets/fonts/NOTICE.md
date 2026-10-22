# Pixel Stack 12px UI font

`pixel-stack-12.woff2` is a renamed, character-subset version of
Fusion Pixel Font 12px Monospaced, Simplified Chinese, by TakWolf and upstream
font contributors. The font is licensed under SIL Open Font License 1.1.
The full license and copyright notices are included in `OFL.txt` and `LICENSES/`.

Official project: https://github.com/TakWolf/fusion-pixel-font

Upstream release: `2026.10.16`

Original file: `fusion-pixel-12px-monospaced-zh_hans.otf.woff2`

Release archive:
https://github.com/TakWolf/fusion-pixel-font/releases/download/2026.10.16/fusion-pixel-font-12px-monospaced-otf.woff2-v2026.10.16.zip

Original file SHA-256:
`22a6148e44b15c64332ab63c8998a540a562c0e1832a3374643b07d5d770c474`

Modifications: retain this game's UI characters and ASCII; rename the font
family to `Pixel Stack` and PostScript name to `PixelStack-12px`. Glyph designs
are unchanged. `update_subset.py` rebuilds the subset from the pinned official
release and current top-level HTML, JavaScript and CSS sources. It does not
install dependencies or change settings.

Use a CSS font size of 12px or a whole multiple of 12px for the intended pixel
grid. The font is bundled locally and requires no network connection at runtime.
