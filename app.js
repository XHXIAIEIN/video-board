/* Storyboard editor logic. Three segment layers, one constant layout. */
"use strict";

const $ = (s) => document.querySelector(s);
const video = $("#video");

const state = {
  layer: 3,        // 1 | 2 | 3
  unitIndex: -1,   // index into current layer's units
  loop: false,
  loopIndex: -1,   // unit the loop is locked to (re-anchored on deliberate seeks)
  sidePanel: "chapters",  // left panel: "chapters" | "transcript"
  sideText: "both",       // transcript language: "en" | "zh" | "both"
  data: null,
  // caption tracks per view: which rows render in the overlay below the video
  caps: { 2: { en: true, zh: false }, 3: { en: true, zh: true } },
};

// ---------- helpers ----------
const fmt = (t) => {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

function unitsFor(layer) {
  const { chapters, cues, segments } = state.data;
  return layer === 1 ? chapters : layer === 2 ? cues : segments;
}

// Chinese page at time t, drawn from the L3 segment covering it.
// Lets the L2 (cue) view borrow synced translation, since cues carry no zh.
function zhPageAt(t) {
  const segs = state.data.segments;
  const s = segs.find((x) => t >= x.start && t < x.end);
  if (!s || !s.zhPages.length) return "";
  const p = s.zhPages.find((p) => t >= p.t0 && t < p.t1) || s.zhPages[s.zhPages.length - 1];
  return p ? p.text : "";
}

// ---------- static rendering ----------
function renderSidebar() {
  const el = $("#chapter-list");
  el.innerHTML = "";
  for (const ch of state.data.chapters) {
    const d = document.createElement("div");
    d.className = "chapter-item";
    d.dataset.id = ch.id;
    d.innerHTML =
      `<span class="num">${ch.index}</span>` +
      `<span class="name"><span class="en">${ch.title}</span></span>` +
      `<span class="time">${fmt(ch.start)}</span>`;
    d.onclick = () => { sideScroll.following = true; seekTo(ch.start); };
    el.appendChild(d);
  }
}

// transcript view of the left panel: L3 segments as a clickable bilingual script,
// with the language (原文/译文/双语) driven by state.sideText
function renderTranscript() {
  const el = $("#transcript-list");
  el.innerHTML = "";
  for (const s of state.data.segments) {
    const d = document.createElement("div");
    d.className = "tx-line";
    d.dataset.id = s.id;
    let html = `<span class="time">${fmt(s.start)}</span><span class="tx-text">`;
    if (state.sideText !== "zh") html += `<span class="en">${s.en}</span>`;
    if (state.sideText !== "en") html += `<span class="zh">${s.zh}</span>`;
    html += `</span>`;
    d.innerHTML = html;
    d.onclick = () => { sideScroll.following = true; seekTo(s.start); playVideo(); };
    el.appendChild(d);
  }
}

function setSidePanel(panel) {
  state.sidePanel = panel;
  document.querySelectorAll("#side-switch button").forEach((b) =>
    b.classList.toggle("active", b.dataset.panel === panel));
  const tx = panel === "transcript";
  $("#side-text").hidden = !tx;
  $("#chapter-list").hidden = tx;
  $("#transcript-list").hidden = !tx;
  if (tx) { renderTranscript(); curTxId = null; }
  sideRelocateInstant();
}

function setSideText(text) {
  state.sideText = text;
  document.querySelectorAll("#side-text button").forEach((b) =>
    b.classList.toggle("active", b.dataset.text === text));
  renderTranscript();
  curTxId = null;
  sideRelocateInstant();
}

function renderHeatmap() {
  const hm = state.data.meta.heatmap;
  if (!hm.length) return;
  const svg = $("#heatmap");
  const W = 1000, H = 30;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const dur = state.data.meta.duration;
  const pts = hm.map((p) =>
    `${(((p.start_time + p.end_time) / 2) / dur * W).toFixed(1)},${(H - p.value * (H - 2)).toFixed(1)}`);
  svg.innerHTML =
    `<polygon points="0,${H} ${pts.join(" ")} ${W},${H}"></polygon>` +
    `<polyline points="${pts.join(" ")}"></polyline>`;
}

function renderChapterBand() {
  const band = $("#chapter-band");
  band.innerHTML = "";
  const dur = state.data.meta.duration;
  for (const ch of state.data.chapters) {
    const b = document.createElement("div");
    b.className = "block";
    b.dataset.id = ch.id;
    b.style.left = `${(ch.start / dur) * 100}%`;
    b.style.width = `${((ch.end - ch.start) / dur) * 100 - 0.15}%`;
    b.title = `${ch.index}. ${ch.title}`;
    b.onclick = (e) => { e.stopPropagation(); seekTo(ch.start); };
    band.appendChild(b);
  }
}

function renderUnitBand() {
  const band = $("#unit-band");
  band.innerHTML = "";
  const dur = state.data.meta.duration;
  for (const u of unitsFor(state.layer)) {
    const b = document.createElement("div");
    b.className = "block";
    b.dataset.id = u.id;
    b.style.left = `${(u.start / dur) * 100}%`;
    b.style.width = `${Math.max(((u.end - u.start) / dur) * 100 - 0.08, 0.05)}%`;
    band.appendChild(b);
  }
}

function renderFilmstrip() {
  const strip = $("#filmstrip");
  strip.innerHTML = "";
  const layer = state.layer;
  const units = unitsFor(layer);
  for (const u of units) {
    const card = document.createElement("div");
    // L2 bilingual (原文+译文 both on) gets a taller card so neither line clips
    const cueBi = layer === 2 && state.caps[2].en && state.caps[2].zh;
    card.className = layer === 2 ? (cueBi ? "card cue cue-bi" : "card cue")
                   : layer === 1 ? "card l1" : "card l3";
    card.dataset.id = u.id;
    let html = "";
    html += `<div class="meta"><span class="tc">${fmt(u.start)}</span>` +
            `<span class="idx">${u.id}</span></div>`;
    if (layer === 1) {
      html += `<div class="text"><span class="en">${u.title}</span></div>`;
    } else if (layer === 2) {
      // English cue + optional synced zh borrowed from the L3 page track; both toggleable
      html += `<div class="text">`;
      if (state.caps[2].en) html += `<span class="en">${u.text}</span>`;
      if (state.caps[2].zh) {
        const z = zhPageAt((u.start + u.end) / 2);
        if (z) html += `<span class="zh">${z}</span>`;
      }
      html += `</div>`;
    } else {
      html += `<div class="text">`;
      if (state.caps[3].en) html += `<span class="en">${u.en}</span>`;
      if (state.caps[3].zh) html += `<span class="zh">${u.zh}</span>`;
      html += `</div>`;
    }
    html += `<div class="prog"></div>`;
    card.innerHTML = html;
    card.onclick = () => {
      scroll.following = true; setArrow(null);
      seekTo(u.start); playVideo();
    };
    strip.appendChild(card);
  }
}

const LAYER_META = {
  1: "粗剪导航 · 浏览结构",
  2: "精确时间锚点 · 校对原文",
  3: "双语精读 · 逐段循环",
};

// reflect caption-track pills for the active view (L1 has no captions to toggle)
function updateCapToggles(layer) {
  const en = $("#tog-en"), zh = $("#tog-zh");
  const c = state.caps[layer];
  const hide = layer === 1;         // 重要时刻 (L1) has no captions to toggle
  $("#cap-toggles").hidden = hide;  // hide the whole group + its label together
  $("#cap-label").hidden = hide;
  en.hidden = hide;
  zh.hidden = hide;
  if (c) {
    en.classList.toggle("on", !!c.en);
    zh.classList.toggle("on", !!c.zh);
  }
}

// ---------- filmstrip scroll control ----------
// following  : auto-scroll tracks the playhead (paused once the user scrolls away)
// dragging   : a pointer drag is in progress
// suppressAuto: transient gate so manual placement (switch/toggle) doesn't fight tick
const scroll = { following: true, dragging: false, suppressAuto: false };

const strip = () => $("#filmstrip");
const cardUnit = () => {
  const c = strip().querySelector(".card");
  return c ? c.offsetWidth + 8 : 208;   // card width + flex gap
};
const clampScroll = (x) => {
  const s = strip();
  return Math.max(0, Math.min(x, s.scrollWidth - s.clientWidth));
};
const centerScroll = (card) =>            // scrollLeft that centers a card
  clampScroll(card.offsetLeft - (strip().clientWidth - card.offsetWidth) / 2);

// fixed-duration horizontal scroll (constant time regardless of distance, unlike
// the native smooth behavior which speeds up over longer jumps)
let animRaf = 0;
function stopAnim() { if (animRaf) { cancelAnimationFrame(animRaf); animRaf = 0; } }
function animateScrollTo(target, duration = 300) {
  const fs = strip();
  target = clampScroll(target);
  stopAnim();
  const start = fs.scrollLeft;
  const dist = target - start;
  if (Math.abs(dist) < 1) { fs.scrollLeft = target; return; }
  const t0 = performance.now();
  const ease = (p) => 1 - Math.pow(1 - p, 3);   // easeOutCubic
  const stepFn = (now) => {
    const p = Math.min(1, (now - t0) / duration);
    fs.scrollLeft = start + dist * ease(p);
    animRaf = p < 1 ? requestAnimationFrame(stepFn) : 0;
  };
  animRaf = requestAnimationFrame(stepFn);
}

function setArrow(dir) {                   // dir: "left" | "right" | null
  $("#reset-left").hidden = dir !== "left";
  $("#reset-right").hidden = dir !== "right";
}
// while paused, point an edge arrow at the off-screen current card (or hide once visible)
function updateArrows() {
  if (scroll.following || scroll.dragging) { setArrow(null); return; }
  const cur = strip().querySelector(".card.current");
  if (!cur) { setArrow(null); return; }
  const left = cur.offsetLeft - strip().scrollLeft;
  if (left + cur.offsetWidth < 24) setArrow("left");
  else if (left > strip().clientWidth - 24) setArrow("right");
  else setArrow(null);
}
function resumeFollow() {                   // snap back to the playing card, keep following
  scroll.following = true;
  setArrow(null);
  const cur = strip().querySelector(".card.current");
  if (cur) animateScrollTo(centerScroll(cur));
}
// called when a manual scroll/drag settles: within 2 cards → auto-reset, else offer arrow
function onScrollSettle() {
  const cur = strip().querySelector(".card.current");
  if (!cur) return;
  if (Math.abs(strip().scrollLeft - centerScroll(cur)) <= 2 * cardUnit()) {
    resumeFollow();
  } else {
    scroll.following = false;
    updateArrows();
  }
}

// ---------- sidebar (left panel) scroll control ----------
// Mirrors the filmstrip: auto-scroll follows the playhead's current chapter/line,
// pauses when the user scrolls away, auto-resumes when they settle back near it
// (else a snap-back button appears), and relocates instantly on a view switch.
// Alignment differs by panel: chapters center, transcript pins to the top.
const sideScroll = { following: true, suppressAuto: false, programmatic: false, settleTimer: null };
let lastSideScroll = 0;
const SIDE_TOP_PAD = 8;

const sideEl = () => $("#side-scroll");
const sideAlign = () => (state.sidePanel === "transcript" ? "top" : "center");
const sideCur = () => sideEl().querySelector(
  state.sidePanel === "transcript" ? ".tx-line.current" : ".chapter-item.current");
const clampSide = (x) => {
  const c = sideEl();
  return Math.max(0, Math.min(x, c.scrollHeight - c.clientHeight));
};
// scrollTop that places an item per the active alignment (top-pinned vs centered)
const sideTarget = (item) =>
  clampSide(sideAlign() === "top"
    ? item.offsetTop - SIDE_TOP_PAD
    : item.offsetTop - (sideEl().clientHeight - item.offsetHeight) / 2);

let sideRaf = 0;
function stopSideAnim() { if (sideRaf) { cancelAnimationFrame(sideRaf); sideRaf = 0; } }
function setSideScrollTop(top) {            // instant jump, flagged so the scroll listener ignores it
  const c = sideEl();
  sideScroll.programmatic = true;
  c.scrollTop = clampSide(top);
  requestAnimationFrame(() => { sideScroll.programmatic = false; });
}
function animateSideTo(target, duration = 300) {
  const c = sideEl();
  target = clampSide(target);
  stopSideAnim();
  const start = c.scrollTop, dist = target - start;
  if (Math.abs(dist) < 1) { setSideScrollTop(target); return; }
  const t0 = performance.now();
  const ease = (p) => 1 - Math.pow(1 - p, 3);   // easeOutCubic
  sideScroll.programmatic = true;
  const stepFn = (now) => {
    const p = Math.min(1, (now - t0) / duration);
    c.scrollTop = start + dist * ease(p);
    if (p < 1) sideRaf = requestAnimationFrame(stepFn);
    else { sideRaf = 0; requestAnimationFrame(() => { sideScroll.programmatic = false; }); }
  };
  sideRaf = requestAnimationFrame(stepFn);
}

// point the reset button at the off-screen current item (or hide once it's visible)
function updateSideReset() {
  const btn = $("#side-reset");
  if (sideScroll.following) { btn.hidden = true; return; }
  const cur = sideCur();
  if (!cur) { btn.hidden = true; return; }
  const cr = sideEl().getBoundingClientRect(), ir = cur.getBoundingClientRect();
  const above = ir.bottom < cr.top + 4, below = ir.top > cr.bottom - 4;
  btn.hidden = !(above || below);
  if (!btn.hidden) btn.textContent = (above ? "↑ " : "↓ ") + "回到播放位置";
}
function resumeSideFollow() {                // snap back to the current item, keep following
  sideScroll.following = true;
  const cur = sideCur();
  if (cur) animateSideTo(sideTarget(cur));
  updateSideReset();
}
// called when a manual scroll settles: within 2 items → auto-reset, else offer the button
function onSideSettle() {
  const cur = sideCur();
  if (!cur) { updateSideReset(); return; }
  const unit = cur.offsetHeight || 40;
  if (Math.abs(sideEl().scrollTop - sideTarget(cur)) <= 2 * unit) resumeSideFollow();
  else { sideScroll.following = false; updateSideReset(); }
}
// follow tick: keep the active item placed while following (throttled, like the strip)
function followSide(item) {
  if (!item) return;
  if (sideScroll.following && !sideScroll.suppressAuto) {
    const now = Date.now();
    if (now - lastSideScroll > 400) { lastSideScroll = now; animateSideTo(sideTarget(item)); }
  } else if (!sideScroll.following) {
    updateSideReset();
  }
}
// view switch (panel / language): mark the current item, then jump to it with no animation
function sideRelocateInstant() {
  scroll.suppressAuto = true; sideScroll.suppressAuto = true;
  tick(true);                  // sets the .current chapter/line in the freshly rendered list
  scroll.suppressAuto = false; sideScroll.suppressAuto = false;
  stopSideAnim();
  const cur = sideCur();
  if (cur) setSideScrollTop(sideTarget(cur));
  lastSideScroll = Date.now();   // hold off the follow tick briefly
  sideScroll.following = true;
  updateSideReset();
}

function setLayer(layer) {
  const s = strip();
  state.layer = layer;
  state.unitIndex = -1;
  document.querySelectorAll("#layer-switch button").forEach((b) =>
    b.classList.toggle("active", +b.dataset.layer === layer));
  const n = unitsFor(layer).length;
  const noun = layer === 1 ? "章" : layer === 2 ? "条" : "段";
  $("#strip-meta").innerHTML = `<b>${n}</b> ${noun} · ${LAYER_META[layer]}`;
  updateCapToggles(layer);
  renderUnitBand();
  renderFilmstrip();

  scroll.suppressAuto = true;   // tick marks the current card; we place the strip below
  tick(true);
  scroll.suppressAuto = false;

  // jump the current card to center instantly — already where follow wants it,
  // so no delayed smooth-scroll afterward (i.e. switching shows zero animation)
  stopAnim();
  const cur = s.querySelector(".card.current");
  if (cur) s.scrollLeft = centerScroll(cur);
  lastScroll = Date.now();      // hold off the follow tick briefly
  scroll.following = true;
  setArrow(null);
  if (state.loop) state.loopIndex = state.unitIndex;   // re-lock loop in the new layer
}

// ---------- playback sync ----------
function unitIndexAt(t) {
  const units = unitsFor(state.layer);
  let j = units.findIndex((u) => t >= u.start && t < u.end);
  if (j === -1) j = t >= units[units.length - 1].end ? units.length - 1
                  : Math.max(0, units.findIndex((u) => t < u.start) - 1);
  return j;
}

function seekTo(t) {
  // a deliberate seek moves the loop lock to the target unit
  if (state.loop) state.loopIndex = unitIndexAt(t);
  if (video.readyState === 0) {
    pendingTime = t;
    return;
  }
  video.currentTime = t + 0.001;
}

let lastScroll = 0;

// transcript current-line highlight (driven by playhead); scrolling handled by followSide
let curTxId = null;
function updateTranscript(seg) {
  const id = seg ? seg.id : null;
  if (id === curTxId) return;
  curTxId = id;
  document.querySelectorAll(".tx-line.current").forEach((l) => l.classList.remove("current"));
  if (!id) return;
  const line = document.querySelector(`.tx-line[data-id="${id}"]`);
  if (!line) return;
  line.classList.add("current");
  followSide(line);
}

function tick(force = false, t = video.currentTime) {
  if (!state.data) return;
  const dur = state.data.meta.duration;

  $("#playhead").style.left = `${(t / dur) * 100}%`;
  $("#timecode").innerHTML = `<b>${fmt(t)}</b> / ${fmt(dur)}`;

  const units = unitsFor(state.layer);
  let i = units.findIndex((u) => t >= u.start && t < u.end);
  if (i === -1) i = t >= units[units.length - 1].end ? units.length - 1
                  : Math.max(0, units.findIndex((u) => t < u.start) - 1);

  // loop within the locked unit (re-anchored by seekTo on deliberate seeks,
  // so switching cards while looping moves the loop instead of snapping back)
  if (state.loop && state.loopIndex >= 0) {
    const u = units[state.loopIndex];
    if (t >= u.end || t < u.start - 0.3) {
      seekTo(u.start);
      return;
    }
    i = state.loopIndex;
  }

  const changed = i !== state.unitIndex || force;
  state.unitIndex = i;
  const u = units[i];

  // video captions are the REAL subtitles — always the L3 bilingual page track,
  // independent of which timeline view is active. Blank during gaps.
  const capEn = $("#captions .en"), capZh = $("#captions .zh");
  const cseg = state.data.segments.find((x) => t >= x.start && t < x.end);
  if (!cseg) {
    capEn.textContent = "";
    capZh.textContent = "";
  } else {
    // two independent tracks, YouTube-style: each row pages on its own clock
    const page = (pages) =>
      (pages.find((p) => t >= p.t0 && t < p.t1) || pages[pages.length - 1]).text;
    capEn.textContent = page(cseg.enPages);
    capZh.textContent = page(cseg.zhPages);
  }

  // left transcript panel follows the same segment, on its own granularity
  if (state.sidePanel === "transcript") updateTranscript(cseg);

  // segment progress: fraction through the current unit (0..1), clamped
  const span = Math.max(0.001, u.end - u.start);
  const frac = Math.min(1, Math.max(0, (t - u.start) / span));
  const pct = (frac * 100).toFixed(2) + "%";
  $("#seg-fill").style.width = pct;
  $("#seg-knob").style.left = pct;
  const curCard = document.querySelector(`#filmstrip .card[data-id="${u.id}"] .prog`);
  if (curCard) curCard.style.width = pct;

  if (changed) {
    // clear progress fill on every other card; the current one keeps updating
    document.querySelectorAll("#filmstrip .card .prog").forEach((p) => {
      if (p.closest(".card").dataset.id !== u.id) p.style.width = "0%";
    });
    $("#unit-label").textContent = `${u.id} · ${i + 1}/${units.length}`;

    document.querySelectorAll("#unit-band .block.current")
      .forEach((b) => b.classList.remove("current"));
    const bb = document.querySelector(`#unit-band .block[data-id="${u.id}"]`);
    if (bb) bb.classList.add("current");

    document.querySelectorAll("#filmstrip .card.current")
      .forEach((c) => c.classList.remove("current"));
    const card = document.querySelector(`#filmstrip .card[data-id="${u.id}"]`);
    if (card) {
      card.classList.add("current");
      const now = Date.now();
      if (scroll.following && !scroll.dragging && !scroll.suppressAuto && now - lastScroll > 600) {
        lastScroll = now;
        animateScrollTo(centerScroll(card));
      } else if (!scroll.following) {
        updateArrows();   // current card moved while paused — re-aim the arrow
      }
    }

    const ch = state.data.chapters.find((c) => t >= c.start && t < c.end)
            || state.data.chapters[state.data.chapters.length - 1];
    document.querySelectorAll(".chapter-item.current")
      .forEach((c) => c.classList.remove("current"));
    const ci = document.querySelector(`.chapter-item[data-id="${ch.id}"]`);
    if (ci) { ci.classList.add("current"); if (state.sidePanel === "chapters") followSide(ci); }
    document.querySelectorAll("#chapter-band .block.current")
      .forEach((c) => c.classList.remove("current"));
    const cb = document.querySelector(`#chapter-band .block[data-id="${ch.id}"]`);
    if (cb) cb.classList.add("current");
  }
}

function step(dir) {
  const units = unitsFor(state.layer);
  const i = Math.min(units.length - 1, Math.max(0, state.unitIndex + dir));
  seekTo(units[i].start);
}

// ---------- wiring ----------
function wire() {
  document.querySelectorAll("#layer-switch button").forEach((b) =>
    b.onclick = () => setLayer(+b.dataset.layer));

  document.querySelectorAll("#side-switch button").forEach((b) =>
    b.onclick = () => setSidePanel(b.dataset.panel));
  document.querySelectorAll("#side-text button").forEach((b) =>
    b.onclick = () => setSideText(b.dataset.text));

  // toggling card text re-renders the strip; keep scroll put and don't auto-follow
  const reflowCards = () => {
    stopAnim();
    const sl = strip().scrollLeft;
    renderFilmstrip();
    strip().scrollLeft = sl;
    scroll.suppressAuto = true;
    tick(true);
    scroll.suppressAuto = false;
    updateArrows();
  };
  $("#tog-en").onclick = () => {
    const c = state.caps[state.layer];
    if (!c || c.en === undefined) return;
    c.en = !c.en;
    updateCapToggles(state.layer);
    reflowCards();
  };
  $("#tog-zh").onclick = () => {
    const c = state.caps[state.layer];
    if (!c) return;
    c.zh = !c.zh;
    updateCapToggles(state.layer);
    reflowCards();
  };

  $("#reset-left").onclick = resumeFollow;
  $("#reset-right").onclick = resumeFollow;

  // sidebar: any user scroll (wheel / scrollbar / touch) pauses follow, then settles
  sideEl().addEventListener("scroll", () => {
    if (sideScroll.programmatic) return;
    stopSideAnim();
    sideScroll.following = false;
    updateSideReset();
    if (sideScroll.settleTimer) clearTimeout(sideScroll.settleTimer);
    sideScroll.settleTimer = setTimeout(onSideSettle, 200);
  });
  $("#side-reset").onclick = resumeSideFollow;

  // drag-to-scroll the filmstrip; a real drag pauses follow and suppresses the click-seek.
  // pointermove can fire faster than the display refreshes, so coalesce the scroll
  // writes to one per frame — keeps the drag tight to the cursor without layout thrash.
  const fs = $("#filmstrip");
  let dragX = 0, dragScroll = 0, dragMoved = false, downId = null, wheelTimer = null;
  let pendingScroll = null, scrollRaf = 0;
  const flushScroll = () => {
    scrollRaf = 0;
    if (pendingScroll != null) { fs.scrollLeft = pendingScroll; pendingScroll = null; }
  };
  fs.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    stopAnim();   // touching the strip interrupts any in-flight auto-scroll
    // don't capture yet — capturing here would retarget the click off the card
    dragMoved = false;
    dragX = e.clientX;
    dragScroll = fs.scrollLeft;
    downId = e.pointerId;
  });
  fs.addEventListener("pointermove", (e) => {
    if (downId === null) return;
    // button released off-element (no capture yet) → pointerup never reached us;
    // bail out and reset so we don't "stick" to the cursor on the next hover.
    if (!(e.buttons & 1)) { endDrag(e); return; }
    const dx = e.clientX - dragX;
    if (!scroll.dragging) {
      if (Math.abs(dx) <= 4) return;     // still a click, not a drag
      scroll.dragging = true;            // crossed the threshold → start dragging
      dragMoved = true;
      fs.classList.add("dragging");
      fs.setPointerCapture(e.pointerId);
    }
    pendingScroll = dragScroll - dx;
    if (!scrollRaf) scrollRaf = requestAnimationFrame(flushScroll);
  });
  const endDrag = (e) => {
    if (downId === null) return;
    downId = null;
    if (!scroll.dragging) return;        // plain click — let it through to the card
    scroll.dragging = false;
    if (scrollRaf) { cancelAnimationFrame(scrollRaf); flushScroll(); }
    fs.classList.remove("dragging");
    try { fs.releasePointerCapture(e.pointerId); } catch (_) {}
    onScrollSettle();
  };
  fs.addEventListener("pointerup", endDrag);
  fs.addEventListener("pointercancel", endDrag);
  // swallow the click that fires right after a real drag, so it doesn't seek
  fs.addEventListener("click", (e) => {
    if (dragMoved) { e.stopPropagation(); e.preventDefault(); dragMoved = false; }
  }, true);
  // wheel / trackpad scroll also pauses follow; settle after it goes idle
  fs.addEventListener("wheel", () => {
    stopAnim();
    scroll.following = false;
    updateArrows();
    if (wheelTimer) clearTimeout(wheelTimer);
    wheelTimer = setTimeout(onScrollSettle, 220);
  }, { passive: true });

  const toggleSidebar = () => $("#app").classList.toggle("sidebar-collapsed");
  $("#toggle-sidebar").onclick = toggleSidebar;

  // hide/show the whole bottom panel; on reveal, re-center the strip on the current card
  const toggleBottom = () => {
    const collapsed = $("#app").classList.toggle("bottom-collapsed");
    if (!collapsed) resumeFollow();
  };
  $("#toggle-bottom").onclick = toggleBottom;

  $("#btn-play").onclick = () => togglePlay();
  $("#btn-prev").onclick = () => step(-1);
  $("#btn-next").onclick = () => step(1);
  $("#btn-loop").onclick = () => {
    state.loop = !state.loop;
    if (state.loop)
      state.loopIndex = state.unitIndex >= 0 ? state.unitIndex : unitIndexAt(video.currentTime);
    $("#btn-loop").classList.toggle("on", state.loop);
  };

  video.addEventListener("seeked", () => tick(true));
  video.addEventListener("play", () => {
    $("#ic-play").style.display = "none";
    $("#ic-pause").style.display = "";
  });
  video.addEventListener("pause", () => {
    $("#ic-play").style.display = "";
    $("#ic-pause").style.display = "none";
  });
  // Frame-accurate playback clock. rVFC hands us the mediaTime of the frame
  // actually on screen (more precise than reading currentTime under rAF) and
  // only fires while frames advance — no spin while paused. Paused-state
  // refreshes (seek, layer switch, …) come through explicit tick(true) calls.
  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
    const onFrame = (_now, meta) => {
      tick(false, meta.mediaTime);
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  } else {
    (function raf() { tick(); requestAnimationFrame(raf); })();
  }

  const tl = $("#timeline");
  const scrub = (e) => {
    const r = tl.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    seekTo(f * state.data.meta.duration);
  };
  tl.addEventListener("pointerdown", (e) => {
    scrub(e);
    tl.setPointerCapture(e.pointerId);
    tl.onpointermove = scrub;
  });
  tl.addEventListener("pointerup", () => (tl.onpointermove = null));

  // segment scrubber: maps the bar across the current unit's [start, end)
  const seg = $("#seg-progress");
  const segScrub = (e) => {
    const units = unitsFor(state.layer);
    const u = units[state.unitIndex] || units[0];
    if (!u) return;
    const r = seg.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    seekTo(u.start + f * (u.end - u.start));
  };
  seg.addEventListener("pointerdown", (e) => {
    segScrub(e);
    seg.setPointerCapture(e.pointerId);
    seg.onpointermove = segScrub;
  });
  seg.addEventListener("pointerup", () => (seg.onpointermove = null));

  $("#stage").onclick = () => togglePlay();

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "l" || e.key === "L") $("#btn-loop").click();
    else if (e.key === "b" || e.key === "B") toggleSidebar();
    else if (e.key === "v" || e.key === "V") toggleBottom();
    else if (e.key >= "1" && e.key <= "3") setLayer(+e.key);
  });
}

