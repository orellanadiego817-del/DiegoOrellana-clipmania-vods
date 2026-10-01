const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const ffmpegPath = require("ffmpeg-static");
const ytDlp = require("yt-dlp-exec");

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = String(process.env.PUBLIC_BASE_URL || "https://diegoorellana-clipmania-vods-production.up.railway.app").replace(/\/$/, "");
const TIKTOK_CLIENT_KEY = String(process.env.TIKTOK_CLIENT_KEY || "").trim();
const TIKTOK_CLIENT_SECRET = String(process.env.TIKTOK_CLIENT_SECRET || "").trim();
const TIKTOK_REDIRECT_URI = String(process.env.TIKTOK_REDIRECT_URI || (BASE_URL + "/auth/tiktok/callback")).trim();
const TIKTOK_SCOPES = String(process.env.TIKTOK_SCOPES || "user.info.basic,video.publish").trim();

const vods = new Map();
const oauthStates = new Map();
const publishJobs = new Map();
const publishHistory = new Map();
const clipLibrary = new Map();

const DATA_DIR = path.join(__dirname, "data");
const TOKEN_FILE = path.join(DATA_DIR, "tiktok-tokens.json");

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(JSON.stringify(data));
}

function page(res, title, content) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(`<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} - ClipManiaLatam</title>
<style>
body{font-family:Arial,sans-serif;max-width:900px;margin:30px auto;padding:20px;background:#111;color:#eee;line-height:1.6}
h1,h2{color:#fff}a{color:#7db7ff}.box{background:#1d1d1d;padding:25px;border-radius:15px}
nav{margin-bottom:25px}.ok{color:#70e070}.warn{color:#ffd166}
button{background:#fff;color:#111;border:0;padding:12px 18px;border-radius:10px;font-weight:bold}
code{background:#222;padding:3px 6px;border-radius:5px}
</style></head><body>
<nav><a href="/">Inicio</a> | <a href="/panel">Panel</a> | <a href="/tiktok">TikTok</a> | <a href="/terminos">Términos</a> | <a href="/privacidad">Privacidad</a></nav>
<div class="box">${content}</div></body></html>`);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Solicitud demasiado grande"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, maxAge = 600) {
  res.setHeader("Set-Cookie", `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`);
}

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function loadTokens() {
  try {
    ensureDataDir();
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  ensureDataDir();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

let tiktokTokens = loadTokens();

function tiktokConfigured() {
  return Boolean(TIKTOK_CLIENT_KEY && TIKTOK_CLIENT_SECRET && TIKTOK_REDIRECT_URI);
}

async function tiktokRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { response, data };
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY,
    client_secret: TIKTOK_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: TIKTOK_REDIRECT_URI
  });
  const result = await tiktokRequest("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!result.response.ok || result.data.error) {
    throw new Error(result.data.error_description || result.data.error || "No se pudo obtener el token de TikTok");
  }
  tiktokTokens = {
    access_token: result.data.access_token,
    refresh_token: result.data.refresh_token,
    open_id: result.data.open_id,
    expires_at: Date.now() + Number(result.data.expires_in || 86400) * 1000,
    refresh_expires_at: Date.now() + Number(result.data.refresh_expires_in || 31536000) * 1000,
    scope: result.data.scope || TIKTOK_SCOPES
  };
  saveTokens(tiktokTokens);
  return tiktokTokens;
}

async function refreshTikTokToken() {
  if (!tiktokTokens?.refresh_token) throw new Error("TikTok no está autorizado");
  const body = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY,
    client_secret: TIKTOK_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: tiktokTokens.refresh_token
  });
  const result = await tiktokRequest("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!result.response.ok || result.data.error) {
    throw new Error(result.data.error_description || result.data.error || "No se pudo renovar el token de TikTok");
  }
  tiktokTokens = {
    ...tiktokTokens,
    access_token: result.data.access_token,
    refresh_token: result.data.refresh_token || tiktokTokens.refresh_token,
    expires_at: Date.now() + Number(result.data.expires_in || 86400) * 1000
  };
  saveTokens(tiktokTokens);
  return tiktokTokens;
}

async function getAccessToken() {
  if (!tiktokTokens?.access_token) throw new Error("TikTok no está conectado");
  if (tiktokTokens.expires_at && Date.now() > tiktokTokens.expires_at - 120000) {
    await refreshTikTokToken();
  }
  return tiktokTokens.access_token;
}

async function creatorInfo() {
  const token = await getAccessToken();
  let result = await tiktokRequest("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8"
    },
    body: "{}"
  });
  if (result.response.status === 401 && tiktokTokens.refresh_token) {
    await refreshTikTokToken();
    result = await tiktokRequest("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tiktokTokens.access_token}`,
        "Content-Type": "application/json; charset=UTF-8"
      },
      body: "{}"
    });
  }
  if (!result.response.ok || result.data.error?.code && result.data.error.code !== "ok") {
    throw new Error(result.data.error?.message || "No se pudo consultar el creador de TikTok");
  }
  return result.data;
}

async function publishToTikTok({ videoUrl, title, privacyLevel, disableComment, disableDuet, disableStitch, brandContentToggle, brandOrganicToggle }) {
  const info = await creatorInfo();
  const allowed = info.data?.privacy_level_options || [];
  if (!privacyLevel) {
    throw new Error("Debes seleccionar manualmente un nivel de privacidad de TikTok");
  }
  const privacy = privacyLevel;
  if (!allowed.includes(privacy)) {
    throw new Error("El nivel de privacidad no está permitido por la cuenta de TikTok");
  }

  const token = await getAccessToken();
  const payload = {
    post_info: {
      title: String(title || "").slice(0, 2200),
      privacy_level: privacy,
      disable_comment: Boolean(disableComment),
      disable_duet: Boolean(disableDuet),
      disable_stitch: Boolean(disableStitch),
      brand_content_toggle: Boolean(brandContentToggle),
      brand_organic_toggle: Boolean(brandOrganicToggle)
    },
    source_info: {
      source: "PULL_FROM_URL",
      video_url: videoUrl
    }
  };

  const result = await tiktokRequest("https://open.tiktokapis.com/v2/post/publish/video/init/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify(payload)
  });

  if (!result.response.ok || result.data.error?.code && result.data.error.code !== "ok") {
    const e = result.data.error || {};
    const detail = JSON.stringify({
      http_status: result.response.status,
      code: e.code || null,
      message: e.message || null,
      log_id: e.log_id || null
    });
    let message = e.message || e.code || "TikTok rechazó la publicación";
    if (e.code === "unaudited_client_can_only_post_to_private_accounts") {
      message = "TikTok bloqueó la publicación pública porque la aplicación todavía no ha pasado la auditoría de TikTok. La integración funciona, pero la visibilidad pública seguirá restringida hasta que TikTok apruebe el cliente.";
    } else if (e.code === "privacy_level_option_mismatch") {
      message = "La privacidad seleccionada no coincide con las opciones actuales de la cuenta de TikTok. Actualiza la página y vuelve a seleccionar una opción.";
    }
    const error = new Error(message);
    error.tiktok = detail;
    throw error;
  }
  return result.data;
}

