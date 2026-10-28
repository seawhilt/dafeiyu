#!/usr/bin/env python3
"""Import the selected dsh-pet (MIT) VP9-alpha WebM clips as runtime frame assets.

Source project: https://github.com/PC2005-cloud/dsh-pet (MIT, Copyright (c) 2026
PC2005-cloud). Its clips share one 640x360 canvas with the character anchored to
a fixed feet line (y=330) and a fixed center, so a single global crop window --
the union alpha bounding box across every imported clip -- keeps the feet line
and cross-clip alignment (crossfades, walk ground line) intact.

Two ffmpeg facts shape the pipeline: VP9 alpha lives in WebM BlockAdditions and
ffmpeg's native vp9 decoder ignores it (``-c:v libvpx-vp9`` is required), and
alpha becomes a plain gray plane through ``alphaextract``. The bounding box is
therefore measured by piping alphaextract rawvideo through Python and scanning
rows for non-transparent pixels -- the only dependency is ffmpeg with libvpx.

Frames are re-encoded as transparent WebP (q68) at the clips' native 24 fps,
which PySide6 decodes natively and keeps the bundled package small.

Usage:
    python scripts/import_dshpet_webm.py \
        --source <path to dsh-pet>/assets/webm \
        --ffmpeg <ffmpeg bin directory> \
        --out <repository root>

The generated assets/pet-manifest.json and assets/pet/**.webp are committed;
this script is a maintainer tool, not part of the runtime.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

CANVAS_WIDTH = 640
CANVAS_HEIGHT = 360
FPS = 24
FRAME_MS = 42  # round(1000 / 24); the source clips are natively 24 fps, so no decimation
QUALITY = 68
PAD = 12
ALPHA_THRESHOLD = 8

# (clip key, source file name, loop, (start_sec, end_sec) or None for full)
# Keep the source's entrance and return-to-rest poses. Taking only the middle
# of a click/eating action leaves hands, bubbles or tokens onscreen at the cut.
# Dragging is the exception: loop only the suspended portion, then play the
# source's complete landing once on mouse-up.
SELECTION = [
    ("idle", "待机呼吸休闲.webm", True, None),
    ("waiting", "工作状态-原地踱步张望.webm", True, None),
    ("thinking", "工作状态-思考冒泡.webm", True, None),
    ("working", "工作状态-忙碌点按.webm", True, None),
    ("working_search", "工作状态-原地踱步张望.webm", True, None),
    ("working_command", "工作状态-清点归档.webm", True, None),
    ("success", "工作状态-雀跃庆祝.webm", False, None),
    # This upstream clip ends crouching, without a return to the first pose.
    # Hold its final pose instead of snapping back to standing every five seconds.
    ("error", "工作状态-垂头叹气冒汗.webm", False, None),
    ("dragging", "被鼠标拖拽悬空反馈.webm", True, (2.0, 8.0)),
    ("dragging_release", "被鼠标拖拽悬空反馈.webm", False, (8.0, 10.04)),
    ("head_pat", "点击回应-挠痒咯咯笑.webm", False, None),
    ("poke", "点击回应-元气挥手.webm", False, None),
    ("tail", "鲸鱼吐泡泡特效.webm", False, None),
    ("eat_token", "吃Token.webm", False, None),
    ("idle_stretch", "超大伸懒腰.webm", False, None),
    ("idle_yawn", "哈欠连天.webm", False, None),
    # Work states that deserve full motion.
    ("write_code", "写代码.webm", True, None),
    ("note_taking", "轻快记录.webm", True, None),
]
# Decorative clips: idle variety, reactions, chatter, meals, quota, holidays.
# They play at half rate, which halves their size with little visible loss.
DECOR_FPS = 12
SELECTION += [
    (key, f"{name}.webm", False, None, DECOR_FPS)
    for key, name in [
        ("look_around", "东张西望"),
        ("hum", "悠闲哼歌"),
        ("rubik", "原地专心玩魔方"),
        ("fan", "摇扇纳凉"),
        ("pet_cat", "撸猫"),
        ("doze", "打瞌睡被惊醒"),
        ("curtsy", "女仆屈膝礼仪"),
        ("nap", "原地小憩沉眠"),
        ("click_angry", "点击回应-傲娇生气"),
        ("click_shy", "点击回应-害羞惊讶"),
        ("click_happy", "点击回应-开心跃动"),
        ("startled", "被吓一跳"),
        ("say_daze", "碎碎念-发呆碎碎念"),
        ("say_screen", "碎碎念-对屏碎碎念"),
        ("say_wipe", "碎碎念-擦桌碎碎念"),
        ("breakfast", "吃早餐"),
        ("lunch", "吃午餐"),
        ("hotpot", "涮火锅"),
        ("watermelon", "吃西瓜"),
        ("money_worry", "余额-数金皱眉"),
        ("dumplings", "吃饺子"),
        ("red_packet", "收红包"),
        ("write_fu", "写福字"),
        ("tangyuan", "吃汤圆"),
        ("qingtuan", "吃青团"),
        ("zongzi", "吃粽子"),
        ("chongyang", "吃重阳糕"),
        ("laba", "吃腊八粥"),
        ("pumpkin", "讨糖南瓜灯"),
        ("snowman", "堆雪人"),
        ("gift", "拆礼物"),
        # Every remaining upstream clip, so the pet has the full repertoire.
        ("juggle", "三球抛接"),
        ("gomoku", "下五子棋"),
        ("mooncake", "中秋赏月吃月饼"),
        ("maid_dance", "优雅女仆舞"),
        ("money_empty", "余额-分文不剩"),
        ("money_broke", "余额-袋空如洗"),
        ("money_jingle", "余额-金袋叮当"),
        ("money_ok", "余额-钱袋如常"),
        ("money_full", "余额-钱袋满溢"),
        ("snack_caught", "偷吃零食被抓住"),
        ("flower_magic", "凭空生花"),
        ("animal_friends", "动物环绕"),
        ("run_in_place", "原地左转奔跑"),
        ("tap_desk", "原地敲击桌面互动"),
        ("float_step", "原地漂浮踏步"),
        ("jump_grab", "原地跳跃抓碎头顶物品"),
        ("toy_car", "原地蹲下玩玩具汽车"),
        ("squash", "原地重力下蹲压缩"),
        ("dove_magic", "变鸽子"),
        ("otaku_dance", "可爱宅舞"),
        ("ice_cream", "吃冰淇淋融化"),
        ("crab", "吃大闸蟹"),
        ("niangao", "吃年糕"),
        ("dinner", "吃晚餐"),
        ("rice", "吃白饭"),
        ("tanghulu", "吃糖葫芦"),
        ("noodles", "吃长寿面"),
        ("balloon", "吹气球"),
        ("flute", "吹笛子"),
        ("snack", "大口吃零食"),
        ("spin", "小幅度原地360度旋转展示"),
        ("violin", "小提琴演奏"),
        ("card_magic", "扑克魔术"),
        ("top", "抽陀螺"),
        ("chrysanthemum", "插茱萸赏菊"),
        ("sky_lantern", "放孔明灯"),
        ("river_lantern", "放河灯"),
        ("fireworks", "放烟花"),
        ("kite", "放风筝"),
        ("outfit", "整体换装试色"),
        ("what_to_eat", "是啊，吃什么"),
        ("brush_teeth", "晨间刷牙"),
        ("deep_think", "深度思考碎碎念"),
        ("mirror", "照镜子"),
        ("water_gun", "玩水枪"),
        ("game_rage", "玩游戏气急败坏"),
        ("tail_slap", "用鲸鱼尾巴拍打地面"),
        ("qixi", "穿针乞巧"),
        ("lion_dance", "舞狮头"),
        ("swing", "荡秋千"),
        ("ghost", "萌化小幽灵"),
        ("blue_whale", "蓝鲸现世"),
        ("butterflies", "蝴蝶蜜蜂环绕头顶开花"),
        ("crab_walk", "螃蟹走路"),
        ("leaves", "被落叶淹没"),
        ("xmas_tree", "装点圣诞树"),
        ("shuttlecock", "踢毽子"),
        ("sway_dance", "轻快摇摆舞"),
        ("rocking_horse", "骑木马"),
    ]
]
# The character's window. Clips that fit share it; clips whose props reach
# further get a wider window centred on the same point with the same top and
# feet line, and the helpers draw every frame centred on the pet, so all
# clips stay aligned while the pet's hit area keeps the base size.
FIXED_CROP = (100, 0, 412, 344)
CROP_CENTER_X = FIXED_CROP[0] + FIXED_CROP[2] // 2


def clip_crop(box: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    """FIXED_CROP when the clip fits, else a symmetric wider window."""
    if box[0] >= FIXED_CROP[0] and box[2] <= FIXED_CROP[0] + FIXED_CROP[2]:
        return FIXED_CROP
    half = max(CROP_CENTER_X - box[0], box[2] - CROP_CENTER_X) + PAD
    half = min(half + half % 2, CROP_CENTER_X, CANVAS_WIDTH - CROP_CENTER_X)
    return CROP_CENTER_X - half, FIXED_CROP[1], half * 2, FIXED_CROP[3]

STATE_MAP = {
    "IDLE": "idle",
    "THINKING": "thinking",
    "WORKING": "working",
    "WAITING": "waiting",
    "SUCCESS": "success",
    "ERROR": "error",
    "DISCONNECTED": "idle",
}
WORKING_ACTIVITY_MAP = {
    "searching": "working_search",
    "commanding": "working_command",
    "editing": "write_code",
    "testing": "note_taking",
    "using-tool": "working",
}
# Everyday clips the idle pet picks from at random. Meals, seasons, holidays
# and quota clips are left out: the chatter plays them when they fit.
IDLE_MICRO_CLIPS = [
    "idle_stretch", "idle_yawn", "eat_token", "look_around", "hum",
    "rubik", "fan", "pet_cat", "doze", "curtsy",
    "juggle", "gomoku", "maid_dance", "snack_caught", "flower_magic",
    "animal_friends", "run_in_place", "tap_desk", "float_step", "jump_grab",
    "toy_car", "squash", "dove_magic", "otaku_dance", "balloon", "flute",
    "spin", "violin", "card_magic", "top", "outfit", "mirror", "game_rage",
    "tail_slap", "swing", "blue_whale", "butterflies", "crab_walk",
    "shuttlecock", "sway_dance", "rocking_horse",
]
# Clicking the same spot cycles through these; the last entry answers rapid
# repeated clicks.
INTERACTION_VARIANTS = {
    "head_pat": ["head_pat", "click_shy"],
    "poke": ["poke", "click_happy", "startled"],
    "tail": ["tail", "tail_slap"],
    "annoyed": ["click_angry"],
}
SAY_CLIPS = ["say_daze", "say_screen", "say_wipe", "deep_think"]
# Work states rotate through these at the end of each pass, so a long task
# does not loop one clip; the first entry is the state's own clip.
LOOP_VARIANTS = {
    "thinking": ["thinking", "deep_think", "tap_desk"],
    "working": ["working", "write_code", "tap_desk"],
    "write_code": ["write_code", "working", "note_taking"],
    "working_search": ["working_search", "look_around", "tap_desk"],
    "working_command": ["working_command", "note_taking", "tap_desk"],
    "note_taking": ["note_taking", "working_command", "write_code"],
    "waiting": ["waiting", "look_around", "tap_desk"],
}
# Right-click "动作" menu, grouped like dsh-pet's category menu.
ACTION_MENU = [
    {"label": "互动", "items": [
        ["摸摸头", "head_pat", "好啦好啦，知道你喜欢我~"],
        ["戳一戳", "poke", "戳我干嘛，任务还在跑呢"],
        ["摸尾巴", "tail", "尾巴不是进度条啦！"],
        ["害羞", "click_shy", "诶？突然这样……"],
        ["开心", "click_happy", "嘿嘿，开心！"],
        ["生气", "click_angry", "哼，不理你了"],
        ["吓一跳", "startled", "哇！吓我一跳"],
        ["行礼", "curtsy", "请多指教~"],
    ]},
    {"label": "日常", "items": [
        ["伸懒腰", "idle_stretch", "伸个懒腰，舒服~"],
        ["打哈欠", "idle_yawn", "啊——有点困了"],
        ["东张西望", "look_around", "有什么新鲜事吗？"],
        ["哼歌", "hum", "啦啦啦~"],
        ["扇扇子", "fan", "好热好热"],
        ["撸猫", "pet_cat", "猫猫好可爱"],
        ["打瞌睡", "doze", "我没睡！我在思考！"],
        ["小憩", "nap", "Zzz……"],
        ["刷牙", "brush_teeth", "刷刷刷，牙齿白白"],
        ["照镜子", "mirror", "今天也很可爱"],
        ["换装", "outfit", "这件好看吗？"],
        ["敲桌子", "tap_desk", "嗒嗒嗒……"],
        ["拍尾巴", "tail_slap", "啪嗒啪嗒"],
        ["被落叶埋了", "leaves", "唔……全是叶子"],
    ]},
    {"label": "工作", "items": [
        ["写代码", "write_code", "噼里啪啦写代码中"],
        ["记笔记", "note_taking", "记下来记下来"],
        ["深度思考", "deep_think", "让我想想……"],
        ["庆祝", "success", "耶！"],
    ]},
    {"label": "才艺", "items": [
        ["女仆舞", "maid_dance", "献上一支舞~"],
        ["宅舞", "otaku_dance", "跟我一起跳！"],
        ["摇摆舞", "sway_dance", "摇摆摇摆~"],
        ["转个圈", "spin", "看我转圈圈"],
        ["小提琴", "violin", "来一曲吧"],
        ["吹笛子", "flute", "悠扬~"],
        ["抛球", "juggle", "一二三，接住！"],
        ["扑克魔术", "card_magic", "你选的是这张吗？"],
        ["变鸽子", "dove_magic", "见证奇迹的时刻"],
        ["变花", "flower_magic", "送你一朵花"],
        ["小幽灵", "ghost", "呜~我是小幽灵"],
        ["蓝鲸现身", "blue_whale", "看，大鲸鱼！"],
    ]},
    {"label": "玩耍", "items": [
        ["玩魔方", "rubik", "这一面马上就好"],
        ["下五子棋", "gomoku", "该你下了"],
        ["打游戏", "game_rage", "啊啊啊又输了！"],
        ["玩具车", "toy_car", "嘟嘟嘟~"],
        ["抽陀螺", "top", "转起来！"],
        ["踢毽子", "shuttlecock", "一个，两个……"],
        ["吹气球", "balloon", "呼——好大的气球"],
        ["放风筝", "kite", "飞高高~"],
        ["荡秋千", "swing", "荡呀荡~"],
        ["骑木马", "rocking_horse", "驾！"],
        ["玩水枪", "water_gun", "看招！"],
        ["跳起来抓", "jump_grab", "抓到了！"],
        ["原地跑步", "run_in_place", "跑跑跑~"],
        ["漂浮踏步", "float_step", "飘起来了"],
        ["蹲一蹲", "squash", "压扁扁"],
        ["螃蟹步", "crab_walk", "横着走~"],
        ["动物朋友", "animal_friends", "大家都来啦"],
        ["蝴蝶环绕", "butterflies", "花开啦~"],
    ]},
    {"label": "吃东西", "items": [
        ["吃 Token", "eat_token", "Token 真好吃~"],
        ["吃早餐", "breakfast", "早餐要吃好"],
        ["吃午餐", "lunch", "午饭时间到"],
        ["吃晚餐", "dinner", "晚饭吃什么呢"],
        ["吃什么呢", "what_to_eat", "是啊，吃什么呢？"],
        ["涮火锅", "hotpot", "火锅yyds"],
        ["吃白饭", "rice", "干饭人干饭魂"],
        ["吃零食", "snack", "嘎吱嘎吱"],
        ["偷吃被抓", "snack_caught", "我、我没有偷吃！"],
        ["吃西瓜", "watermelon", "夏天就要吃西瓜"],
        ["吃冰淇淋", "ice_cream", "快化了快化了"],
        ["吃糖葫芦", "tanghulu", "酸酸甜甜"],
        ["吃大闸蟹", "crab", "秋风起，蟹脚痒"],
        ["吃长寿面", "noodles", "长长久久"],
    ]},
    {"label": "节日", "items": [
        ["吃饺子", "dumplings", "饺子来咯"],
        ["收红包", "red_packet", "恭喜发财，红包拿来"],
        ["写福字", "write_fu", "福到了"],
        ["舞狮", "lion_dance", "咚咚锵！"],
        ["放烟花", "fireworks", "砰——好漂亮"],
        ["吃年糕", "niangao", "年年高升"],
        ["吃汤圆", "tangyuan", "团团圆圆"],
        ["放孔明灯", "sky_lantern", "许个愿吧"],
        ["吃青团", "qingtuan", "春天的味道"],
        ["吃粽子", "zongzi", "甜粽还是咸粽？"],
        ["穿针乞巧", "qixi", "七夕快乐"],
        ["放河灯", "river_lantern", "愿一切安好"],
        ["赏月吃月饼", "mooncake", "月亮好圆"],
        ["赏菊", "chrysanthemum", "九月九，赏菊花"],
        ["吃重阳糕", "chongyang", "登高望远"],
        ["喝腊八粥", "laba", "过了腊八就是年"],
        ["南瓜灯", "pumpkin", "不给糖就捣蛋"],
        ["圣诞树", "xmas_tree", "圣诞快乐"],
        ["堆雪人", "snowman", "雪人做好啦"],
        ["拆礼物", "gift", "是什么呢是什么呢"],
    ]},
    {"label": "钱包", "items": [
        ["钱袋满满", "money_full", "钱包鼓鼓的"],
        ["金袋叮当", "money_jingle", "叮当叮当"],
        ["钱袋如常", "money_ok", "还够用"],
        ["数钱皱眉", "money_worry", "怎么又少了……"],
        ["袋空如洗", "money_broke", "钱包空空"],
        ["分文不剩", "money_empty", "一分钱都没了"],
    ]},
]
IDLE_MICRO_INTERVALS_MS = {
    "quiet": [20000, 40000],
    "normal": [8000, 15000],
    "lively": [3000, 6000],
}
# Provenance for the committed frames. assets/pet-manifest.json records this
# revision as assetSource.commit, and the per-video SHA-256s it contains are
# what the asset tests verify. This constant previously carried
# 549fff2ea33c2acfb16612c76912c6137da4a758; the committed frames and the
# manifest agree on eabaf20..., so that is the authoritative pin. The frame
# windows in SELECTION are keyed to the source files listed in the manifest:
# re-measure them (and regenerate the manifest) if importing another revision,
# using --source-commit to record which tree was used.
UPSTREAM_COMMIT = "eabaf20d4e19e8ac5ac2230d9de0f854a81a7f7b"

_OPAQUE = bytes(1 if value > ALPHA_THRESHOLD else 0 for value in range(256))


def run(command: list[str]) -> None:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(command)}\n{result.stderr[-2000:]}")


def capture(command: list[str]) -> bytes:
    result = subprocess.run(command, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(command)}\n{result.stderr[-2000:]!r}")
    return result.stdout


def selection_entries():
    """SELECTION rows normalised to (key, file, loop, window, fps)."""
    for row in SELECTION:
        yield row if len(row) == 5 else (*row, FPS)


def frame_count_and_box(ffmpeg: Path, source: Path) -> tuple[int, tuple[int, int, int, int]]:
    """Frame count and union alpha bounding box (x0, y0, x1, y1) of one source.

    The alpha plane is piped out as raw 8-bit gray rows; scanning each row with
    translate() plus find()/rfind() keeps the whole pass in fast C-level bytes
    operations.
    """
    gray = capture([
        str(ffmpeg), "-v", "error", "-c:v", "libvpx-vp9", "-i", str(source),
        "-vf", f"fps={FPS},alphaextract",
        "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ])
    frame_bytes = CANVAS_WIDTH * CANVAS_HEIGHT
    if len(gray) == 0 or len(gray) % frame_bytes != 0:
        raise RuntimeError(f"unexpected rawvideo size {len(gray)} for {source}")
    frames = len(gray) // frame_bytes
    min_x, min_y, max_x, max_y = CANVAS_WIDTH, CANVAS_HEIGHT, -1, -1
    for frame_index in range(frames):
        base = frame_index * frame_bytes
        for y in range(CANVAS_HEIGHT):
            row = gray[base + y * CANVAS_WIDTH:base + (y + 1) * CANVAS_WIDTH]
            opaque = row.translate(_OPAQUE)
            first = opaque.find(1)
            if first < 0:
                continue
            if y < min_y:
                min_y = y
            max_y = y
            if first < min_x:
                min_x = first
            last = opaque.rfind(1)
            if last + 1 > max_x:
                max_x = last + 1
    if max_x < 0:
        raise RuntimeError(f"no opaque pixels found in {source}")
    return frames, (min_x, min_y, max_x + 1, max_y + 1)


def global_crop_box(boxes: list[tuple[int, int, int, int]]) -> tuple[int, int, int, int]:
    x0 = min(box[0] for box in boxes) - PAD
    y0 = min(box[1] for box in boxes) - PAD
    x1 = max(box[2] for box in boxes) + PAD
    y1 = max(box[3] for box in boxes) + PAD
    x0 = max(0, x0 - x0 % 2)
    y0 = max(0, y0 - y0 % 2)
    x1 = min(CANVAS_WIDTH, x1 + x1 % 2)
    y1 = min(CANVAS_HEIGHT, y1 + y1 % 2)
    return x0, y0, x1 - x0, y1 - y0  # x, y, w, h


def encode_webp(ffmpeg: Path, source: Path, crop: tuple[int, int, int, int], target: Path, fps: int = FPS) -> list[Path]:
    """Encode the full source at `fps` as cropped transparent WebP frames.

    Uses ffmpeg's libwebp encoder when it is built in; otherwise decodes to
    PNG and encodes each frame with cwebp (same libwebp settings).
    """
    target.mkdir(parents=True, exist_ok=True)
    decode = [
        str(ffmpeg), "-v", "error", "-c:v", "libvpx-vp9", "-i", str(source),
        "-vf", f"fps={fps},crop={crop[2]}:{crop[3]}:{crop[0]}:{crop[1]}",
    ]
    cwebp = shutil.which("cwebp")
    if cwebp is None:
        run([*decode, "-c:v", "libwebp", "-lossless", "0", "-q:v", str(QUALITY), "-compression_level", "4",
             f"{target}/frame_%03d.webp"])
        return sorted(target.glob("frame_*.webp"))
    run([*decode, "-pix_fmt", "rgba", f"{target}/frame_%03d.png"])
    pngs = sorted(target.glob("frame_*.png"))

    def convert(png: Path) -> None:
        run([cwebp, "-quiet", "-q", str(QUALITY), "-m", "4", str(png), "-o", str(png.with_suffix(".webp"))])
        png.unlink()

    with ThreadPoolExecutor() as pool:
        list(pool.map(convert, pngs))
    return sorted(target.glob("frame_*.webp"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="dsh-pet assets/webm directory")
    parser.add_argument("--ffmpeg", type=Path, required=True, help="ffmpeg bin directory")
    parser.add_argument("--out", type=Path, required=True, help="repository root")
    parser.add_argument("--source-commit", default=UPSTREAM_COMMIT, help="upstream revision used for the source files")
    args = parser.parse_args()

    ffmpeg = args.ffmpeg / "ffmpeg.exe"
    if not ffmpeg.exists():
        ffmpeg = args.ffmpeg / "ffmpeg"
    pet_root = args.out.resolve() / "assets" / "pet"
    if pet_root.is_symlink() or not pet_root.resolve().is_relative_to(args.out.resolve()):
        raise RuntimeError("asset output must stay inside the selected repository")
    manifest_path = args.out / "assets" / "pet-manifest.json"

    entries = list(selection_entries())
    missing = sorted({name for _, name, _, _, _ in entries if not (args.source / name).exists()})
    if missing:
        print(f"missing source clips: {missing}", file=sys.stderr)
        return 1

    crop = FIXED_CROP
    sources = {}
    previous = {}
    if manifest_path.exists():
        previous = json.loads(manifest_path.read_text(encoding="utf-8")).get("clips", {})
    hashes = {name: hashlib.sha256((args.source / name).read_bytes()).hexdigest() for _, name, _, _, _ in entries}

    def reusable(key: str, name: str, fps: int) -> bool:
        old = previous.get(key)
        return bool(old) and old["source"]["sha256"] == hashes[name] and old["frameMs"] == round(1000 / fps) \
            and all((pet_root / frame).exists() for frame in old["frames"])

    for key, name, _, _, fps in entries:
        if reusable(key, name, fps) or name in sources:
            continue
        sources[name] = frame_count_and_box(ffmpeg, args.source / name)
        print(f"measured {name}: {sources[name][0]} frames, crop {clip_crop(sources[name][1])}")

    pet_root.mkdir(parents=True, exist_ok=True)
    keys = {key for key, *_ in entries}
    for directory in pet_root.iterdir():
        if directory.is_dir() and directory.name not in keys:
            shutil.rmtree(directory)
    encoded: dict[tuple[str, int], list[Path]] = {}
    clips: dict[str, dict] = {}
    for key, name, loop, window, fps in entries:
        if reusable(key, name, fps):
            clips[key] = {**previous[key], "loop": loop}
            print(f"clip {key}: reused")
            continue
        if (name, fps) not in encoded:
            window_crop = clip_crop(sources[name][1])
            encoded[(name, fps)] = encode_webp(ffmpeg, args.source / name, window_crop, pet_root / f"_src_{len(encoded)}", fps)
        frames = encoded[(name, fps)]
        start = int(round((window[0] if window else 0.0) * fps))
        end = int(round((window[1] if window else (len(frames) / fps)) * fps))
        end = min(end, len(frames))
        clip_dir = pet_root / key
        if clip_dir.exists():
            shutil.rmtree(clip_dir)
        clip_dir.mkdir(parents=True)
        clip_frames = []
        for index, frame in enumerate(frames[start:end], start=1):
            target = clip_dir / f"{key}_{index:03d}.webp"
            # Several clips may slice one source sequence; copy so later
            # slices still see the full range.
            shutil.copyfile(str(frame), str(target))
            clip_frames.append(f"{key}/{target.name}")
        clips[key] = {
            "frames": clip_frames, "frameMs": round(1000 / fps), "loop": loop,
            "frameWidth": clip_crop(sources[name][1])[2],
            "source": {
                "file": name,
                "sha256": hashes[name],
                "startFrame": start, "endFrame": end,
                "frameCount": len(frames),
            },
        }
        total_kb = sum(p.stat().st_size for p in clip_dir.glob("*.webp")) // 1024
        print(f"clip {key}: {len(clip_frames)} frames @ {fps} fps, {total_kb} KB")
    for directory in pet_root.glob("_src_*"):
        shutil.rmtree(directory)

    manifest = {
        "formatVersion": 1,
        "characterId": "whaletail-maid",
        "baseSize": crop[2],
        # Widest clip; the helpers size their window so it is never clipped.
        "maxClipWidth": max(clip.get("frameWidth", crop[2]) for clip in clips.values()),
        "maxFrameWidth": crop[2],
        "maxFrameHeight": crop[3],
        "assetSource": {
            "repository": "https://github.com/PC2005-cloud/dsh-pet",
            "commit": args.source_commit,
            "directory": "dsh-pet/assets/webm",
            "fps": FPS, "crop": list(crop), "webpQuality": QUALITY,
        },
        "clips": clips,
        "stateMap": STATE_MAP,
        "workingActivityMap": WORKING_ACTIVITY_MAP,
        "idleMicroClips": IDLE_MICRO_CLIPS,
        "interactionVariants": INTERACTION_VARIANTS,
        "sayClips": SAY_CLIPS,
        "loopVariants": LOOP_VARIANTS,
        "actionMenu": ACTION_MENU,
        "idleMicroIntervalsMs": IDLE_MICRO_INTERVALS_MS,
        "interactionCooldownMs": 1200,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    total_mb = sum(p.stat().st_size for p in pet_root.rglob("*.webp")) // (1024 * 1024)
    print(f"manifest written; total asset size: {total_mb} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