// ---------- boot ----------
// Point <video> at a project's source (an object: URL the caller already holds —
// the demo's bundled blob or an imported File). Interactions that fire before
// metadata is ready are stashed in pendingTime/pendingPlay and replayed here on
// loadedmetadata, so seeking/playing immediately after a load isn't lost.
let pendingTime = null;
let pendingPlay = false;

function setVideoSrc(url) {
  if (video.src.startsWith("blob:")) URL.revokeObjectURL(video.src);
  pendingTime = null;
  pendingPlay = false;
  video.src = url;
  video.addEventListener("loadedmetadata", () => {
    if (pendingTime != null) {
      video.currentTime = pendingTime + 0.001;
      pendingTime = null;
    }
    if (pendingPlay) {
      pendingPlay = false;
      video.play();
    }
  }, { once: true });
}

function togglePlay() {
  if (video.readyState === 0) {
    pendingPlay = !pendingPlay;
    return;
  }
  video.paused ? video.play() : video.pause();
}

function playVideo() {
  if (video.readyState === 0) {
    pendingPlay = true;
    return;
  }
  video.play();
}

// First paint stops at the landing screen — nothing auto-loads. wire() only
// attaches listeners (all guarded by `if (!state.data)`), so it is safe to run
// before any project exists.
function boot() {
  wire();
  showLanding();
}