async function publishVideoFileToTikTok(filePath, mimeType, { title, privacyLevel, disableComment, disableDuet, disableStitch, brandContentToggle, brandOrganicToggle }) {
  const info = await creatorInfo();
  const allowed = info.data?.privacy_level_options || [];
  if (!privacyLevel) throw new Error("Debes seleccionar un nivel de privacidad");
  if (!allowed.includes(privacyLevel)) {
    throw new Error("El nivel de privacidad no está permitido por la cuenta de TikTok");
  }

  const stat = await fs.promises.stat(filePath);
  const videoSize = stat.size;
  if (!videoSize) throw new Error("El archivo de video está vacío");
  if (videoSize > 4 * 1024 * 1024 * 1024) throw new Error("El video supera el máximo de 4 GB");

  // TikTok acepta un archivo completo si mide hasta 64,000,000 bytes.
  // Para archivos mayores usamos bloques de 10,000,000 bytes.
  // Usamos los tamaños decimales documentados por TikTok para evitar
  // rechazos de `chunk_size` por diferencias entre MB y MiB.
  const chunkSize = videoSize <= 64_000_000 ? videoSize : 10_000_000;
  const totalChunkCount = Math.ceil(videoSize / chunkSize);

  const token = await getAccessToken();
  const initPayload = {
    post_info: {
      title: String(title || "").slice(0, 2200),
      privacy_level: privacyLevel,
      disable_comment: Boolean(disableComment),
      disable_duet: Boolean(disableDuet),
      disable_stitch: Boolean(disableStitch),
      brand_content_toggle: Boolean(brandContentToggle),
      brand_organic_toggle: Boolean(brandOrganicToggle)
    },
    source_info: {
      source: "FILE_UPLOAD",
      video_size: videoSize,
      chunk_size: chunkSize,
      total_chunk_count: totalChunkCount
    }
  };

  const init = await tiktokRequest("https://open.tiktokapis.com/v2/post/publish/video/init/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify(initPayload)
  });

  if (!init.response.ok || init.data.error?.code && init.data.error.code !== "ok") {
    const e = init.data.error || {};
    const detail = JSON.stringify({
      http_status: init.response.status,
      code: e.code || null,
      message: e.message || null,
      log_id: e.log_id || null
    });
    const error = new Error(e.message || e.code || "TikTok rechazó el inicio de la publicación");
    error.tiktok = detail;
    throw error;
  }

  const publishId = init.data.data?.publish_id;
  const uploadUrl = init.data.data?.upload_url;
  if (!publishId || !uploadUrl) throw new Error("TikTok no devolvió publish_id/upload_url");

  const handle = await fs.promises.open(filePath, "r");
  try {
    let offset = 0;
    for (let index = 0; index < totalChunkCount; index++) {
      const currentSize = Math.min(chunkSize, videoSize - offset);
      const buffer = Buffer.allocUnsafe(currentSize);
      let read = 0;
      while (read < currentSize) {
        const result = await handle.read(buffer, read, currentSize - read, offset + read);
        if (!result.bytesRead) throw new Error("No se pudo leer el archivo de video");
        read += result.bytesRead;
      }

      const lastByte = offset + currentSize - 1;
      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": mimeType,
          "Content-Length": String(currentSize),
          "Content-Range": `bytes ${offset}-${lastByte}/${videoSize}`
        },
        body: buffer
      });
      if (!uploadResponse.ok) {
        const uploadText = await uploadResponse.text();
        throw new Error(`TikTok rechazó el bloque ${index + 1}/${totalChunkCount}: ${uploadText.slice(0, 500)}`);
      }
      offset += currentSize;
    }
  } finally {
    await handle.close();
  }

  const job = {
    createdAt: Date.now(),
    videoUrl: null,
    title: String(title || ""),
    source: "FILE_UPLOAD",
    status: "PROCESSING",
    publishId
  };
  publishJobs.set(publishId, job);
  publishHistory.set(publishId, job);

  return {
    publish_id: publishId,
    upload_complete: true,
    creator: {
      username: info.data?.creator_username || null,
      nickname: info.data?.creator_nickname || null
    }
  };
}

async function publishStatus(publishId) {
  const token = await getAccessToken();
  const result = await tiktokRequest("https://open.tiktokapis.com/v2/post/publish/status/fetch/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify({ publish_id: publishId })
  });
  if (!result.response.ok || result.data.error?.code && result.data.error.code !== "ok") {
    throw new Error(result.data.error?.message || result.data.error?.code || "No se pudo consultar el estado");
  }
  return result.data;
}

