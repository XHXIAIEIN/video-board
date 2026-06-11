#!/usr/bin/env python3
"""分镜故事板本地服务器 + YouTube 拉取端点。

静态目录是项目根；额外提供 GET /fetch?url=<youtube>，用 yt-dlp 把在线视频和
en/zh 字幕拉到 downloads/，返回元数据 JSON 供浏览器端复用现有导入流程。
所有处理都在本机，视频不经过第三方。

用法:  python serve.py [端口]      然后打开 http://localhost:8000/
依赖:  yt-dlp、ffmpeg（已在 PATH）
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DL = os.path.join(ROOT, "downloads")
os.makedirs(DL, exist_ok=True)


# ---------- 极简 VTT 解析 / 生成（仅供机翻译文轨复用时间轴）----------

def parse_vtt(text):
    """→ [(start, end, text)]，丢弃样式标签。"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    cues = []
    for block in re.split(r"\n\s*\n", text):
        lines = [l for l in block.split("\n") if l.strip()]
        ti = next((i for i, l in enumerate(lines) if "-->" in l), -1)
        if ti < 0:
            continue
        m = re.search(r"([\d:.]+)\s*-->\s*([\d:.]+)", lines[ti])
        if not m:
            continue
        txt = " ".join(lines[ti + 1:])
        txt = re.sub(r"<[^>]+>", "", txt).strip()
        if txt:
            cues.append((m.group(1), m.group(2), txt))
    return cues


def emit_vtt(cues):
    out = ["WEBVTT", ""]
    for start, end, txt in cues:
        out.append("%s --> %s" % (start, end))
        out.append(txt)
        out.append("")
    return "\n".join(out)


# ---------- Google 免费翻译（非官方 gtx 端点，服务端调用避开 CORS）----------

def _gtx_call(text, tl="zh-CN", sl="en"):
    params = urllib.parse.urlencode(
        {"client": "gtx", "sl": sl, "tl": tl, "dt": "t", "q": text}
    )
    url = "https://translate.googleapis.com/translate_a/single?" + params
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read().decode("utf-8"))
    # data[0] 是 [[译文片段, 原文片段, ...], ...]，拼回后按换行复原行
    return "".join(seg[0] for seg in data[0] if seg and seg[0])


def gtx_translate(lines, tl="zh-CN", sl="en"):
    """批量翻译；按换行分批送，行数对不齐时该批退化为逐行翻译。失败抛异常。"""
    out = []
    batch, blen = [], 0
    batches = []
    for ln in lines:
        if blen + len(ln) > 1500 and batch:
            batches.append(batch)
            batch, blen = [], 0
        batch.append(ln)
        blen += len(ln) + 1
    if batch:
        batches.append(batch)

    for batch in batches:
        translated = _gtx_call("\n".join(batch), tl, sl)
        parts = translated.split("\n")
        if len(parts) == len(batch):
            out.extend(p.strip() for p in parts)
        else:
            # 换行没对齐 → 逐行翻译保证一一对应
            for ln in batch:
                try:
                    out.append(_gtx_call(ln, tl, sl).strip())
                except Exception:
                    out.append("")
                time.sleep(0.2)
        time.sleep(0.3)
    return out


def synth_zh_subtitle(vid, en_path):
    """en 字幕机翻成中文，写出 <id>.zh-MT.vtt。成功返回 sub 字典，失败返回 None。"""
    try:
        with open(en_path, encoding="utf-8") as f:
            cues = parse_vtt(f.read())
        if not cues:
            return None
        zh = gtx_translate([c[2] for c in cues])
        if not any(z for z in zh):
            return None
        zh_cues = [(cues[i][0], cues[i][1], zh[i] or cues[i][2]) for i in range(len(cues))]
        fn = "%s.zh-MT.vtt" % vid
        with open(os.path.join(DL, fn), "w", encoding="utf-8") as f:
            f.write(emit_vtt(zh_cues))
        return {"lang": "zh-MT", "path": "downloads/" + fn, "mt": True}
    except Exception as e:
        print("[translate] 机翻失败: %s" % e)
        return None


