const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = String(process.env.PUBLIC_BASE_URL || "https://diegoorellana-clipmania-vods-production.up.railway.app").replace(/\/$/, "");
const TIKTOK_CLIENT_KEY = String(process.env.TIKTOK_CLIENT_KEY || "").trim();
const TIKTOK_CLIENT_SECRET = String(process.env.TIKTOK_CLIENT_SECRET || "").trim();
const TIKTOK_REDIRECT_URI = String(process.env.TIKTOK_REDIRECT_URI || (BASE_URL + "/auth/tiktok/callback")).trim();
const TIKTOK_SCOPES = String(process.env.TIKTOK_SCOPES || "user.info.basic,video.publish").trim();

const vods = new Map();
const oauthStates = new Map();
const publishJobs = new Map();

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
<nav><a href="/">Inicio</a> | <a href="/tiktok">TikTok</a> | <a href="/terminos">Términos</a> | <a href="/privacidad">Privacidad</a></nav>
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

async function publishToTikTok({ videoUrl, title, privacyLevel, disableComment, disableDuet, disableStitch }) {
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
      disable_stitch: Boolean(disableStitch)
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

async function publishVideoFileToTikTok(filePath, mimeType, { title, privacyLevel, disableComment, disableDuet, disableStitch }) {
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
      disable_stitch: Boolean(disableStitch)
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

  publishJobs.set(publishId, {
    createdAt: Date.now(),
    videoUrl: null,
    title: String(title || ""),
    source: "FILE_UPLOAD"
  });

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
        <p>Plataforma para organizar, preparar y publicar contenido de video para creadores y equipos autorizados.</p>
        <p><a href="/tiktok">Conectar TikTok</a></p>
        <p><a href="/terminos">Términos de Servicio</a><br><a href="/privacidad">Política de Privacidad</a></p>
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
          <p><label><input id="consent" type="checkbox" required> Confirmo que quiero enviar este video a mi cuenta de TikTok.</label></p>
          <button id="submit" type="submit">Publicar en TikTok</button>
        </form>
        <pre id="result" style="white-space:pre-wrap"></pre>
        <script>
          const form=document.getElementById("publishForm");
          const result=document.getElementById("result");
          const submit=document.getElementById("submit");
          const generateCaption=document.getElementById("generateCaption");

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

            submit.disabled=true;
            submit.textContent="Enviando...";
            show("📤 Preparando envío de "+file.name+" ("+(file.size/1024/1024).toFixed(1)+" MB) a TikTok...");

            const qs=new URLSearchParams({
              title:document.getElementById("title").value,
              privacy_level:privacy,
              disable_comment:String(!document.getElementById("comment").checked),
              disable_duet:String(!document.getElementById("duet").checked),
              disable_stitch:String(!document.getElementById("stitch").checked)
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
          disableStitch: q.get("disable_stitch") === "true"
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
        disableStitch: data.disable_stitch
      });
      const publishId = result.data?.publish_id;
      if (publishId) publishJobs.set(publishId, { createdAt: Date.now(), videoUrl, title: data.title || "" });
      return json(res, 200, { ok: true, ...result, publish_id: publishId || null });
    }

    if (req.method === "POST" && route === "/api/tiktok/publish/status") {
      if (!requireTikTokConfig(res)) return;
      const data = JSON.parse(await readBody(req) || "{}");
      if (!data.publish_id) return json(res, 400, { ok: false, error: "publish_id es obligatorio" });
      return json(res, 200, { ok: true, ...(await publishStatus(data.publish_id)) });
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

    if (req.method === "GET" && route.startsWith("/api/vods/")) {
      const id = route.split("/")[3];
      const vod = vods.get(id);
      if (!vod) return json(res, 404, { ok: false, error: "VOD no encontrado" });
      return json(res, 200, { ok: true, vod });
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