async function generateClipsForVod(vod, count = 3, clipDuration = 30) {
  if (!vod?.url) throw new Error("El VOD no tiene una URL.");
  if (!/^https:\/\//i.test(String(vod.url))) throw new Error("La URL del VOD debe ser HTTPS.");
  ensureDataDir();
  const clipsDir = path.join(DATA_DIR, "clips");
  fs.mkdirSync(clipsDir, { recursive: true });
  let durationSec = 0;
  try {
    const info = await ytDlp(vod.url, { getDuration: true, noWarnings: true, skipDownload: true });
    const raw = String(info || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
    const parts = raw.split(":").map(Number);
    if (parts.every(Number.isFinite)) durationSec = parts.length === 3 ? parts[0]*3600 + parts[1]*60 + parts[2] : parts.length === 2 ? parts[0]*60 + parts[1] : parts[0];
  } catch {}
  let directUrl = "";
  try {
    directUrl = String(await ytDlp(vod.url, { getUrl: true, noWarnings: true, format: "best[ext=mp4]/best" })).trim().split(/\r?\n/).filter(Boolean).pop() || "";
  } catch (e) { throw new Error("No se pudo obtener el video del VOD: " + e.message); }
  if (!directUrl) throw new Error("El VOD no devolvió una URL de video reproducible.");
  const safeCount = Math.max(1, Math.min(5, Number(count) || 3));
  const safeDuration = Math.max(10, Math.min(60, Number(clipDuration) || 30));
  let starts = [];
  if (durationSec > safeDuration) {
    const maxStart = Math.max(0, durationSec - safeDuration);
    for (let i=0;i<safeCount;i++) starts.push(Math.round(maxStart * (i/(safeCount-1 || 1))));
  } else {
    for (let i=0;i<safeCount;i++) starts.push(i*safeDuration);
  }
  const created = [];
  for (let i=0;i<starts.length;i++) {
    const clipId = "clip_" + crypto.randomUUID();
    const output = path.join(clipsDir, clipId + ".mp4");
    const start = starts[i];
    try {
      await execFileAsync(ffmpegPath, ["-y","-ss",String(start),"-i",directUrl,"-t",String(safeDuration),"-c","copy","-movflags","+faststart",output], { timeout: 180000, maxBuffer: 1024*1024*4 });
    } catch {
      await execFileAsync(ffmpegPath, ["-y","-ss",String(start),"-i",directUrl,"-t",String(safeDuration),"-c:v","libx264","-preset","veryfast","-c:a","aac","-movflags","+faststart",output], { timeout: 300000, maxBuffer: 1024*1024*4 });
    }
    if (!fs.existsSync(output) || fs.statSync(output).size < 10000) throw new Error("No se pudo crear el clip " + (i+1));
    const clip = {
      id: clipId,
      title: "Clip automático " + (i+1) + " — " + String(vod.title).slice(0,100),
      streamer: String(vod.streamer || "").slice(0,80),
      duration: safeDuration,
      thumbnail: "",
      videoUrl: BASE_URL + "/clip-media/" + encodeURIComponent(clipId),
      sourceVodId: vod.id,
      sourceVodTitle: vod.title,
      startSec: start,
      status: "Pendiente",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      generation: "automatic-candidate"
    };
    clipLibrary.set(clipId, clip);
    created.push(clip);
  }
  vod.clips = Array.isArray(vod.clips) ? vod.clips : [];
  vod.clips.push(...created.map(c => ({ id:c.id, title:c.title, startSec:c.startSec, duration:c.duration, status:c.status, videoUrl:c.videoUrl })));
  vod.status = "clips_generated";
  vod.updatedAt = new Date().toISOString();
  vods.set(vod.id, vod);
  return created;
}

function requireTikTokConfig(res) {
  if (!tiktokConfigured()) {
    json(res, 503, {
      ok: false,
      error: "TikTok no está configurado todavía",
      required_variables: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REDIRECT_URI"]
    });
    return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, BASE_URL);
  const route = parsed.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    });
    return res.end();
  }

  try {
    if (req.method === "GET" && route === "/clips") {
      return page(res, "Biblioteca de Clips", `
        <style>
          .clip-toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}
          .clip-toolbar input,.clip-toolbar select{padding:10px;border-radius:9px;border:1px solid #444;background:#0d0d0d;color:#fff}
          .clip-form{display:grid;grid-template-columns:2fr 1fr 1fr 2fr;gap:10px;background:#151515;border:1px solid #333;border-radius:14px;padding:16px}
          .clip-form input,.clip-form select{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #444;background:#0d0d0d;color:#fff}
          .clip-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:16px;margin-top:20px}
          .clip-card{background:#151515;border:1px solid #333;border-radius:14px;overflow:hidden}
          .clip-thumb{width:100%;height:160px;object-fit:cover;background:#222;display:block}
          .clip-placeholder{height:160px;background:#222;display:flex;align-items:center;justify-content:center;font-size:46px}
          .clip-body{padding:14px}.clip-body h3{margin:0 0 8px}.clip-meta{color:#aaa;font-size:13px;line-height:1.6}
          .clip-status{display:inline-block;padding:5px 9px;border-radius:999px;background:#292929;margin:9px 0}
          .clip-actions{display:flex;gap:7px;flex-wrap:wrap}.clip-actions button{font-size:12px}.clip-actions a{text-decoration:none}
          .clip-summary{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0;color:#bbb;font-size:14px}
          .clip-summary span{background:#151515;border:1px solid #333;border-radius:10px;padding:8px 11px}
          .empty{background:#151515;border:1px dashed #444;border-radius:14px;padding:24px}
          @media(max-width:800px){.clip-form{grid-template-columns:1fr}.clip-toolbar{flex-direction:column;align-items:stretch}}
        </style>
        <h1>📚 Biblioteca de Clips</h1>
        <p>Organiza, revisa y prepara tus clips antes de publicarlos.</p>
        <div class="clip-toolbar">
          <a href="/dashboard"><button>← Panel</button></a>
          <button id="refresh">↻ Actualizar</button>
          <input id="search" type="search" placeholder="🔎 Buscar por título o streamer">
          <select id="filter"><option value="Todos">Todos los estados</option><option value="Pendiente">Pendiente</option><option value="Listo">Listo</option><option value="Publicado">Publicado</option></select>
        </div>
        <div id="summary" class="clip-summary"></div>
        <form id="clipForm" class="clip-form">
          <input id="title" placeholder="Título del clip" required>
          <input id="streamer" placeholder="Streamer">
          <input id="duration" type="number" min="0" placeholder="Duración (s)">
          <input id="thumbnail" placeholder="URL de miniatura (opcional)">
          <input id="videoUrl" placeholder="URL del video (opcional)">
          <select id="status"><option>Pendiente</option><option>Listo</option><option>Publicado</option></select>
          <button type="submit">＋ Guardar clip</button>
        </form>
        <div id="clips" class="clip-grid"><p>Cargando...</p></div>
        <script>
          const esc=v=>String(v??"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
          let allClips=[];
          function filtered(){
            const q=document.getElementById("search").value.trim().toLowerCase();
            const f=document.getElementById("filter").value;
            return allClips.filter(c=>{const text=(c.title+" "+(c.streamer||"")).toLowerCase();return (!q||text.includes(q))&&(f==="Todos"||c.status===f);});
          }
          function render(){
            const box=document.getElementById("clips"),list=filtered(),total=allClips.length;
            const pending=allClips.filter(c=>c.status==="Pendiente").length,ready=allClips.filter(c=>c.status==="Listo").length,published=allClips.filter(c=>c.status==="Publicado").length;
            document.getElementById("summary").innerHTML="<span>🎬 Total: "+total+"</span><span>⏳ Pendientes: "+pending+"</span><span>✅ Listos: "+ready+"</span><span>📤 Publicados: "+published+"</span>";
            if(!list.length){box.innerHTML="<div class='empty'><h3>No hay clips que coincidan</h3><p>Prueba otro texto o cambia el filtro.</p></div>";return;}
            box.innerHTML=list.map(c=>{
              const media=c.videoUrl?"<video class='clip-thumb' controls playsinline preload='metadata' src='"+esc(c.videoUrl)+"'></video>":(c.thumbnail?"<img class='clip-thumb' src='"+esc(c.thumbnail)+"' alt='Miniatura del clip' loading='lazy'>":"<div class='clip-placeholder'>🎞️</div>");
              const publish=c.videoUrl?"<a href='/tiktok/publish'><button>🎬 Publicar</button></a>":"";
              return "<article class='clip-card'>"+media+"<div class='clip-body'><h3>"+esc(c.title)+"</h3><div class='clip-meta'>👤 "+esc(c.streamer||"Sin streamer")+"<br>⏱️ "+(c.duration?esc(c.duration+" s"):"Duración no indicada")+"<br>📅 "+esc(new Date(c.createdAt).toLocaleString("es-CO"))+"</div><div class='clip-status'>"+esc(c.status)+"</div><div class='clip-actions'><button onclick=\"setStatus('"+esc(c.id)+"','Pendiente')\">Pendiente</button><button onclick=\"setStatus('"+esc(c.id)+"','Listo')\">Listo</button><button onclick=\"setStatus('"+esc(c.id)+"','Publicado')\">Publicado</button>"+publish+"<button onclick=\"removeClip('"+esc(c.id)+"')\">Eliminar</button></div></div></article>";
            }).join("");
          }
          async function load(){try{const r=await fetch("/api/clips"),d=await r.json();if(!d.ok)throw new Error(d.error||"No se pudo cargar la biblioteca");allClips=d.clips||[];render();}catch(e){document.getElementById("clips").innerHTML="<div class='empty'><h3>Error</h3><p>"+esc(e.message)+"</p></div>";}}
          async function setStatus(id,status){await fetch("/api/clips/"+encodeURIComponent(id),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status})});load();}
          async function removeClip(id){if(!confirm("¿Eliminar este clip?"))return;await fetch("/api/clips/"+encodeURIComponent(id),{method:"DELETE"});load();}
          document.getElementById("clipForm").addEventListener("submit",async e=>{e.preventDefault();const body={title:document.getElementById("title").value,streamer:document.getElementById("streamer").value,duration:Number(document.getElementById("duration").value||0),thumbnail:document.getElementById("thumbnail").value,videoUrl:document.getElementById("videoUrl").value,status:document.getElementById("status").value};const r=await fetch("/api/clips",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});if(r.ok){e.target.reset();document.getElementById("status").value="Pendiente";load();}else alert("No se pudo guardar el clip.");});
          document.getElementById("search").addEventListener("input",render);document.getElementById("filter").addEventListener("change",render);document.getElementById("refresh").addEventListener("click",load);load();
        </script>
      `);
    }

    if (req.method === "GET" && route === "/dashboard") {
      return page(res, "Panel de ClipManiaLatam", `
        <style>
          .dash-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:18px 0}
          .dash-card{background:#151515;border:1px solid #333;border-radius:14px;padding:18px}
          .dash-card h3{margin:0 0 8px}.dash-value{font-size:28px;font-weight:800}
          .dash-ok{color:#70e070}.dash-warn{color:#ffd166}.dash-muted{color:#aaa}
          .dash-actions{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}
          .dash-actions a{text-decoration:none}.dash-table{width:100%;border-collapse:collapse;margin-top:10px}
          .dash-table th,.dash-table td{padding:10px 8px;border-bottom:1px solid #333;text-align:left;font-size:14px}
          .pill{display:inline-block;padding:4px 8px;border-radius:999px;background:#292929}
          @media(max-width:700px){.dash-grid{grid-template-columns:1fr}.dash-table{font-size:13px}}
        </style>
        <h1>Panel de ClipManiaLatam</h1>
        <p class="dash-muted">Centro de control para preparar y publicar contenido de creadores autorizados.</p>
        <div class="dash-grid">
          <div class="dash-card"><h3>TikTok</h3><div id="tiktokStatus" class="dash-value dash-warn">Cargando...</div><p id="tiktokAccount">Consultando cuenta...</p></div>
          <div class="dash-card"><h3>VODs recibidos</h3><div id="vodCount" class="dash-value">—</div><p class="dash-muted">Disponibles en esta sesión.</p></div>
          <div class="dash-card"><h3>Publicaciones</h3><div id="pubCount" class="dash-value">—</div><p class="dash-muted">Historial de esta sesión.</p></div><div class="dash-card"><h3>Clips</h3><div id="clipCount" class="dash-value">—</div><p class="dash-muted">En la biblioteca.</p></div>
        </div>
        <div class="dash-actions">
          <a href="/clips"><button>📚 Biblioteca de Clips</button></a>
          <a href="/tiktok"><button>Administrar TikTok</button></a>
          <a href="/clips"><button>📚 Biblioteca de clips</button></a><a href="/tiktok/publish"><button>🎬 Publicar un clip</button></a>
          <button id="refresh">↻ Actualizar panel</button>
        </div>
        <div id="accountBox" class="dash-card" style="display:none">
          <h2>Cuenta conectada</h2><p id="accountDetails"></p>
        </div>
        <h2>Actividad reciente</h2>
        <div id="activity" class="dash-card"><p>Cargando actividad...</p></div>
        <h2>Próximos módulos</h2>
        <p>Esta base permite añadir biblioteca de clips, estadísticas, programación y publicación en otras plataformas.</p>
        <script>
          const esc=v=>String(v??"").replace(/[&<>"\x27]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",\"":"&quot;","\x27":"&#39;"}[c]));
          async function generateVodClips(id){
            if(!confirm("Generar 3 clips candidatos de 30 segundos de este VOD?")) return;
            try{
              const r=await fetch("/api/vods/"+encodeURIComponent(id)+"/generate-clips",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({count:3,duration:30})});
              const d=await r.json();
              if(!r.ok||!d.ok) throw new Error(d.error||"No se pudieron generar los clips");
              alert("Se generaron "+d.count+" clips y ya están en la Biblioteca.");
              location.reload();
            }catch(e){alert("Error: "+e.message);}
          }
          async function loadDashboard(){
            const activity=document.getElementById("activity");
            try{
              const r=await fetch("/api/dashboard");
              const d=await r.json();
              if(!d.ok) throw new Error(d.error||"No se pudo cargar el panel");
              const t=d.tiktok||{};
              const status=document.getElementById("tiktokStatus");
              status.textContent=t.connected?"Conectado":"No conectado";
              status.className="dash-value "+(t.connected?"dash-ok":"dash-warn");
              document.getElementById("tiktokAccount").textContent=t.creator?.nickname||t.creator?.username||(t.connected?"Cuenta TikTok":"Conecta una cuenta para publicar.");
              document.getElementById("vodCount").textContent=d.vod_count??0;
              document.getElementById("pubCount").textContent=(d.publications||[]).length;
              if(t.creator){
                document.getElementById("accountBox").style.display="block";
                document.getElementById("accountDetails").innerHTML="<strong>Usuario:</strong> "+esc(t.creator.username||"No informado")+"<br><strong>Nombre:</strong> "+esc(t.creator.nickname||"No informado")+"<br><strong>Privacidad:</strong> "+esc((t.creator.privacy_options||[]).join(", ")||"No informada")+"<br><strong>Duración máxima:</strong> "+esc(t.creator.max_video_post_duration_sec?t.creator.max_video_post_duration_sec+" s":"No informada");
              }
              const pubs=d.publications||[]; document.getElementById("clipCount").textContent=d.clip_count??0;
              if(!pubs.length){activity.innerHTML="<p>No hay publicaciones registradas todavía. Publica un clip y aparecerá aquí.</p>";return;}
              activity.innerHTML="<table class=\"dash-table\"><thead><tr><th>Estado</th><th>Contenido</th><th>Publish ID</th><th>Fecha</th></tr></thead><tbody>"+pubs.map(p=>"<tr><td><span class=\"pill\">"+esc(p.status||"PENDIENTE")+"</span></td><td>"+esc(p.title||"Sin título")+"</td><td><code>"+esc(p.publishId||"—")+"</code></td><td>"+esc(new Date(p.createdAt).toLocaleString("es-CO"))+"</td></tr>").join("")+"</tbody></table>";
            }catch(e){activity.innerHTML="<p class=\"dash-warn\">No se pudo cargar el panel: "+esc(e.message)+"</p>";}
          }
          document.getElementById("refresh").addEventListener("click",loadDashboard);
          loadDashboard();
        </script>
      `);
    }
    if (req.method === "GET" && route === "/health") {
      return json(res, 200, {
        ok: true,
        service: "ClipManiaLatam",
        status: "funcionando",
        tiktok_configured: tiktokConfigured(),
        tiktok_connected: Boolean(tiktokTokens?.access_token),
        tiktok_redirect_uri: TIKTOK_REDIRECT_URI
      });
    }

    if (req.method === "GET" && route === "/") {
      return page(res, "ClipManiaLatam", `
        <h1>ClipManiaLatam</h1>
        <p><strong>Herramientas de publicación para creadores autorizados.</strong></p>
        <p>ClipManiaLatam ayuda a creadores y equipos con autorización para preparar videos cortos, revisar su publicación y compartirlos en sus cuentas de redes sociales mediante integraciones oficiales.</p>
        <h2>Cómo funciona</h2>
        <ol>
          <li>El creador conecta su cuenta mediante la autorización oficial de la plataforma.</li>
          <li>Selecciona un video que tiene derecho o autorización para utilizar.</li>
          <li>Revisa la vista previa, caption, privacidad y opciones de interacción.</li>
          <li>Confirma explícitamente la publicación.</li>
          <li>ClipManiaLatam muestra el identificador y estado de la publicación.</li>
        </ol>
        <h2>Publicación en TikTok</h2>
        <p>ClipManiaLatam utiliza la integración oficial de TikTok Content Posting API para que el creador autorizado pueda publicar contenido en su propia cuenta. Las opciones de privacidad se obtienen de TikTok y el usuario debe seleccionarlas antes de publicar.</p>
        <p><a href="/tiktok"><button>Conectar TikTok</button></a> <a href="/dashboard"><button>Abrir panel</button></a></p>
        <h2>Uso responsable del contenido</h2>
        <p>El usuario es responsable de contar con los derechos, permisos o autorización necesarios para cualquier video que publique. ClipManiaLatam no pretende transferir derechos sobre contenido de terceros ni publicar contenido en una cuenta sin autorización del titular.</p>
        <h2>Información legal</h2>
        <p><a href="/terminos">Términos de Servicio</a> &nbsp; | &nbsp; <a href="/privacidad">Política de Privacidad</a></p>
        <p>Última actualización: 30 de septiembre de 2026.</p>
      `);
    }

    if (req.method === "GET" && (route === "/terminos" || route === "/terminos/")) {
      return page(res, "Términos de Servicio", `
        <h1>Términos de Servicio</h1>
        <p><strong>Última actualización: 27 de septiembre de 2026.</strong></p>
        <h2>1. Servicio</h2><p>ClipManiaLatam proporciona herramientas para organizar, preparar y compartir contenido de video para creadores y equipos autorizados.</p>
        <h2>2. Autorización</h2><p>Las conexiones con plataformas externas se realizan mediante sus mecanismos oficiales de autorización. ClipManiaLatam no solicita ni almacena contraseñas de dichas plataformas.</p>
        <h2>3. Contenido</h2><p>El usuario debe contar con los derechos y permisos necesarios sobre el contenido utilizado mediante el servicio.</p>
        <h2>4. Publicación</h2><p>La publicación está sujeta a las reglas y permisos de cada plataforma y al consentimiento del usuario.</p>
        <h2>5. Seguridad</h2><p>Aplicamos medidas razonables para proteger la información procesada.</p>
      `);
    }

    if (req.method === "GET" && (route === "/privacidad" || route === "/privacidad/")) {
      return page(res, "Política de Privacidad", `
        <h1>Política de Privacidad</h1>
        <p><strong>Última actualización: 27 de septiembre de 2026.</strong></p>
        <h2>1. Información procesada</h2><p>ClipManiaLatam puede procesar información necesaria para prestar las funciones solicitadas, incluyendo datos relacionados con cuentas y contenido de video.</p>
        <h2>2. Plataformas externas</h2><p>Cuando el usuario conecta una plataforma mediante autorización oficial, los datos recibidos se utilizan para las funciones autorizadas.</p>
        <h2>3. Contraseñas</h2><p>ClipManiaLatam no solicita ni almacena contraseñas de cuentas de terceros.</p>
        <h2>4. Uso de datos</h2><p>Los datos se utilizan para proporcionar y mantener las funciones solicitadas.</p>
        <h2>5. Seguridad</h2><p>Aplicamos medidas razonables para proteger los datos.</p>
      `);
    }

    if (req.method === "GET" && route === "/tiktokY4wi1FGE9XVbzYMKevge6oCmtXAz0LYb.txt") {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=300"
      });
      return res.end("tiktok-developers-site-verification=Y4wi1FGE9XVbzYMKevge6oCmtXAz0LYb");
    }

    if (req.method === "GET" && route === "/tiktok") {
      if (!tiktokConfigured()) {
        return page(res, "TikTok", `
          <h1>Conectar TikTok</h1>
          <p class="warn">Faltan las credenciales de la aplicación de TikTok.</p>
          <p>Configura <code>TIKTOK_CLIENT_KEY</code> y <code>TIKTOK_CLIENT_SECRET</code> en Railway.</p>
          <p>Redirect URI: <code>${escapeHtml(TIKTOK_REDIRECT_URI)}</code></p>
        `);
      }
      return page(res, "TikTok", `
        <h1>ClipManiaLatam + TikTok</h1>
        <p>${tiktokTokens?.access_token ? '<span class="ok">✓ TikTok conectado</span>' : 'TikTok todavía no está conectado.'}</p>
        ${tiktokTokens?.access_token ? '<p>La cuenta autorizada puede consultarse desde la API y preparar publicaciones.</p>' : '<p><a href="/auth/tiktok"><button>Conectar TikTok</button></a></p>'}
        <p>Redirect URI: <code>${escapeHtml(TIKTOK_REDIRECT_URI)}</code></p>
      `);
    }

    if (req.method === "GET" && route === "/auth/tiktok") {
      if (!requireTikTokConfig(res)) return;
      const state = crypto.randomBytes(32).toString("hex");
      oauthStates.set(state, Date.now() + 10 * 60 * 1000);
      setCookie(res, "tiktok_oauth_state", state, 600);
      const auth = new URL("https://www.tiktok.com/v2/auth/authorize/");
      auth.searchParams.set("client_key", TIKTOK_CLIENT_KEY);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("scope", TIKTOK_SCOPES);
      auth.searchParams.set("redirect_uri", TIKTOK_REDIRECT_URI);
      auth.searchParams.set("state", state);
      res.writeHead(302, { Location: auth.toString() });
      return res.end();
    }

    if (req.method === "GET" && route === "/auth/tiktok/callback") {
      if (!requireTikTokConfig(res)) return;
      const code = parsed.searchParams.get("code");
      const state = parsed.searchParams.get("state");
      const cookieState = parseCookies(req).tiktok_oauth_state;
      const expires = oauthStates.get(state);
      oauthStates.delete(state);
      if (!code || !state || !expires || expires < Date.now() || state !== cookieState) {
        return json(res, 400, { ok: false, error: "OAuth state inválido o expirado" });
      }
      await exchangeCode(code);
      setCookie(res, "tiktok_oauth_state", "", 0);
      res.writeHead(302, { Location: "/tiktok?connected=1" });
      return res.end();
    }

    if (req.method === "GET" && route === "/tiktok/publish") {
      if (!requireTikTokConfig(res)) return;
      if (!tiktokTokens?.access_token) {
        return page(res, "Publicar en TikTok", `
          <h1>Publicar en TikTok</h1>
          <p class="warn">Primero conecta TikTok.</p>
          <p><a href="/tiktok"><button>Conectar TikTok</button></a></p>
        `);
      }
      let info;
      try { info = await creatorInfo(); } catch (error) {
        return page(res, "Publicar en TikTok", `<h1>Publicar en TikTok</h1><p class="warn">${escapeHtml(error.message)}</p>`);
      }
      const d = info.data || {};
      const options = Array.isArray(d.privacy_level_options) ? d.privacy_level_options : [];
      const duration = Number(d.max_video_post_duration_sec || 0);
      return page(res, "Publicar en TikTok", `
        <h1>Publicar video en TikTok</h1>
        <p><strong>Cuenta:</strong> ${escapeHtml(d.creator_nickname || d.creator_username || "TikTok")}</p>
        <p>Duración máxima informada: ${duration ? duration + " segundos" : "no disponible"}</p>
        <form id="publishForm">
          <p><label>Video<br><input id="video" type="file" accept="video/mp4,video/quicktime,video/webm" required></label></p>
          <p><label>Nombre del creador/streamer<br><input id="streamer" maxlength="80" style="width:100%;box-sizing:border-box;background:#222;color:#eee;border:1px solid #555;border-radius:8px;padding:8px" placeholder="Ej: WestCOL"></label></p>
                    <p><label>Título/caption<br><textarea id="title" maxlength="2200" rows="4" style="width:100%;background:#222;color:#eee;border:1px solid #555;border-radius:8px;padding:8px" placeholder="Escribe el texto para TikTok"></textarea></label></p>
          <p><button id="generateCaption" type="button">✨ Generar caption + hashtags</button></p>
          <p><label>Privacidad<br><select id="privacy" required><option value="">Selecciona una opción</option>${options.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("")}</select></label></p>
          <p>Interacciones (ninguna está activada por defecto):</p>
          <p><label><input id="comment" type="checkbox" ${d.comment_disabled ? "disabled" : ""}> Permitir comentarios</label></p>
          <p><label><input id="duet" type="checkbox" ${d.duet_disabled ? "disabled" : ""}> Permitir Duet</label></p>
          <p><label><input id="stitch" type="checkbox" ${d.stitch_disabled ? "disabled" : ""}> Permitir Stitch</label></p>
          <p><strong>Vista previa</strong></p>
          <video id="preview" controls playsinline style="width:100%;max-height:420px;background:#000;border-radius:10px;display:none"></video>
          <p id="durationInfo" class="warn"></p>
          <p><label><input id="commercial" type="checkbox"> Este contenido es comercial</label></p>
          <div id="commercialOptions" style="display:none;margin-left:15px">
            <p><label><input id="brandOrganic" type="checkbox"> Promociona mi propia marca o negocio</label></p>
            <p><label><input id="brandContent" type="checkbox"> Promociona una marca, producto o servicio de terceros</label></p>
          </div>
          <p><label><input id="consent" type="checkbox" required> By posting, you agree to TikTok's Music Usage Confirmation</label></p>
          <button id="submit" type="submit">Publicar en TikTok</button>
        </form>
        <pre id="result" style="white-space:pre-wrap"></pre>
        <script>
          const form=document.getElementById("publishForm");
          const result=document.getElementById("result");
          const submit=document.getElementById("submit");
          const generateCaption=document.getElementById("generateCaption");
          const videoInput=document.getElementById("video");
          const preview=document.getElementById("preview");
          const durationInfo=document.getElementById("durationInfo");
          const commercial=document.getElementById("commercial");
          const commercialOptions=document.getElementById("commercialOptions");
          const maxDuration=${duration || 0};

          videoInput.addEventListener("change",()=>{
            const file=videoInput.files[0];
            if(!file){ preview.style.display="none"; preview.removeAttribute("src"); return; }
            if(preview.src) URL.revokeObjectURL(preview.src);
            preview.src=URL.createObjectURL(file);
            preview.style.display="block";
            preview.onloadedmetadata=()=>{
              const seconds=preview.duration;
              durationInfo.textContent=maxDuration && seconds>maxDuration
                ? "❌ El video dura "+seconds.toFixed(1)+" s y supera el máximo permitido de "+maxDuration+" s."
                : "Duración: "+seconds.toFixed(1)+" s"+(maxDuration ? " / máximo: "+maxDuration+" s" : "");
            };
          });

          commercial.addEventListener("change",()=>{
            commercialOptions.style.display=commercial.checked ? "block" : "none";
          });

          function show(message){
            result.textContent=String(message||"");
          }

          async function readJsonResponse(response){
            const raw=await response.text();
            let data;
            try{ data=JSON.parse(raw); }
            catch{ data={ok:false,error:"El servidor devolvió una respuesta que no es JSON.",http_status:response.status,raw:raw.slice(0,1000)}; }
            if(!response.ok && data.ok!==false) data.ok=false;
            if(!response.ok) data.http_status=response.status;
            return data;
          }


          function makeCaption(){
            const streamer=document.getElementById("streamer").value.trim();
            const file=document.getElementById("video").files[0];
            const existing=document.getElementById("title").value.trim();
            const base=existing || (file ? file.name.replace(/\\.[^.]+$/,"").replace(/[_-]+/g," ").trim() : "Momento épico del directo");
            const cleanStreamer=streamer.replace(/[^\\p{L}\\p{N} _-]/gu,"").trim();
            const tags=["#ClipMania","#Gaming","#Directo","#Viral","#ParaTi"];
            if(cleanStreamer){
              const tag=cleanStreamer.replace(/\\s+/g,"");
              if(tag) tags.splice(1,0,"#"+tag);
            }
            const caption=(cleanStreamer ? cleanStreamer+" — " : "")+base+" 🔥\\n\\n"+tags.join(" ");
            document.getElementById("title").value=caption.slice(0,2200);
          }

          generateCaption.addEventListener("click",makeCaption);

          async function checkPublishStatus(publishId){
            for(let i=1;i<=18;i++){
              show("⏳ TikTok recibió la solicitud. Consultando estado ("+i+"/18)...\\n\\npublish_id: "+publishId);
              await new Promise(resolve=>setTimeout(resolve,5000));
              const sr=await fetch("/api/tiktok/publish/status",{
                method:"POST",
                headers:{"Content-Type":"application/json"},
                body:JSON.stringify({publish_id:publishId})
              });
              const sd=await readJsonResponse(sr);
              const status=sd?.data?.status || sd?.status || null;
              show(JSON.stringify(sd,null,2)+"\\n\\nEstado detectado: "+(status||"pendiente"));
              if(status==="PUBLISH_COMPLETE"){
                show("✅ PUBLICADO EN TIKTOK\\n\\n"+JSON.stringify(sd,null,2));
                return;
              }
              if(status==="FAILED"){
                show("❌ TIKTOK RECHAZÓ O FALLÓ LA PUBLICACIÓN\\n\\n"+JSON.stringify(sd,null,2));
                return;
              }
            }
            show("⚠️ TikTok aceptó el envío, pero todavía no confirmó el resultado después de 90 segundos.\\n\\nEl publish_id es: "+publishId+"\\n\\n"+result.textContent);
          }

          form.addEventListener("submit",async(e)=>{
            e.preventDefault();
            const file=document.getElementById("video").files[0];
            const privacy=document.getElementById("privacy").value;
            if(!file){show("❌ Selecciona un video.");return;}
            if(!privacy){show("❌ Selecciona el nivel de privacidad.");return;}
            if(!document.getElementById("consent").checked){show("❌ Confirma que quieres enviar el video.");return;}
            if(file.size>4*1024*1024*1024){show("❌ El video supera 4 GB.");return;}
            if(maxDuration && Number.isFinite(preview.duration) && preview.duration>maxDuration){
              show("❌ El video supera la duración máxima permitida por TikTok ("+maxDuration+" s).");
              return;
            }

            submit.disabled=true;
            submit.textContent="Enviando...";
            show("📤 Preparando envío de "+file.name+" ("+(file.size/1024/1024).toFixed(1)+" MB) a TikTok...");

            const qs=new URLSearchParams({
              title:document.getElementById("title").value,
              privacy_level:privacy,
              disable_comment:String(!document.getElementById("comment").checked),
              disable_duet:String(!document.getElementById("duet").checked),
              disable_stitch:String(!document.getElementById("stitch").checked),
              brand_content_toggle:String(commercial.checked && document.getElementById("brandContent").checked),
              brand_organic_toggle:String(commercial.checked && document.getElementById("brandOrganic").checked)
            });

            try{
              const r=await fetch("/api/tiktok/publish-file?"+qs.toString(),{
                method:"POST",
                headers:{"Content-Type":file.type||"video/mp4","X-File-Name":encodeURIComponent(file.name)},
                body:file
              });
              const data=await readJsonResponse(r);

              if(!data.ok){
                show("❌ NO SE ENVIÓ A TIKTOK\\n\\n"+JSON.stringify(data,null,2));
                return;
              }

              const publishId=data.publish_id;
              show("✅ TikTok aceptó el envío inicial.\\n\\npublish_id: "+(publishId||"no devuelto")+"\\n\\n"+JSON.stringify(data,null,2));

              if(publishId) await checkPublishStatus(publishId);
              else show("⚠️ El servidor respondió correctamente, pero TikTok no devolvió publish_id. No se puede confirmar la publicación.");
            }catch(err){
              show("❌ ERROR DE CONEXIÓN O DEL NAVEGADOR\\n\\n"+err.message);
            }finally{
              submit.disabled=false;
              submit.textContent="Publicar en TikTok";
            }
          });
        </script>
      `);
    }

    if (req.method === "GET" && route === "/panel") {
      const vodList = Array.from(vods.values()).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const connected = Boolean(tiktokTokens?.access_token);
      const published = vodList.filter(v => Array.isArray(v.clips) && v.clips.some(cl => cl.status === "published")).length;
      const ready = vodList.filter(v => Array.isArray(v.clips) && v.clips.length > 0).length;
      return page(res, "Panel de ClipManiaLatam", `
        <style>
          .dashboard{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:20px 0}
          .card{background:#151515;border:1px solid #2b2b2b;border-radius:14px;padding:18px}
          .metric{font-size:28px;font-weight:800;margin-top:5px}
          .muted{color:#aaa;font-size:14px}
          .actions{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}
          .action{display:inline-block;background:#fff;color:#111;text-decoration:none;padding:11px 15px;border-radius:10px;font-weight:700}
          .action.secondary{background:#292929;color:#fff}
          .status{display:inline-flex;align-items:center;gap:7px;padding:7px 10px;border-radius:999px;background:#202020}
          .dot{width:9px;height:9px;border-radius:50%;background:#777}
          .dot.ok{background:#70e070}
          table{width:100%;border-collapse:collapse;margin-top:12px}
          th,td{text-align:left;padding:10px 7px;border-bottom:1px solid #292929}
          @media(max-width:760px){.dashboard{grid-template-columns:repeat(2,minmax(0,1fr))}}
          @media(max-width:480px){.dashboard{grid-template-columns:1fr}}
        </style>
        <h1>Panel de ClipManiaLatam</h1>
        <p class="muted">Centro de control para preparar contenido y revisar el estado de las integraciones.</p>

        <div class="dashboard">
          <div class="card"><div class="muted">VOD recibidos</div><div class="metric">${vodList.length}</div></div>
          <div class="card"><div class="muted">VOD con clips</div><div class="metric">${ready}</div></div>
          <div class="card"><div class="muted">VOD con clips publicados</div><div class="metric">${published}</div></div>
          <div class="card"><div class="muted">TikTok</div><div class="metric" style="font-size:20px">${connected ? "Conectado" : "No conectado"}</div></div>
        </div>

        <div class="card">
          <h2>Acciones rápidas</h2>
          <div class="actions">
            <a class="action" href="/tiktok">Conectar / revisar TikTok</a>
            <a class="action secondary" href="/tiktok/publish">Publicar un video</a>
            <a class="action secondary" href="/api/vods">Ver API de VODs</a>
          </div>
        </div>

        <div class="card" style="margin-top:14px">
          <h2>Flujo de trabajo</h2>
          <p><span class="status"><span class="dot ok"></span> 1. Recibir VOD</span></p>
          <p><span class="status"><span class="dot"></span> 2. Seleccionar o generar clips</span></p>
          <p><span class="status"><span class="dot"></span> 3. Revisar video, caption y privacidad</span></p>
          <p><span class="status"><span class="dot"></span> 4. Publicar con autorización del creador</span></p>
        </div>

        <div class="card" style="margin-top:14px">
          <h2>VOD recientes</h2>
          ${vodList.length ? `
            <table>
              <thead><tr><th>Título</th><th>Creador</th><th>Estado</th><th>Fecha</th></tr></thead>
              <tbody>
                ${vodList.slice(0,10).map(v => `
                  <tr>
                    <td>${escapeHtml(v.title)}</td>
                    <td>${escapeHtml(v.streamer || "—")}</td>
                    <td>${escapeHtml(v.status || "received")}<br><button onclick="generateVodClips('${escapeHtml(v.id)}')">🎬 Generar 3 clips</button></td>
                    <td>${escapeHtml(new Date(v.createdAt).toLocaleString("es-CO"))}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          ` : `<p class="muted">Todavía no hay VOD registrados.</p>`}
        </div>

        <div class="card" style="margin-top:14px">
          <h2>Próximas mejoras</h2>
          <ul>
            <li>Generación automática de clips a partir de VOD autorizados.</li>
            <li>Subtítulos y formato vertical para contenido corto.</li>
            <li>Historial de publicaciones y estados.</li>
            <li>Preparación para estadísticas y otras plataformas.</li>
          </ul>
        </div>
      `);
    }

    if (req.method === "GET" && route === "/api/clips") {
      return json(res, 200, {
        ok: true,
        clips: Array.from(clipLibrary.values())
          .sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))
      });
    }

    if (req.method === "POST" && route === "/api/clips") {
      const body = await readJson(req);
      const id = body.id || `clip_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      const clip = {
        id,
        title: String(body.title || "Clip sin título").slice(0, 160),
        streamer: String(body.streamer || "").slice(0, 80),
        duration: Number(body.duration || 0),
        thumbnail: String(body.thumbnail || "").slice(0, 2000),
        videoUrl: String(body.videoUrl || "").slice(0, 2000),
        status: ["Pendiente","Listo","Publicado"].includes(body.status) ? body.status : "Pendiente",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      clipLibrary.set(id, clip);
      return json(res, 201, { ok: true, clip });
    }

    if (req.method === "PATCH" && route.startsWith("/api/clips/")) {
      const id = decodeURIComponent(route.slice("/api/clips/".length));
      const existing = clipLibrary.get(id);
      if (!existing) return json(res, 404, { ok: false, error: "Clip no encontrado" });
      const body = await readJson(req);
      const nextStatus = ["Pendiente","Listo","Publicado"].includes(body.status) ? body.status : existing.status;
      const updated = {
        ...existing,
        title: body.title !== undefined ? String(body.title).slice(0,160) : existing.title,
        streamer: body.streamer !== undefined ? String(body.streamer).slice(0,80) : existing.streamer,
        duration: body.duration !== undefined ? Number(body.duration || 0) : existing.duration,
        thumbnail: body.thumbnail !== undefined ? String(body.thumbnail).slice(0,2000) : existing.thumbnail,
        videoUrl: body.videoUrl !== undefined ? String(body.videoUrl).slice(0,2000) : existing.videoUrl,
        status: nextStatus,
        updatedAt: new Date().toISOString()
      };
      clipLibrary.set(id, updated);
      return json(res, 200, { ok: true, clip: updated });
    }

    if (req.method === "DELETE" && route.startsWith("/api/clips/")) {
      const id = decodeURIComponent(route.slice("/api/clips/".length));
      if (!clipLibrary.has(id)) return json(res, 404, { ok: false, error: "Clip no encontrado" });
      clipLibrary.delete(id);
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && route === "/api/dashboard") {
      let creator = null;
      let creatorError = null;
      if (tiktokTokens?.access_token && tiktokConfigured()) {
        try { const info = await creatorInfo(); creator = info.data || null; }
        catch (error) { creatorError = error.message; }
      }
      return json(res, 200, {
        ok: true,
        tiktok: {
          configured: tiktokConfigured(),
          connected: Boolean(tiktokTokens?.access_token),
          creator: creator ? {
            username: creator.creator_username || null,
            nickname: creator.creator_nickname || null,
            privacy_options: creator.privacy_level_options || [],
            max_video_post_duration_sec: creator.max_video_post_duration_sec || null
          } : null,
          error: creatorError
        },
        vod_count: vods.size,
        publications: Array.from(publishHistory.values()).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,50),
        clip_count: clipLibrary.size
      });
    }
    if (req.method === "GET" && route === "/api/tiktok/status") {
      return json(res, 200, {
        ok: true,
        configured: tiktokConfigured(),
        connected: Boolean(tiktokTokens?.access_token),
        open_id: tiktokTokens?.open_id || null,
        scope: tiktokTokens?.scope || null,
        token_expires_at: tiktokTokens?.expires_at || null
      });
    }

    if (req.method === "GET" && route === "/api/tiktok/creator") {
      if (!requireTikTokConfig(res)) return;
      return json(res, 200, { ok: true, ...(await creatorInfo()) });
    }

    if (req.method === "POST" && route === "/api/tiktok/publish-file") {
      if (!requireTikTokConfig(res)) return;
      if (!tiktokTokens?.access_token) return json(res, 401, { ok: false, error: "TikTok no está conectado" });

      const contentType = String(req.headers["content-type"] || "").split(";")[0].toLowerCase();
      const allowedTypes = new Set(["video/mp4", "video/quicktime", "video/webm"]);
      if (!allowedTypes.has(contentType)) {
        return json(res, 400, { ok: false, error: "Formato no permitido. Usa MP4, MOV o WebM." });
      }

      const maxBytes = 4 * 1024 * 1024 * 1024;
      const declared = Number(req.headers["content-length"] || 0);
      if (declared && declared > maxBytes) {
        return json(res, 413, { ok: false, error: "El video supera 4 GB" });
      }

      ensureDataDir();
      const tempDir = path.join(DATA_DIR, "tmp");
      fs.mkdirSync(tempDir, { recursive: true });
      const tempPath = path.join(tempDir, crypto.randomUUID() + ".video");

      let received = 0;
      const out = fs.createWriteStream(tempPath, { flags: "wx" });
      try {
        req.on("data", chunk => {
          received += chunk.length;
          if (received > maxBytes) req.destroy();
        });
        await pipeline(req, out);
        if (!received) return json(res, 400, { ok: false, error: "No se recibió ningún video" });

        const q = parsed.searchParams;
        const title = q.get("title") || "";
        const privacyLevel = q.get("privacy_level") || "";
        const result = await publishVideoFileToTikTok(tempPath, contentType, {
          title,
          privacyLevel,
          disableComment: q.get("disable_comment") === "true",
          disableDuet: q.get("disable_duet") === "true",
          disableStitch: q.get("disable_stitch") === "true",
          brandContentToggle: q.get("brand_content_toggle") === "true",
          brandOrganicToggle: q.get("brand_organic_toggle") === "true"
        });
        return json(res, 200, { ok: true, ...result });
      } finally {
        try { fs.unlinkSync(tempPath); } catch {}
      }
    }

    if (req.method === "POST" && route === "/api/tiktok/publish") {
      if (!requireTikTokConfig(res)) return;
      const data = JSON.parse(await readBody(req) || "{}");
      let videoUrl = data.video_url;
      if (data.vod_id) {
        const vod = vods.get(String(data.vod_id));
        if (!vod) return json(res, 404, { ok: false, error: "VOD no encontrado" });
        videoUrl = BASE_URL + "/media/" + encodeURIComponent(vod.id);
        data.title = data.title || vod.title;
      }
      if (!videoUrl || !/^https:\/\//i.test(videoUrl)) {
        return json(res, 400, { ok: false, error: "video_url HTTPS o vod_id es obligatorio" });
      }
      const result = await publishToTikTok({
        videoUrl,
        title: data.title || "",
        privacyLevel: data.privacy_level,
        disableComment: data.disable_comment,
        disableDuet: data.disable_duet,
        disableStitch: data.disable_stitch,
        brandContentToggle: data.brand_content_toggle,
        brandOrganicToggle: data.brand_organic_toggle
      });
      const publishId = result.data?.publish_id;
      if (publishId) {
        const job = { createdAt: Date.now(), videoUrl, title: data.title || "", status: "PROCESSING", publishId };
        publishJobs.set(publishId, job);
        publishHistory.set(publishId, job);
      }
      return json(res, 200, { ok: true, ...result, publish_id: publishId || null });
    }

    if (req.method === "POST" && route === "/api/tiktok/publish/status") {
      if (!requireTikTokConfig(res)) return;
      const data = JSON.parse(await readBody(req) || "{}");
      if (!data.publish_id) return json(res, 400, { ok: false, error: "publish_id es obligatorio" });
      const statusData = await publishStatus(data.publish_id);
      const status = statusData.data?.status || statusData.status || "PENDIENTE";
      const existing = publishHistory.get(data.publish_id);
      if (existing) {
        const updated = { ...existing, status, updatedAt: Date.now() };
        publishHistory.set(data.publish_id, updated);
        publishJobs.set(data.publish_id, updated);
      }
      return json(res, 200, { ok: true, ...statusData });
    }

    if (req.method === "GET" && route === "/api/vods") {
      return json(res, 200, { ok: true, count: vods.size, vods: Array.from(vods.values()) });
    }

    if (req.method === "POST" && route === "/api/vods") {
      const data = JSON.parse(await readBody(req) || "{}");
      if (!data.title) return json(res, 400, { ok: false, error: "Falta el título del VOD" });
      const id = crypto.randomUUID();
      const vod = {
        id,
        title: String(data.title),
        url: data.url || null,
        source: data.source || "unknown",
        streamer: data.streamer || null,
        status: "received",
        clips: [],
        createdAt: new Date().toISOString()
      };
      vods.set(id, vod);
      return json(res, 201, { ok: true, vod });
    }

    if (req.method === "POST" && route.startsWith("/api/vods/") && route.endsWith("/generate-clips")) {
      const id = decodeURIComponent(route.slice("/api/vods/".length, -"/generate-clips".length));
      const vod = vods.get(id);
      if (!vod) return json(res, 404, { ok:false, error:"VOD no encontrado" });
      try {
        const body = await readJson(req);
        const clips = await generateClipsForVod(vod, body.count, body.duration);
        return json(res, 201, { ok:true, count:clips.length, clips });
      } catch (error) {
        return json(res, 500, { ok:false, error:error.message || "No se pudieron generar los clips" });
      }
    }

    if (req.method === "GET" && route.startsWith("/api/vods/")) {
      const id = route.split("/")[3];
      const vod = vods.get(id);
      if (!vod) return json(res, 404, { ok: false, error: "VOD no encontrado" });
      return json(res, 200, { ok: true, vod });
    }

    if (req.method === "GET" && route.startsWith("/clip-media/")) {
      const id = decodeURIComponent(route.slice("/clip-media/".length));
      if (!/^clip_[a-f0-9-]+$/.test(id)) return json(res, 400, {ok:false,error:"Clip inválido"});
      const file = path.join(DATA_DIR, "clips", id + ".mp4");
      if (!fs.existsSync(file)) return json(res, 404, {ok:false,error:"Archivo de clip no encontrado"});
      res.writeHead(200, {"Content-Type":"video/mp4","Cache-Control":"public, max-age=3600","Accept-Ranges":"bytes"});
      return pipeline(fs.createReadStream(file), res);
    }

    if (req.method === "GET" && route.startsWith("/media/")) {
      const id = decodeURIComponent(route.slice("/media/".length));
      const vod = vods.get(id);
      if (!vod?.url) return json(res, 404, { ok: false, error: "El VOD no tiene URL pública" });
      const upstream = await fetch(vod.url, { redirect: "manual" });
      if (upstream.status >= 300 && upstream.status < 400) {
        return json(res, 502, { ok: false, error: "La URL del video redirige; usa una URL final HTTPS" });
      }
      if (!upstream.ok || !upstream.body) return json(res, 502, { ok: false, error: "No se pudo obtener el video original" });
      res.writeHead(200, {
        "Content-Type": upstream.headers.get("content-type") || "video/mp4",
        "Cache-Control": "public, max-age=3600",
        "Accept-Ranges": "bytes"
      });
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once("drain", resolve));
      }
      return res.end();
    }

    return json(res, 404, { ok: false, error: "Ruta no encontrada" });
  } catch (error) {
    console.error(error);
    const payload = { ok: false, error: error.message || "Error interno" };
    if (error.tiktok) {
      try { payload.tiktok = JSON.parse(error.tiktok); } catch { payload.tiktok = error.tiktok; }
    }
    return json(res, 500, payload);
  }
});

server.listen(PORT, () => {
  console.log("ClipManiaLatam activo en el puerto " + PORT);
});
