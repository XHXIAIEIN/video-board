/* Online import: fetch a YouTube video + subtitles through the local serve.py
 * backend, then feed them into the SAME pipeline a local import uses. The browser
 * can't pull YouTube directly (no direct links, CORS), so /fetch shells out to
 * yt-dlp on this machine; nothing goes to a third party beyond YouTube itself.
 *
 * Reuses globals from app.js / import.js: parseSubs, buildProject, setVideoSrc,
 * loadProject. The served mp4 supports HTTP Range, so we point <video> straight
 * at its URL (no full-file blob in memory) and seeking works. */
'use strict';

(function wireYouTube() {
	const input = document.getElementById('yt-url');
	const go = document.getElementById('yt-go');
	const status = document.getElementById('yt-status');
	const row = document.getElementById('yt-row');
	if (!input || !go) return;

	// Clicking inside the row must not bubble to #drop (which opens the file picker).
	row.addEventListener('click', e => e.stopPropagation());

	const setBusy = on => {
		go.disabled = on;
		input.disabled = on;
		go.textContent = on ? '拉取中…' : '拉取在线视频';
	};

	// 把 yt-dlp / 网络的原始英文报错翻成人话 + 下一步怎么办
	function friendlyError(raw) {
		const s = String(raw || '');
		const has = re => re.test(s);
		if (has(/429|Too Many Requests/i)) return 'YouTube 暂时限制了请求频率。等待5分钟再试，多数情况会自动恢复。';
		if (has(/Failed to fetch|NetworkError|ERR_CONNECTION|Load failed/i)) return '无法连接本地服务。请确认启动它的那个命令行窗口（运行 python serve.py 的黑色窗口）还开着、没有关闭，再重试。';
		if (has(/Private video/i)) return '这是私有视频，无法下载。';
		if (has(/members-only|join this channel/i)) return '会员专属视频，无法下载。';
		if (has(/Sign in to confirm your age|age.?restricted/i)) return '该视频有年龄限制，需登录后才能下载。';
		if (has(/Video unavailable|not available|removed by the uploader/i)) return '视频不可用（可能已删除、设为私有，或有地区限制）。';
		if (has(/not a bot|cookies/i)) return 'YouTube 要求验证身份。可给 yt-dlp 配置浏览器 cookies 后重试。';
		if (has(/Unsupported URL|is not a valid URL|Unable to extract/i)) return '链接无法识别。请确认粘贴的是有效的 YouTube 视频链接。';
		if (has(/Requested format is not available/i)) return '没有可下载的视频格式（可能是直播或受限内容）。';
		if (has(/ffmpeg/i)) return '缺少 ffmpeg，无法合并音视频。请先安装 ffmpeg 并加入 PATH。';
		if (has(/yt-dlp.*not found|未找到 yt-dlp|No such file/i)) return '本机未安装 yt-dlp。安装：pip install -U yt-dlp。';
		if (has(/没有可用的|字幕/)) return s; // 后端已是中文的字幕类错误，原样透出
		return '拉取失败，请重试。若反复失败，原始信息：' + s.slice(0, 160);
	}

	async function run() {
		let url = input.value.trim();
		if (!url) return;
		// 省略协议头时自动补 https（youtube.com/... 或 //youtu.be/...）
		if (!/^[a-z][\w+.-]*:\/\//i.test(url)) {
			url = 'https://' + url.replace(/^\/+/, '');
		}
		status.className = 'note';
		status.textContent = '正在用 yt-dlp 下载视频与字幕…首次可能需要 10–60 秒';
		setBusy(true);
		try {
			const res = await fetch('/fetch?url=' + encodeURIComponent(url));
			const info = await res.json();
			if (info.error) throw new Error(info.error);

			// explicit lang codes from the backend → pick en / zh tracks
			const enSub = info.subs.find(s => /^en/i.test(s.lang));
			const zhSub = info.subs.find(s => /^zh/i.test(s.lang));
			const [enText, zhText] = await Promise.all([enSub ? fetch(enSub.path).then(r => r.text()) : Promise.resolve(''), zhSub ? fetch(zhSub.path).then(r => r.text()) : Promise.resolve('')]);

			let enCues = parseSubs(enText); // import.js global
			let zhCues = parseSubs(zhText);
			// zh-only video: promote it to the primary (原文) track
			if (!enCues.length && zhCues.length) {
				enCues = zhCues;
				zhCues = [];
			}
			if (!enCues.length) {
				throw new Error('该视频没有可用的 en/zh 字幕（连自动字幕也没有）');
			}

			const lastEnd = enCues[enCues.length - 1].end;
			const mt = !!(zhSub && zhSub.mt); // 译文是 Google 机翻补的
			let uploader = info.uploader ? 'YouTube · ' + info.uploader : 'YouTube';
			if (mt) uploader += ' · 译文机翻';
			const data = buildProject({
				title: info.title,
				uploader,
				duration: info.duration > 0 ? info.duration : lastEnd + 5,
				width: info.width,
				height: info.height,
				enCues,
				zhCues,
			});

			setVideoSrc(info.video); // app.js — served same-origin with Range support
			loadProject(data); // app.js — reveals the storyboard
			status.textContent = '';
		} catch (ex) {
			status.className = 'note err';
			status.textContent = friendlyError(ex && ex.message ? ex.message : ex);
		} finally {
			setBusy(false);
		}
	}

	go.addEventListener('click', run);
	input.addEventListener('keydown', e => {
		if (e.key === 'Enter') run();
	});
})();
