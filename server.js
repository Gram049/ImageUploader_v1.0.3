// server.js — RGB565 BIG-ENDIAN (rgb565be) para evitar swap no ESP32
// Requisitos: node + ffmpeg + ffprobe no PATH
//
// Endpoints:
//  - /device/<id>/frame.rgb565        (static, rgb565be)
//  - /device/<id>/anim.rgb565         (stream concatenado, rgb565be)
//  - /device/<id>/frames/000.rgb565   (frames individuais, rgb565be)
//  - /device/<id>/meta.json           (inclui format: "rgb565be")

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const app = express();
const ROOT = "/tmp";
const UPLOADS_DIR = path.join(ROOT, "uploads");
const OUT_DIR = path.join(ROOT, "out");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const upload = multer({ dest: UPLOADS_DIR });

function execFFmpeg(args) {
  console.log("\n[ffmpeg] ffmpeg " + args.map(a => (a.includes(" ") ? `"${a}"` : a)).join(" "));
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { windowsHide: true }, (err, stdout, stderr) => {
      if (stdout && stdout.trim()) console.log("[ffmpeg stdout]\n" + stdout);
      if (stderr && stderr.trim()) console.log("[ffmpeg stderr]\n" + stderr);
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout, stderr });
    });
  });
}

function execFFprobe(args) {
  console.log("\n[ffprobe] ffprobe " + args.map(a => (a.includes(" ") ? `"${a}"` : a)).join(" "));
  return new Promise((resolve, reject) => {
    execFile("ffprobe", args, { windowsHide: true }, (err, stdout, stderr) => {
      if (stderr && stderr.trim()) console.log("[ffprobe stderr]\n" + stderr);
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

function safeId(s) {
  const v = String(s || "").trim();
  return v.replace(/[^a-zA-Z0-9_-]/g, "") || "abc";
}

function emptyDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function devicePaths(deviceId) {
  const id = safeId(deviceId);
  const dir = path.join(OUT_DIR, id);
  return {
    id,
    dir,
    meta: path.join(dir, "meta.json"),
    frame: path.join(dir, "frame.rgb565"),      // rgb565be
    framesDir: path.join(dir, "frames"),
    animStream: path.join(dir, "anim.rgb565"),  // rgb565be
  };
}

// 240x240 com barras pretas
const VF_240 =
  "scale=240:240:force_original_aspect_ratio=decrease," +
  "pad=240:240:(ow-iw)/2:(oh-ih)/2:color=black";

async function makeStaticRGB565be(inputPath, outFramePath) {
  await execFFmpeg([
    "-y",
    "-i", inputPath,
    "-an",
    "-vf", VF_240,
    "-frames:v", "1",
    "-f", "rawvideo",
    "-pix_fmt", "rgb565be",
    outFramePath
  ]);
}

async function getGifFrameDelaysMs(inputPath, maxSeconds = 20) {
  const out = await execFFprobe([
    "-v", "error",
    "-select_streams", "v:0",
    "-show_frames",
    "-show_entries", "frame=pkt_duration_time",
    "-of", "json",
    inputPath
  ]);

  let json;
  try { json = JSON.parse(out); }
  catch { return { delays_ms: [], duration_ms: 0, fps_avg: 0 }; }

  const frames = Array.isArray(json.frames) ? json.frames : [];

  const delays = [];
  let durationMs = 0;

  for (const fr of frames) {
    const dt = Number(fr.pkt_duration_time);
    if (!Number.isFinite(dt) || dt <= 0) continue;

    const ms = Math.max(10, Math.round(dt * 1000));
    delays.push(ms);
    durationMs += ms;

    if (durationMs >= maxSeconds * 1000) break;
  }

  const fpsAvg = durationMs > 0 ? (delays.length * 1000.0) / durationMs : 0;
  return { delays_ms: delays, duration_ms: durationMs, fps_avg: fpsAvg };
}

async function makeGifStreamAndFramesRGB565be(inputPath, outStreamPath, framesDir, maxSeconds = 20) {
  fs.mkdirSync(framesDir, { recursive: true });

  // 1) Stream raw concatenado (rgb565be)
  await execFFmpeg([
    "-y",
    "-ignore_loop", "0",
    "-t", String(maxSeconds),
    "-i", inputPath,
    "-an",
    "-vf", VF_240,
    "-f", "rawvideo",
    "-pix_fmt", "rgb565be",
    outStreamPath
  ]);

  // 2) Dividir em frames 000.rgb565...
  const BYTES_PER_FRAME = 240 * 240 * 2; // 115200
  const data = fs.readFileSync(outStreamPath);
  const total = data.length;
  const frames = Math.floor(total / BYTES_PER_FRAME);

  // limpar frames antigos
  for (const f of fs.readdirSync(framesDir)) {
    if (/^\d{3}\.rgb565$/i.test(f)) fs.rmSync(path.join(framesDir, f), { force: true });
  }

  for (let i = 0; i < frames; i++) {
    const start = i * BYTES_PER_FRAME;
    const chunk = data.subarray(start, start + BYTES_PER_FRAME);
    const name = String(i).padStart(3, "0") + ".rgb565";
    fs.writeFileSync(path.join(framesDir, name), chunk);
  }

  const leftover = total - frames * BYTES_PER_FRAME;
  if (leftover !== 0) {
    console.log(`[split] Sobrou ${leftover} bytes (raw total=${total}, frames=${frames})`);
  }

  return frames;
}

function sendBinaryStreamFile(req, res, filePath) {
  const st = fs.statSync(filePath);

  res.status(200);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", String(st.size));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "close");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const rs = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });

  rs.on("error", (e) => {
    console.log("[stream] read error:", e?.message || e);
    if (!res.headersSent) res.status(500);
    res.end();
  });

  req.on("close", () => rs.destroy());
  rs.pipe(res);
}

// ===== UI (CRT / terminal) =====
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function page(title, bodyHtml) {
  const css = `
    :root{
      --bg:#020402;
      --fg:#c7ffc6;
      --dim:#7cf57c;
      --line:rgba(199,255,198,.30);
      --err:#ff6b6b;

      --fs: 16px;
      --lh: 1.25;
      --w: 860px;
      --r: 10px;

      font-family:
        "Cascadia Mono",
        "Consolas",
        "Lucida Console",
        "Menlo",
        "Monaco",
        "DejaVu Sans Mono",
        "Liberation Mono",
        ui-monospace,
        SFMono-Regular,
        "Courier New",
        monospace;
      font-size: var(--fs);
      line-height: var(--lh);
    }

    *{ box-sizing:border-box }
    html, body { height:100% }

    body{
      margin:0;
      background:
        radial-gradient(1000px 700px at 50% 35%, rgba(199,255,198,.10), transparent 60%),
        radial-gradient(800px 600px at 50% 120%, rgba(0,0,0,.9), transparent 55%),
        var(--bg);
      color: var(--fg);
      display:grid;
      place-items:center;
      padding: 22px;
    }

    .crt{
      width:min(var(--w), 100%);
      position:relative;
      overflow:hidden;
      border-radius: var(--r);
      border: 1px solid var(--line);
      background: rgba(0,0,0,.42);
      padding: 16px;

      box-shadow:
        0 20px 90px rgba(0,0,0,.85),
        0 0 0 1px rgba(199,255,198,.10) inset,
        0 0 60px rgba(199,255,198,.08);

      filter: saturate(1.25) contrast(1.22) brightness(1.04);
      transform: perspective(900px) rotateX(0.6deg);
    }

    .crt:before{
      content:"";
      position:absolute; inset:-2px;
      pointer-events:none;
      background:
        radial-gradient(120% 100% at 50% 50%,
          rgba(255,255,255,.06),
          rgba(0,0,0,0) 55%),
        radial-gradient(120% 110% at 50% 50%,
          rgba(0,0,0,.75),
          rgba(0,0,0,0) 52%);
      opacity:.85;
      mix-blend-mode: overlay;
    }

    .vignette{
      position:absolute; inset:-60px;
      pointer-events:none;
      background: radial-gradient(closest-side at 50% 45%,
        rgba(199,255,198,.16),
        rgba(0,0,0,.75) 72%,
        rgba(0,0,0,.95) 100%);
      opacity:.65;
    }

    .scanlines{
      position:absolute; inset:0;
      pointer-events:none;
      background: repeating-linear-gradient(
        to bottom,
        rgba(199,255,198,.16) 0px,
        rgba(199,255,198,.16) 1px,
        rgba(0,0,0,0) 3px,
        rgba(0,0,0,0) 7px
      );
      opacity:.55;
      mix-blend-mode: screen;
      animation: scanmove 1.8s linear infinite;
    }
    @keyframes scanmove{
      from { transform: translateY(0); }
      to   { transform: translateY(28px); }
    }

    .roll{
      position:absolute; inset:0;
      pointer-events:none;
      background: linear-gradient(
        to bottom,
        rgba(199,255,198,0) 0%,
        rgba(199,255,198,.18) 48%,
        rgba(199,255,198,.10) 50%,
        rgba(199,255,198,0) 55%,
        rgba(0,0,0,0) 100%
      );
      opacity:.40;
      mix-blend-mode: screen;
      animation: roll 6.5s linear infinite;
      transform: translateY(-120%);
    }
    @keyframes roll{
      0%   { transform: translateY(-120%); }
      100% { transform: translateY(120%); }
    }

    .noise{
      position:absolute; inset:0;
      pointer-events:none;
      background:
        radial-gradient(circle at 20% 30%, rgba(255,255,255,.08), transparent 35%),
        radial-gradient(circle at 80% 60%, rgba(255,255,255,.06), transparent 40%),
        radial-gradient(circle at 50% 50%, rgba(255,255,255,.03), transparent 55%);
      opacity:.20;
      mix-blend-mode: screen;
      animation: noise 0.18s steps(2,end) infinite;
      filter: blur(.2px);
    }
    @keyframes noise{
      0% { transform: translate(0,0); }
      25%{ transform: translate(-1px, 1px); }
      50%{ transform: translate(1px, -1px); }
      75%{ transform: translate(1px, 1px); }
      100%{ transform: translate(0,0); }
    }

    .flicker{
      position:absolute; inset:0;
      pointer-events:none;
      background: rgba(199,255,198,.16);
      opacity:.06;
      mix-blend-mode: screen;
      animation: flicker 1.9s infinite;
    }
    @keyframes flicker{
      0%{opacity:.05}
      6%{opacity:.11}
      10%{opacity:.04}
      14%{opacity:.14}
      18%{opacity:.06}
      30%{opacity:.12}
      44%{opacity:.05}
      60%{opacity:.13}
      78%{opacity:.05}
      100%{opacity:.06}
    }

    .screen{
      position:relative;
      z-index:2;
      -webkit-font-smoothing: none;
      -moz-osx-font-smoothing: grayscale;
      font-smooth: never;
      text-shadow:
        0 0 18px rgba(199,255,198,.28),
        0 0 6px rgba(199,255,198,.22);
    }
    .screen *{
      text-shadow:
        0 0 18px rgba(199,255,198,.22),
        -1.2px 0 rgba(255,60,60,.22),
        1.1px 0 rgba(70,120,255,.18);
    }

    header{ margin-bottom: 10px; }
    header .title{ letter-spacing: 1px; }
    header .sub{ color: var(--dim); font-size: .85em; }

    hr{ border:0; border-top:1px solid var(--line); margin: 12px 0; }

    .grid{ display:grid; grid-template-columns:1fr; gap:12px; }
    @media (min-width: 860px){ .grid{ grid-template-columns: 1fr 1fr; } }

    .box{
      border:1px solid var(--line);
      border-radius: var(--r);
      padding: 12px;
      background: rgba(0,0,0,.28);
    }
    .box h2{
      margin:0 0 10px;
      font-size: 1em;
      font-weight: 700;
      letter-spacing: 1px;
    }

    label{ display:block; color: var(--dim); margin: 8px 0 8px; }

    /* ===== File input custom (terminal-like) ===== */
    .fileRow{
      display:flex;
      gap:10px;
      align-items:center;
      flex-wrap:wrap;
    }

    .fileInput{
      position:absolute;
      left:-9999px;
      width:1px; height:1px;
      opacity:0;
    }

    .btn{
      display:inline-block;
      width:auto;
      background: rgba(0,0,0,.45);
      border:1px solid var(--line);
      border-radius: 8px;
      color: var(--fg);
      padding: 10px 12px;
      cursor:pointer;
      user-select:none;
    }
    .btn:hover{ border-color: rgba(199,255,198,.75); }

    .fileName{
      flex:1;
      min-width: 180px;
      border:1px solid var(--line);
      border-radius: 8px;
      padding: 10px 10px;
      background: rgba(0,0,0,.25);
      color: var(--dim);
      overflow:hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fileName strong{ color: var(--fg); font-weight: 400; }

    button{
      margin-top: 10px;
      width: 100%;
      background: rgba(0,0,0,.45);
      border:1px solid var(--line);
      border-radius: 8px;
      color: var(--fg);
      padding: 12px 12px;
      cursor:pointer;
    }
    button:hover{ border-color: rgba(199,255,198,.75); }

    /* ===== Preview (sem título, mais pequena) ===== */
    /* ===== Preview (centrado, outline quadrado) ===== */
.previewWrap{
  margin-top: 12px;
  display: flex;
  justify-content: center;  /* centra horizontalmente */
}

.previewFrame{
  width: 240px;
  height: 240px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: rgba(0,0,0,.25);
  display: none;
  align-items: center;
  justify-content: center;
  padding: 8px;

  position: relative;   /* necessário para overlays CRT */
  overflow: hidden;     /* corta scanlines ao quadrado */
}

/* imagem dentro da moldura */
.preview{
  max-width: 100%;
  max-height: 100%;
  display: block;
  object-fit: contain;
  background: rgba(0,0,0,.35);
  border: 1px solid rgba(199,255,198,.18);
  border-radius: 6px;
  image-rendering: pixelated;
}

/* CRT overlay no preview (scanlines + brilho + flicker) */
.previewFrame::before{
  content:"";
  position:absolute; inset:0;
  pointer-events:none;
  background:
    repeating-linear-gradient(
      to bottom,
      rgba(199,255,198,.12) 0px,
      rgba(199,255,198,.12) 1px,
      rgba(0,0,0,0) 3px,
      rgba(0,0,0,0) 7px
    );
  opacity: .55;
  mix-blend-mode: screen;
  animation: previewScan 1.8s linear infinite;
}

.previewFrame::after{
  content:"";
  position:absolute; inset:0;
  pointer-events:none;
  background:
    radial-gradient(closest-side at 50% 45%,
      rgba(199,255,198,.10),
      rgba(0,0,0,.55) 70%,
      rgba(0,0,0,.85) 100%),
    rgba(199,255,198,.10);
  opacity:.18;
  mix-blend-mode: screen;
  animation: previewFlicker 1.9s infinite;
}

@keyframes previewScan{
  from { transform: translateY(0); }
  to   { transform: translateY(28px); }
}

@keyframes previewFlicker{
  0%{opacity:.12}
  6%{opacity:.22}
  10%{opacity:.10}
  14%{opacity:.26}
  18%{opacity:.13}
  30%{opacity:.21}
  44%{opacity:.12}
  60%{opacity:.24}
  78%{opacity:.11}
  100%{opacity:.14}
}

/* respeitar reduce motion */
@media (prefers-reduced-motion: reduce){
  .previewFrame::before,
  .previewFrame::after { animation: none !important; }
}

    a{ color: var(--fg); text-decoration: underline; text-underline-offset: 2px; }
    a:hover{ color: #e2ffe0; }

    code{
      color: var(--fg);
      background: rgba(0,0,0,.40);
      border:1px solid var(--line);
      padding: 1px 6px;
      border-radius: 8px;
    }

    ul{ margin: 8px 0 0; padding-left: 18px; }
    li{ margin: 8px 0; }

    .msg{
      border:1px solid var(--line);
      border-radius: var(--r);
      padding: 10px;
      background: rgba(0,0,0,.30);
    }
    .msg.err{ color: var(--err); border-color: rgba(255,107,107,.45); }

    @media (prefers-reduced-motion: reduce){
      .scanlines, .flicker, .roll, .noise { animation: none !important; }
    }
  `;

  return `<!doctype html>
  <html lang="pt-PT">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>${css}</style>
  </head>
  <body>
    <div class="crt">
      <div class="scanlines"></div>
      <div class="roll"></div>
      <div class="noise"></div>
      <div class="flicker"></div>
      <div class="vignette"></div>

      <div class="screen">
        <header>
          <div class="title">Upload Interface</div>
          <div class="sub">version 1.0.3</div>
        </header>
        <hr/>
        ${bodyHtml}
      </div>
    </div>
  </body>
  </html>`;
}

// Home (mantém device fixo "abc")
app.get("/", (req, res) => {
  const deviceId = "abc";
  const body = `
    <div class="grid">
      <section class="box">
        <h2>UPLOAD</h2>

        <form action="/upload/${deviceId}" method="post" enctype="multipart/form-data">
          <label>file</label>

          <div class="fileRow">
            <input id="file" class="fileInput" type="file" name="file" accept="image/*,.gif" required />
            <label class="btn" for="file">BROWSE...</label>
            <div id="fileName" class="fileName">no file selected</div>
          </div>

          <button type="submit">UPLOAD</button>

          <div class="previewWrap">
            <img id="preview" class="preview" alt="preview" />
          </div>
        </form>
      </section>

      <aside class="box">
        <h2>ENDPOINTS</h2>
        <ul>
          <li><a href="/device/${deviceId}/meta.json">meta.json</a><br><code>/device/${deviceId}/meta.json</code></li>
          <li><a href="/device/${deviceId}/frame.rgb565">frame.rgb565</a><br><code>/device/${deviceId}/frame.rgb565</code></li>
          <li><a href="/device/${deviceId}/anim.rgb565">anim.rgb565</a><br><code>/device/${deviceId}/anim.rgb565</code></li>
          <li><a href="/device/${deviceId}/frames/000.rgb565">frames/000.rgb565</a><br><code>/device/${deviceId}/frames/000.rgb565</code></li>
          <li><a href="/debug/${deviceId}">debug</a><br><code>/debug/${deviceId}</code></li>
        </ul>
      </aside>
    </div>

    <script>
      const input = document.getElementById('file');
      const out = document.getElementById('fileName');
      const img = document.getElementById('preview');

      let lastUrl = null;

      function esc(s){
        return String(s)
          .replaceAll('&','&amp;')
          .replaceAll('<','&lt;')
          .replaceAll('>','&gt;')
          .replaceAll('"','&quot;')
          .replaceAll("'","&#039;");
      }

      function clearPreview(){
        img.style.display = 'none';
        img.removeAttribute('src');
        if (lastUrl) {
          URL.revokeObjectURL(lastUrl);
          lastUrl = null;
        }
      }

      function setUI(){
        const f = input.files && input.files[0];

        if (!f){
          out.innerHTML = 'no file selected';
          clearPreview();
          return;
        }

        out.innerHTML = 'selected: <strong>' + esc(f.name) + '</strong>';

        if (f.type && f.type.startsWith('image/')) {
          clearPreview();
          lastUrl = URL.createObjectURL(f);
          img.src = lastUrl;
          img.style.display = 'block';
        } else {
          clearPreview();
        }
      }

      input.addEventListener('change', setUI);
      setUI();
    </script>
  `;
  res.type("html").send(page("Upload", body));
});

app.get("/debug/:deviceId", (req, res) => {
  const p = devicePaths(req.params.deviceId);
  const frames = fs.existsSync(p.framesDir)
    ? fs.readdirSync(p.framesDir).filter(f => f.endsWith(".rgb565")).sort()
    : [];

  const info = {
    device: p.id,
    hasMeta: fs.existsSync(p.meta),
    hasFrame: fs.existsSync(p.frame),
    hasAnim: fs.existsSync(p.animStream),
    frameCount: frames.length,
    firstFrames: frames.slice(0, 5),
    animBytes: fs.existsSync(p.animStream) ? fs.statSync(p.animStream).size : 0,
  };

  if (String(req.query.json || "") === "1") return res.json(info);

  const body = `
    <div class="box">
      <h2>DEBUG</h2>
      <ul>
        <li>device: <code>${escapeHtml(info.device)}</code></li>
        <li>hasMeta: <code>${info.hasMeta}</code></li>
        <li>hasFrame: <code>${info.hasFrame}</code></li>
        <li>hasAnim: <code>${info.hasAnim}</code></li>
        <li>frameCount: <code>${info.frameCount}</code></li>
        <li>animBytes: <code>${info.animBytes}</code></li>
        <li>firstFrames: <code>${escapeHtml(JSON.stringify(info.firstFrames))}</code></li>
      </ul>
      <div style="margin-top:10px"><a href="/">VOLTA</a></div>
    </div>
  `;
  res.type("html").send(page(`Debug ${p.id}`, body));
});

// ===== Upload =====
app.post("/upload/:deviceId", upload.single("file"), async (req, res) => {
  const p = devicePaths(req.params.deviceId);
  const tmpPath = req.file?.path;

  if (!tmpPath) return res.status(400).type("text").send("Ficheiro em falta (campo 'file').");

  const original = (req.file.originalname || "").toLowerCase();
  const mime = (req.file.mimetype || "").toLowerCase();
  const isGif = mime === "image/gif" || original.endsWith(".gif");

  fs.mkdirSync(p.dir, { recursive: true });

  try {
    emptyDir(p.dir);
    fs.mkdirSync(p.framesDir, { recursive: true });

    const updatedAt = Date.now();

    if (isGif) {
      const maxSeconds = 20;

      let delaysInfo = { delays_ms: [], duration_ms: 0, fps_avg: 0 };
      try { delaysInfo = await getGifFrameDelaysMs(tmpPath, maxSeconds); }
      catch (e) { console.log("[warn] ffprobe delays falhou:", e.message); }

      const framesGenerated = await makeGifStreamAndFramesRGB565be(tmpPath, p.animStream, p.framesDir, maxSeconds);

      if (framesGenerated <= 0) {
        return res.status(500).type("html").send(page("Erro", `
          <div class="box">
            <div class="msg err">ERRO: não foram gerados frames do GIF.</div>
            <div style="margin-top:10px"><a href="/">VOLTA</a></div>
          </div>
        `));
      }

      let delays = Array.isArray(delaysInfo.delays_ms) ? delaysInfo.delays_ms : [];
      let framesForPlayback = framesGenerated;

      if (!delays.length) {
        delays = Array(framesGenerated).fill(100);
      } else {
        framesForPlayback = Math.min(framesGenerated, delays.length);
        delays = delays.slice(0, framesForPlayback);
      }

      const meta = {
        type: "anim",
        w: 240, h: 240,
        format: "rgb565be",
        frames: framesForPlayback,
        base: `/device/${p.id}/frames/`,
        stream: `/device/${p.id}/anim.rgb565`,
        delays_ms: delays,
        fps_avg: Number.isFinite(delaysInfo.fps_avg) ? Number(delaysInfo.fps_avg.toFixed(3)) : 0,
        updatedAt
      };

      fs.writeFileSync(p.meta, JSON.stringify(meta, null, 2));

      return res.type("html").send(page("Upload OK", `
        <div class="box">
          <div class="msg">OK: GIF converted</div>
          <ul>
            <li><a href="/device/${p.id}/meta.json">meta.json</a></li>
            <li><a href="/device/${p.id}/anim.rgb565">anim.rgb565</a></li>
            <li><a href="/device/${p.id}/frames/000.rgb565">frames/000.rgb565</a></li>
          </ul>
          <div style="margin-top:10px"><a href="/">BACK</a></div>
        </div>
      `));
    } else {
      await makeStaticRGB565be(tmpPath, p.frame);

      const stat = fs.statSync(p.frame);
      const meta = {
        type: "static",
        w: 240, h: 240,
        format: "rgb565be",
        bytes: stat.size,
        path: `/device/${p.id}/frame.rgb565`,
        updatedAt
      };

      fs.writeFileSync(p.meta, JSON.stringify(meta, null, 2));

      return res.type("html").send(page("Upload OK", `
        <div class="box">
          <div class="msg">OK: image converted</div>
          <ul>
            <li><a href="/device/${p.id}/meta.json">meta.json</a></li>
            <li><a href="/device/${p.id}/frame.rgb565">frame.rgb565</a></li>
          </ul>
          <div style="margin-top:10px"><a href="/">BACK</a></div>
        </div>
      `));
    }
  } catch (e) {
    console.error(e);
    return res.status(500).type("text").send(String(e.message || e));
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
});

// ===== Serve endpoints =====
app.get("/device/:deviceId/meta.json", (req, res) => {
  const p = devicePaths(req.params.deviceId);
  if (!fs.existsSync(p.meta)) return res.status(404).json({ error: "no meta yet" });
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(p.meta);
});

app.get("/device/:deviceId/frame.rgb565", (req, res) => {
  const p = devicePaths(req.params.deviceId);
  if (!fs.existsSync(p.frame)) return res.status(404).end();
  sendBinaryStreamFile(req, res, p.frame);
});

app.get("/device/:deviceId/frames/:file", (req, res) => {
  const p = devicePaths(req.params.deviceId);
  const file = String(req.params.file || "").replace(/[^0-9a-zA-Z_.-]/g, "");
  const fp = path.join(p.framesDir, file);
  if (!fp.startsWith(p.framesDir)) return res.status(400).end();
  if (!fs.existsSync(fp)) return res.status(404).end("frame nao encontrado");
  sendBinaryStreamFile(req, res, fp);
});

app.get("/device/:deviceId/anim.rgb565", (req, res) => {
  const p = devicePaths(req.params.deviceId);
  if (!fs.existsSync(p.animStream)) return res.status(404).end("anim stream nao encontrado");
  sendBinaryStreamFile(req, res, p.animStream);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});