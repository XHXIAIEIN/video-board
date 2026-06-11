/* Local import: build a project (video + subtitles) entirely in the browser.
 *
 * The demo ships a full pre-processed model (L1 chapters / L2 cues / L3 bilingual
 * segments + heatmap + frames). An imported video only gives us subtitle cues, so
 * we synthesize the three layers from them and degrade gracefully: no heatmap, no
 * frame thumbnails. Everything stays on-device — nothing is uploaded. */
'use strict';

// ---------- subtitle parsing (VTT + SRT, one unified pass) ----------

// "HH:MM:SS.mmm" / "MM:SS.mmm" / SRT comma form → seconds
function parseTime(s) {
	const parts = s.trim().replace(',', '.').split(':').map(Number);
	if (parts.some(Number.isNaN)) return NaN;
	return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// Returns sorted cues: [{ start, end, text }]
function parseSubs(text) {
	text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
	const cues = [];
	for (const block of text.split(/\n\s*\n/)) {
		const lines = block.split('\n').filter(l => l.trim() !== '');
		const ti = lines.findIndex(l => l.includes('-->'));
		if (ti === -1) continue;
		const m = lines[ti].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
		if (!m) continue;
		const start = parseTime(m[1]),
			end = parseTime(m[2]);
		if (!isFinite(start) || !isFinite(end)) continue;
		const txt = lines
			.slice(ti + 1)
			.join(' ')
			.replace(/<[^>]+>/g, '') // strip VTT inline tags (<c>, <00:00:01.000>, …)
			.replace(/\{[^}]+\}/g, '') // strip ASS-style override blocks if any leak in
			.trim();
		if (txt) cues.push({ start, end, text: txt });
	}
	cues.sort((a, b) => a.start - b.start);
	return cues;
}

// ---------- model synthesis ----------

const CHAP_SECS = 120; // synthesized chapter length when source has no chapters

// Build the same shape app.js consumes from raw cues + video dimensions.
function buildProject({ title, uploader, duration, width, height, enCues, zhCues }) {
	// L1 — fixed time-window chapters (source has no real chapter marks)
	const nChap = Math.max(1, Math.ceil(duration / CHAP_SECS));
	const chapId = t => 'ch' + Math.min(nChap, Math.floor(t / CHAP_SECS) + 1);
	const chapters = [];
	for (let k = 0; k < nChap; k++) {
		chapters.push({
			id: 'ch' + (k + 1),
			index: k + 1,
			start: k * CHAP_SECS,
			end: Math.min((k + 1) * CHAP_SECS, duration),
			title: '',
		});
	}

	// zh text overlapping an en cue (by midpoint, then by any overlap)
	const zhFor = (s, e) => {
		const mid = (s + e) / 2;
		const z = zhCues.find(z => mid >= z.start && mid < z.end) || zhCues.find(z => z.end > s && z.start < e);
		return z ? z.text : '';
	};

	// L2 — the imported 原文 track is the time axis
	const cues = enCues.map((c, i) => ({
		id: 'u' + String(i + 1).padStart(3, '0'),
		chapter: chapId(c.start),
		start: c.start,
		end: c.end,
		text: c.text,
	}));

	// L3 — one bilingual segment per cue (no semantic merge without a pipeline)
	const segments = enCues.map((c, i) => {
		const zh = zhFor(c.start, c.end);
		return {
			id: 's' + String(i + 1).padStart(3, '0'),
			index: i + 1,
			chapter: chapId(c.start),
			start: c.start,
			end: c.end,
			cueRange: [cues[i].id, cues[i].id],
			cueCount: 1,
			en: c.text,
			zh,
			enPages: [{ t0: c.start, t1: c.end, text: c.text }],
			zhPages: [{ t0: c.start, t1: c.end, text: zh }],
		};
	});

	// chapter titles = first cue snippet inside each window
	for (const ch of chapters) {
		const first = cues.find(c => c.chapter === ch.id);
		ch.title = first ? first.text.slice(0, 48) : '—';
	}

	const meta = {
		id: 'local',
		title,
		uploader: uploader || '',
		upload_date: '',
		duration,
		width: width || 0,
		height: height || 0,
		heatmap: [],
	};

	return { meta, chapters, cues, segments };
}

// ---------- video probe ----------

// Read duration/dimensions without committing the file to the player yet.
function probeVideo(file) {
	return new Promise((resolve, reject) => {
		const v = document.createElement('video');
		v.preload = 'metadata';
		const url = URL.createObjectURL(file);
		v.onloadedmetadata = () => {
			resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
			URL.revokeObjectURL(url);
		};
		v.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error('无法读取视频元数据'));
		};
		v.src = url;
	});
}

// ---------- file classification ----------

const VIDEO_RE = /\.(mp4|webm|mkv|mov|m4v|ogv|avi)$/i;
const SUB_RE = /\.(vtt|srt|ass|ssa)$/i;

// Pull the video + subtitle files out of an arbitrary dropped/picked set.
function classify(files) {
	const video = files.find(f => (f.type && f.type.startsWith('video/')) || VIDEO_RE.test(f.name));
	const subs = files.filter(f => SUB_RE.test(f.name));
	return { video, subs };
}

// Fraction of CJK characters — used to tell the 译文 (Chinese) track apart.
function cjkRatio(s) {
	const cjk = (s.match(/[㐀-鿿]/g) || []).length;
	const total = (s.match(/\S/g) || []).length;
	return total ? cjk / total : 0;
}