def fetch_youtube(url):
    """下载视频 + 字幕，返回 {id,title,uploader,duration,width,height,video,subs}。"""
    out = os.path.join(DL, "%(id)s.%(ext)s")
    cmd = [
        "yt-dlp",
        # 优先 mp4，浏览器 <video> 直接能放；退而求其次再合并任意轨道为 mp4
        "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "--merge-output-format", "mp4",
        "--write-subs", "--write-auto-subs",   # 人工字幕优先，没有则取自动生成
        # 精确列表，避免拉到 en-de 这类自动翻译轨（请求翻倍 → 更易触发 429）
        "--sub-langs", "en,en-US,en-GB,en-orig,zh,zh-Hans,zh-Hant,zh-CN,zh-TW,zh-orig",
        "--convert-subs", "vtt",
        "--no-playlist",
        # YouTube 对字幕请求限流较严，放慢节奏并重试以躲开 429
        "--sleep-requests", "1",
        "--retries", "5",
        "--retry-sleep", "5",
        # 字幕某语种被限流（429）不应中断整体：先保住视频，字幕能拿多少是多少
        "--ignore-errors",
        "--print-json", "--no-simulate",
        "-o", out, url,
    ]
    proc = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )

    # --print-json 在下载后打印一行 info dict（取最后一个 JSON 对象）
    info = None
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            info = json.loads(line)

    # 只要拿到 info 且视频已落地就算成功（字幕 429 等可降级）；否则才按失败抛错
    if info is None:
        tail = proc.stderr.strip().splitlines()
        raise RuntimeError(tail[-1] if tail else "yt-dlp 执行失败")

    vid = info["id"]
    subs = []
    for fn in sorted(os.listdir(DL)):
        m = re.match(re.escape(vid) + r"\.([\w-]+)\.vtt$", fn)
        if m:
            subs.append({"lang": m.group(1), "path": "downloads/" + fn})

    # 没有中文字幕但有英文 → 用 Google 免费接口机翻一条译文轨（失败则保持无译文）
    has_zh = any(re.match(r"zh", s["lang"], re.I) for s in subs)
    en = next((s for s in subs if re.match(r"en", s["lang"], re.I)), None)
    if not has_zh and en:
        print("[translate] 无中文字幕，尝试机翻 en → zh …")
        mt = synth_zh_subtitle(vid, os.path.join(ROOT, en["path"]))
        if mt:
            subs.append(mt)
            print("[translate] 机翻译文已生成")

    return {
        "id": vid,
        "title": info.get("title") or vid,
        "uploader": info.get("uploader") or info.get("channel") or "",
        "duration": info.get("duration") or 0,
        "width": info.get("width") or 0,
        "height": info.get("height") or 0,
        "video": "downloads/%s.mp4" % vid,
        "subs": subs,
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, fmt, *args):  # 安静些，只在出错时手动打印
        pass

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/fetch":
            return self._fetch(parsed)
        # 其余静态文件走带 Range 的处理，保证视频可 seek
        path = self.translate_path(self.path)
        if os.path.isfile(path):
            return self._serve_file(path)
        return super().do_GET()

    def _fetch(self, parsed):
        qs = urllib.parse.parse_qs(parsed.query)
        url = (qs.get("url") or [""])[0].strip()
        if not url:
            return self._json({"error": "缺少 url 参数"}, 400)
        # 用户常省略协议头（youtube.com/... 或 www.youtube.com/...），自动补 https
        if not re.match(r"[a-zA-Z][\w+.-]*://", url):
            url = "https://" + url.lstrip("/")
        print("[fetch] %s" % url)
        try:
            data = fetch_youtube(url)
            print("[fetch] ok → %s（字幕 %d 条）" % (data["title"], len(data["subs"])))
            return self._json(data)
        except Exception as e:
            print("[fetch] 失败: %s" % e)
            return self._json({"error": str(e)}, 500)

    def _serve_file(self, path):
        """带 HTTP Range 支持的文件响应（视频 seek 必需）。"""
        try:
            f = open(path, "rb")
        except OSError:
            return self.send_error(404)
        try:
            size = os.fstat(f.fileno()).st_size
            ctype = self.guess_type(path)
            rng = self.headers.get("Range")
            if rng:
                m = re.match(r"bytes=(\d*)-(\d*)", rng)
                start = int(m.group(1)) if m and m.group(1) else 0
                end = int(m.group(2)) if m and m.group(2) else size - 1
                end = min(end, size - 1)
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % size)
                    self.end_headers()
                    return
                length = end - start + 1
                self.send_response(206)
                self.send_header("Content-Type", ctype)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
                self.send_header("Content-Length", str(length))
                self.end_headers()
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            else:
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(size))
                self.end_headers()
                self.copyfile(f, self.wfile)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 浏览器中断流（seek/关闭）属正常
        finally:
            f.close()

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print("分镜故事板 → http://localhost:%d/" % port)
    print("YouTube 拉取就绪（yt-dlp + ffmpeg）。Ctrl+C 退出。")
    try:
        ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\n已退出。")
