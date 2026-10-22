"""Rebuild this game's OFL-licensed 12 px UI font subset. Requires fontTools+brotli."""

from io import BytesIO
from pathlib import Path
import hashlib
import re
import urllib.request
import zipfile

from fontTools import subset
from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent.parent
RELEASE = "2026.10.16"
ARCHIVE = f"fusion-pixel-font-12px-monospaced-otf.woff2-v{RELEASE}.zip"
URL = f"https://github.com/TakWolf/fusion-pixel-font/releases/download/{RELEASE}/{ARCHIVE}"
FONT = "fusion-pixel-12px-monospaced-zh_hans.otf.woff2"
EXTRAS = (
    "小方块俄罗斯方块游戏模式经典马拉松竞速禅复古两分钟记录设置继续暂停开始退出操作指南最佳"
    "得分等级时间行数暂存下一块自动保存本地离线准备就绪按键手感存档备份全部音效锁定延迟"
    "界面调节显示恢复默认手柄单人视觉方形像素圆角街机黑白色彩像素方块全屏最高成绩影子落点"
    "预览挑战快速返回主菜单重新开始继续游戏得分纪录保存成功确认取消亮度音量排行榜操作按下"
    "任意键加载中⌘⌥⇧←→↑↓↶↷⏎␣·×—–…✓▶Ⅱ■□▸▾∞±≤≥"
)

with urllib.request.urlopen(URL) as response:
    archive = zipfile.ZipFile(BytesIO(response.read()))
source_bytes = archive.read(FONT)
font = TTFont(BytesIO(source_bytes))
for name in archive.namelist():
    if name == "OFL.txt" or name.startswith("LICENSES/"):
        path = HERE / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(archive.read(name))

text = "".join(chr(i) for i in range(32, 127)) + EXTRAS
for pattern in ("*.html", "*.js", "*.css"):
    for path in PROJECT.glob(pattern):
        source = path.read_text(encoding="utf-8")
        text += source
        text += "".join(chr(int(c, 16)) for c in re.findall(r"\\u([0-9a-fA-F]{4})", source))
requested = {ord(c) for c in text if c not in "\n\t\r"}
missing = requested - font.getBestCmap().keys()

options = subset.Options()
options.flavor = "woff2"
options.layout_features = "*"
options.name_IDs = ["*"]
options.name_legacy = True
options.name_languages = ["*"]
subsetter = subset.Subsetter(options=options)
subsetter.populate(unicodes=requested)
subsetter.subset(font)

# Rename the modified font while preserving all copyright and license records.
names = {
    1: "Pixel Stack", 2: "Regular", 3: "Pixel Stack 12px UI subset 2026.10.19",
    4: "Pixel Stack 12px", 6: "PixelStack-12px", 16: "Pixel Stack", 17: "Regular",
}
for record in font["name"].names:
    if record.nameID in names:
        record.string = names[record.nameID].encode(record.getEncoding())
if "CFF " in font:
    cff = font["CFF "].cff
    cff.fontNames = ["PixelStack-12px"]
    cff.topDictIndex[0].FamilyName = "Pixel Stack"
    cff.topDictIndex[0].FullName = "Pixel Stack 12px"

font.flavor = "woff2"
output = HERE / "pixel-stack-12.woff2"
font.save(output)
(HERE / "characters.txt").write_text("".join(chr(c) for c in sorted(requested)), encoding="utf-8")
print(f"Wrote {output.name}: {output.stat().st_size:,} bytes")
print(f"Requested: {len(requested)} characters; missing: {''.join(chr(c) for c in sorted(missing))}")
print(f"Original SHA-256: {hashlib.sha256(source_bytes).hexdigest()}")
