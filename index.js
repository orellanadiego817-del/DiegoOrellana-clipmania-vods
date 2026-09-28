const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

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
  const privacy = privacyLevel || allowed[0] || "SELF_ONLY";
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
    throw new Error(result.data.error?.message || result.data.error?.code || "TikTok rechazó la publicación");
  }
  return result.data;
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
    return json(res, 500, { ok: false, error: error.message || "Error interno" });
  }
});

server.listen(PORT, () => {
  console.log("ClipManiaLatam activo en el puerto " + PORT);
});