// ---------- stage switching: landing ↔ storyboard ----------
function showApp() {
  $("#app").hidden = false;
  $("#landing").hidden = true;
  $("#landing-close").hidden = false; // a project now exists to return to
}

function showLanding() {
  $("#landing").hidden = false;
  $("#landing-close").hidden = !state.data; // dismissible only once something is loaded
}

// Render a fully-built project (demo or imported) into the UI and reveal it.
// Every render fn clears its container first, so this is idempotent — calling it
// again swaps the whole project at runtime (that's how import re-loads live).
function loadProject(data) {
  state.data = data;
  state.unitIndex = -1;
  state.loopIndex = -1;
  $("#title").innerHTML = data.meta.title +
    (data.meta.uploader ? `<span>${data.meta.uploader}</span>` : "");
  renderSidebar();
  renderHeatmap();
  renderChapterBand();
  setLayer(3);
  applyComponentVisibility();
  showApp();
}

// Hide UI whose backing data is absent or redundant (imports / short clips), and
// collapse the space it leaves. Driven by #app classes the CSS keys off:
//   no-chapters — ≤1 synthesized chapter: drop the L1「重要时刻」surfaces
//                 (sidebar nav, layer button, chapter band) → 字幕 panel
//   no-heatmap  — empty「高能条」(replay heatmap): drop the curve
//   same-l2l3   — L2 字幕轴 segmentation is 1:1 with L3 语义段 (typical for an
//                 import): drop the redundant 字幕轴 view, keep the richer 语义段
//   solo-layer  — only one segment view survives: drop the whole 视图 switcher
// Timeline bands are bottom-anchored, so shrinking #timeline from the top (in CSS
// per class) reclaims the vacated rows automatically.
function applyComponentVisibility() {
  const app = $("#app");
  const { chapters, cues, segments, meta } = state.data;
  const hasChapters = chapters.length > 1;
  const hasHeatmap = (meta.heatmap || []).length > 0;
  const sameL2L3 = cues.length === segments.length &&
    cues.every((c, i) => c.start === segments[i].start && c.end === segments[i].end);
  const layerCount = 1 + (hasChapters ? 1 : 0) + (sameL2L3 ? 0 : 1); // L3 always + maybe L1/L2

  app.classList.toggle("no-chapters", !hasChapters);
  app.classList.toggle("no-heatmap", !hasHeatmap);
  app.classList.toggle("same-l2l3", sameL2L3);
  app.classList.toggle("solo-layer", layerCount <= 1);

  $("#layer-switch button[data-layer='1']").hidden = !hasChapters;
  $("#layer-switch button[data-layer='2']").hidden = sameL2L3;

  setSidePanel(hasChapters ? "chapters" : "transcript");
  if (state.layer === 1 || (state.layer === 2 && sameL2L3)) setLayer(3);
}

