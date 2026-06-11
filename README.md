# video-board

把任意「视频 + 字幕」变成可逐段循环精读的双语分镜工具。
纯静态、零依赖,全部在浏览器本机处理 —— 视频不上传;字幕缺失的层会优雅降级。

**在线体验:** https://xhxiaiein.github.io/video-board/

## 使用

落地页:拖入视频与字幕,或「选择文件 / 文件夹」。也可点「加载示例」
看内置双语短片《一颗种子的攀爬》(~40 KB,随仓库分发)。

支持视频 `mp4 / webm / mkv / mov`,字幕 `vtt / srt`(单轨或中英双轨)。
只给单语字幕也行 —— 没有译文时自动收起所有「译文」UI,只显示原文。

快捷键:`空格` 播放/暂停 · `←/→` 上一段/下一段 · `L` 循环当前段 ·
`1/2/3` 切换视图 · `B` 收起章节面板 · `V` 收起底部面板

## 在线拉取(需本地运行,Pages 上不可用)

落地页还有「粘贴 YouTube 链接 → 拉取」一栏:由 `serve.py` 在本机调
`yt-dlp` 下载视频与 en/zh 字幕,再喂进同一条导入流程。**这条全程在本机,
视频不经过任何第三方。**

⚠️ 这个功能依赖本机后端,**GitHub Pages 是纯静态托管,无法运行它** ——
线上那个「拉取」按钮在 Pages 上点了只会报「连不上本地服务」。
**想用在线拉取,请把项目下载到本地运行:**

```
pip install -U yt-dlp          # 还需 ffmpeg 在 PATH 中
python serve.py                # 然后打开 http://localhost:8000/
```

纯本地导入(拖文件 / 加载示例)不需要后端;`serve.py` 仅在你要在线拉取、
或需要 `<video>` 精确 seek 的 HTTP Range 支持时才有必要。

## 工作方式

导入只能拿到字幕,所以 `import.js` 在浏览器里从字幕**合成三层模型**:

| 层 | 来源 | 用途 |
|---|---|---|
| L1 重要时刻 | 按固定时窗切章 | 粗剪导航 |
| L2 字幕轴 | 原文字幕时间轴 | 精确时间锚点 |
| L3 语义段 | 每条 cue 一段,匹配译文 | 双语逐段循环 |

最像中文的字幕轨自动判为译文(`cjkRatio`),另一轨为原文。数据有无决定 UI:
`applyComponentVisibility()`(`app.js`)在无 heatmap、单章、L2≡L3、无译文等
情况下收起对应面板(`no-heatmap` / `no-chapters` / `same-l2l3` / `no-zh`)。

视频经 `blob:` URL(本地导入)或同源带 Range 的 `/downloads` URL(在线拉取)
加载,seek/play 若在 metadata 就绪前发起,会暂存于 `pendingTime`/`pendingPlay`,
由 `setVideoSrc` 的 `loadedmetadata` 重放。

## 文件

```
index.html   结构
style.css    布局(三层卡片 + 时间轴 + 双轨字幕 + 落地页)
app.js       播放同步、滚动跟随、视图切换、键位
import.js    字幕解析(VTT/SRT)+ 三层模型合成 + 拖拽/文件夹导入
yt.js        在线拉取前端:调 serve.py /fetch,复用导入流程(需本地后端)
serve.py     本地静态服务器(带 Range) + /fetch YouTube 拉取端点(yt-dlp)
example/     内置双语示例
```