// Given the subtitle files (already read to text), pick which is 原文 vs 译文.
// The most-Chinese one becomes 译文; the other (or a lone sub) becomes 原文.
function splitTracks(subTexts) {
	const ranked = subTexts.map(t => ({ ...t, r: cjkRatio(t.text) })).sort((a, b) => a.r - b.r); // least Chinese first
	if (ranked.length === 1) return { en: ranked[0], zh: null };
	const zh = ranked[ranked.length - 1];
	const en = ranked[0];
	// if the "zh" candidate isn't actually Chinese, treat both as same-language: no zh
	return zh.r > 0.15 ? { en, zh } : { en, zh: null };
}

// ---------- drag & drop / folder traversal ----------

// Collect File objects from a drop, recursing into any dropped folders.
async function filesFromDrop(dt) {
	const items = dt.items ? [...dt.items] : [];
	const entries = items.map(it => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
	if (!entries.length) return [...dt.files];
	const out = [];
	await Promise.all(entries.map(e => walkEntry(e, out)));
	return out.length ? out : [...dt.files];
}

function walkEntry(entry, out) {
	return new Promise(resolve => {
		if (entry.isFile) {
			entry.file(
				f => {
					out.push(f);
					resolve();
				},
				() => resolve()
			);
		} else if (entry.isDirectory) {
			const reader = entry.createReader();
			const collected = [];
			const readBatch = () =>
				reader.readEntries(
					batch => {
						if (!batch.length) {
							Promise.all(collected.map(e => walkEntry(e, out))).then(resolve);
						} else {
							collected.push(...batch);
							readBatch(); // readEntries returns in chunks; keep going until empty
						}
					},
					() => resolve()
				);
			readBatch();
		} else {
			resolve();
		}
	});
}

// ---------- orchestration ----------

(function wireLanding() {
	const drop = document.getElementById('drop');
	const err = document.getElementById('landing-err');
	const filesInput = document.getElementById('files-input');
	const folderInput = document.getElementById('folder-input');

	const fail = msg => {
		err.textContent = msg;
		drop.classList.remove('busy');
	};

	async function ingest(files) {
		err.textContent = '';
		const { video, subs } = classify(files);
		if (!video) return fail('没找到视频文件（支持 mp4 / webm / mkv / mov）');
		if (!subs.length) return fail('没找到字幕文件（支持 vtt / srt）');

		drop.classList.add('busy');
		try {
			const subTexts = await Promise.all(subs.map(async f => ({ name: f.name, text: await f.text() })));
			const { en, zh } = splitTracks(subTexts);
			const enCues = parseSubs(en.text);
			if (!enCues.length) throw new Error('字幕解析为空，请确认是 VTT / SRT 格式');
			const zhCues = zh ? parseSubs(zh.text) : [];

			const probe = await probeVideo(video);
			const lastEnd = enCues[enCues.length - 1].end;
			const duration = isFinite(probe.duration) && probe.duration > 0 ? probe.duration : lastEnd + 5;

			const data = buildProject({
				title: video.name.replace(/\.[^.]+$/, ''),
				uploader: zh ? '本地导入 · 双语' : '本地导入',
				duration,
				width: probe.width,
				height: probe.height,
				enCues,
				zhCues,
			});
			loadImported(data, video); // app.js — reveals the storyboard
		} catch (ex) {
			fail('导入失败：' + (ex && ex.message ? ex.message : ex));
		} finally {
			drop.classList.remove('busy');
		}
	}

	// drag & drop
	['dragenter', 'dragover'].forEach(ev =>
		drop.addEventListener(ev, e => {
			e.preventDefault();
			drop.classList.add('dragover');
		})
	);
	['dragleave', 'dragend'].forEach(ev =>
		drop.addEventListener(ev, e => {
			e.preventDefault();
			drop.classList.remove('dragover');
		})
	);
	drop.addEventListener('drop', async e => {
		e.preventDefault();
		drop.classList.remove('dragover');
		const files = await filesFromDrop(e.dataTransfer);
		ingest(files);
	});
	// clicking the drop zone opens the file picker (but not when clicking a button)
	drop.addEventListener('click', e => {
		if (e.target.closest('button')) return;
		filesInput.click();
	});

	// pickers
	document.getElementById('pick-files').addEventListener('click', () => filesInput.click());
	document.getElementById('pick-folder').addEventListener('click', () => folderInput.click());
	filesInput.addEventListener('change', () => filesInput.files.length && ingest([...filesInput.files]));
	folderInput.addEventListener('change', () => folderInput.files.length && ingest([...folderInput.files]));

	// demo + reopen + close
	document.getElementById('load-demo').addEventListener('click', async () => {
		err.textContent = '';
		drop.classList.add('busy');
		try {
			await loadDemo(); // app.js
		} catch (ex) {
			fail('无法打开示例。这个页面不能用「直接双击网页文件」的方式打开，要先把本地服务跑起来：在程序所在文件夹里运行 python serve.py，再用浏览器访问它提示的网址（通常是 http://localhost:8000）。');
		} finally {
			drop.classList.remove('busy');
		}
	});
	document.getElementById('btn-import').addEventListener('click', () => showLanding()); // app.js
	document.getElementById('landing-close').addEventListener('click', () => showApp()); // app.js
})();