// Load the bundled example — a tiny original bilingual story that ships in the
// repo (example/, ~40 KB), so the demo works on GitHub Pages with no large
// media and no licensing concerns. Built client-side via the same parse+synth
// path as a user import, so it doubles as a live example of that pipeline.
async function loadDemo() {
  const base = "example/";
  const [enText, zhText, blob] = await Promise.all([
    fetch(base + "story.en.vtt").then((r) => r.text()),
    fetch(base + "story.zh.vtt").then((r) => r.text()),
    fetch(base + "story.mp4").then((r) => r.blob()),
  ]);
  const enCues = parseSubs(enText);   // import.js globals
  const zhCues = parseSubs(zhText);
  const url = URL.createObjectURL(blob);
  let probe;
  try { probe = await probeVideo(blob); }
  catch { probe = { duration: 0, width: 640, height: 360 }; }
  const lastEnd = enCues[enCues.length - 1].end;
  const data = buildProject({
    title: "一颗种子的攀爬",
    uploader: "示例 · 双语",
    duration: isFinite(probe.duration) && probe.duration > 0 ? probe.duration : lastEnd,
    width: probe.width,
    height: probe.height,
    enCues,
    zhCues,
  });
  setVideoSrc(url);
  loadProject(data);
}

// Entry point for import.js: load a user-picked local video + synthesized model.
// We already hold the File, so point <video> straight at an object URL for it.
function loadImported(data, file) {
  setVideoSrc(URL.createObjectURL(file));
  loadProject(data);
}

boot();
