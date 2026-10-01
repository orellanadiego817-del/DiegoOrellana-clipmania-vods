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
const SESSION_SECRET = String(process.env.SESSION_SECRET || TIKTOK_CLIENT_SECRET || "").trim();
const KICK_CLIENT_ID = String(process.env.KICK_CLIENT_ID || "").trim();
const KICK_CLIENT_SECRET = String(process.env.KICK_CLIENT_SECRET || "").trim();
const KICK_POLL_MS = Math.max(60000, Number(process.env.KICK_POLL_MS || 180000));

const vods = new Map();
const oauthStates = new Map();
const adminSessions = new Map();
const publishJobs = new Map();
const publishHistory = new Map();
const clipLibrary = new Map();
const kickStreamers = new Map();
const kickJobs = new Map();
let kickAppToken = null;

const DATA_DIR = path.join(__dirname, "data");
const TOKEN_FILE = path.join(DATA_DIR, "tiktok-tokens.json");
const STATE_FILE = path.join(DATA_DIR, "clipmania-state.json");

function serializeState() {
  return {
    vods: Array.from(vods.values()),
    clips: Array.from(clipLibrary.values()),
    publications: Array.from(publishHistory.values()),
    kickStreamers: Array.from(kickStreamers.values()),
    kickJobs: Array.from(kickJobs.values())
  };
}

function saveState() {
  try {
    ensureDataDir();
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(serializeState(), null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch (error) {
    console.error("No se pudo guardar el estado:", error.message);
  }
}

function loadState() {
  try {
    ensureDataDir();
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    for (const vod of Array.isArray(data.vods) ? data.vods : []) if (vod?.id) vods.set(vod.id, vod);
    for (const clip of Array.isArray(data.clips) ? data.clips : []) if (clip?.id) clipLibrary.set(clip.id, clip);
    for (const pub of Array.isArray(data.publications) ? data.publications : []) if (pub?.publishId) publishHistory.set(pub.publishId, pub);
    for (const streamer of Array.isArray(data.kickStreamers) ? data.kickStreamers : []) if (streamer?.id) kickStreamers.set(streamer.id, streamer);
    for (const job of Array.isArray(data.kickJobs) ? data.kickJobs : []) if (job?.id) kickJobs.set(job.id, job);
  } catch {}
}

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
<nav><a href="/">Inicio</a> | <a href="/panel">Panel</a> | <a href="/vods">VODs</a> | <a href="/kick">KICK Auto</a> | <a href="/clips">Clips</a> | <a href="/tiktok">TikTok</a> | <a href="/terminos">Términos</a> | <a href="/privacidad">Privacidad</a> | <a href="/logout">Salir</a></nav>
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

function readJson(req) {
  return readBody(req).then(body => JSON.parse(body || "{}"));
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
loadState();


function kickConfigured() {
  return Boolean(KICK_CLIENT_ID && KICK_CLIENT_SECRET);
}

async function kickToken() {
  if (kickAppToken?.access_token && kickAppToken.expires_at > Date.now() + 60000) return kickAppToken.access_token;
  if (!kickConfigured()) throw new Error("KICK no está configurado: faltan KICK_CLIENT_ID y KICK_CLIENT_SECRET.");
  const body = new URLSearchParams({ grant_type:"client_credentials", client_id:KICK_CLIENT_ID, client_secret:KICK_CLIENT_SECRET });
  const response = await fetch("https://id.kick.com/oauth/token", { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body });
  const data = await response.json().catch(()=>({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || "No se pudo autenticar contra KICK.");
  kickAppToken={access_token:data.access_token,expires_at:Date.now()+Number(data.expires_in||3600)*1000};
  return kickAppToken.access_token;
}

async function kickApi(pathname) {
  const token=await kickToken();
  const response=await fetch("https://api.kick.com"+pathname,{headers:{Authorization:"Bearer "+token,Accept:"application/json"}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error("KICK API "+response.status+": "+(data.message||data.error||"respuesta no válida"));
  return data;
}

async function kickResolveStreamer(slug) {
  const data=await kickApi("/public/v1/channels?slug="+encodeURIComponent(slug));
  const channel=Array.isArray(data.data)?data.data[0]:null;
  if(!channel) throw new Error("No se encontró el canal de KICK: "+slug);
  return channel;
}

async function kickIsLive(userId) {
  const data=await kickApi("/public/v1/users/livestreams?user_id="+encodeURIComponent(userId));
  return Array.isArray(data.data)?data.data[0]||null:null;
}

function extractKickManifestUrls(text) {
  const source=String(text||"")
    .replaceAll("\\u0026","&")
    .replaceAll("\\/","/")
    .replaceAll("&amp;","&");
  const patterns=[
    new RegExp("https?:\\/\\/(?:web|stream)\\.kick\\.com\\/[^" + "'\\s<>]+?\\.m3u8(?:\\?[^" + "'\\s<>]*)?","gi"),
    new RegExp("https?:\\/\\/[^" + "'\\s<>]+\\.m3u8(?:\\?[^" + "'\\s<>]*)?","gi")
  ];
  return [...new Set(patterns.flatMap(re=>[...source.matchAll(re)].map(m=>m[0])))];
}

async function discoverKickVodUrl(slug) {
  const headers={
    "User-Agent":"Mozilla/5.0 (compatible; ClipManiaLatam/1.0)",
    "Accept":"text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
  };
  const response=await fetch("https://kick.com/"+encodeURIComponent(slug)+"/videos",{headers});
  if(!response.ok) throw new Error("KICK videos respondió "+response.status);
  const html=await response.text();

  const manifests=extractKickManifestUrls(html);
  if(manifests.length){
    console.log("KICK VOD: manifiesto encontrado para",slug);
    return manifests[0];
  }

  const ids=[...html.matchAll(/\/videos\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi)].map(m=>m[1]);
  const unique=[...new Set(ids)];
  if(!unique.length) throw new Error("El VOD todavía no aparece en KICK.");
  return "https://kick.com/"+slug+"/videos/"+unique[0];
}

async function discoverKickPlaybackUrl(vodUrl) {
  try {
    const response=await fetch(vodUrl,{headers:{"User-Agent":"Mozilla/5.0 (compatible; ClipManiaLatam/1.0)","Accept":"text/html,application/xhtml+xml"}});
    if(!response.ok) return null;
    const html=await response.text();
    return extractKickManifestUrls(html)[0]||null;
  } catch {
    return null;
  }
}

async function downloadKickVod(vodUrl,output) {
  ensureDataDir();
  fs.mkdirSync(path.dirname(output),{recursive:true});
  const dir=path.dirname(output);
  const base=path.basename(output,".mp4");
  const tempPrefix=base+".download";
  const cleanup=()=>{
    for(const name of fs.readdirSync(dir)){
      if(name.startsWith(tempPrefix+".")) { try{fs.unlinkSync(path.join(dir,name));}catch{} }
    }
  };
  cleanup();

  const download=async source=>{
    await ytDlp(source,{
      output:path.join(dir,tempPrefix+".%(ext)s"),
      format:"best[ext=mp4]/best",
      mergeOutputFormat:"mp4",
      noWarnings:true,
      noProgress:true,
      retries:3,
      fragmentRetries:5,
      concurrentFragments:2,
      addHeader:["Referer: https://kick.com/","User-Agent: Mozilla/5.0 (compatible; ClipManiaLatam/1.0)"]
    });
    const candidates=fs.readdirSync(dir)
      .filter(name=>name.startsWith(tempPrefix+".") && !name.endsWith(".part"))
      .map(name=>path.join(dir,name))
      .filter(file=>{try{const s=fs.statSync(file);return s.isFile()&&s.size>=10000;}catch{return false;}})
      .sort((a,b)=>fs.statSync(b).size-fs.statSync(a).size);
    if(!candidates.length) throw new Error("Descarga vacía.");
    fs.renameSync(candidates[0],output);
    for(const file of candidates.slice(1)){try{fs.unlinkSync(file);}catch{}}
  };

  try {
    await download(vodUrl);
  } catch(error) {
    cleanup();
    const fallback=await discoverKickPlaybackUrl(vodUrl);
    if(!fallback) throw error;
    console.log("KICK VOD: usando manifiesto de reproducción como respaldo.");
    await download(fallback);
  } finally {
    cleanup();
  }
}

async function generateClipsFromLocalFile(vod,inputFile,count=3,clipDuration=30) {
  ensureDataDir();
  const clipsDir=path.join(DATA_DIR,"clips"); fs.mkdirSync(clipsDir,{recursive:true});
  const safeCount=Math.max(1,Math.min(5,Number(count)||3));
  const safeDuration=Math.max(10,Math.min(60,Number(clipDuration)||30));
  let durationSec=0;
  try{
    const probe=await execFileAsync(ffmpegPath,["-i",inputFile],{timeout:60000,maxBuffer:1024*1024*2});
    const m=String(probe.stderr||"").match(/Duration:\s+(\d+):(\d+):(\d+\.\d+)/);
    if(m) durationSec=Number(m[1])*3600+Number(m[2])*60+Number(m[3]);
  }catch{}
  const starts=[]; const maxStart=Math.max(0,durationSec-safeDuration);
  for(let i=0;i<safeCount;i++) starts.push(Math.round(maxStart*(i/(safeCount-1||1))));
  const created=[];
  for(let i=0;i<starts.length;i++){
    const id="clip_"+crypto.randomUUID(), output=path.join(clipsDir,id+".mp4");
    await execFileAsync(ffmpegPath,["-y","-ss",String(starts[i]),"-i",inputFile,"-t",String(safeDuration),"-c:v","libx264","-preset","veryfast","-c:a","aac","-movflags","+faststart",output],{timeout:300000,maxBuffer:1024*1024*2});
    const clip={id,title:"Clip automático "+(i+1)+" — "+String(vod.title).slice(0,100),streamer:String(vod.streamer||"").slice(0,80),duration:safeDuration,thumbnail:"",videoUrl:BASE_URL+"/clip-media/"+encodeURIComponent(id),sourceVodId:vod.id,sourceVodTitle:vod.title,startSec:starts[i],status:"Pendiente",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),generation:"kick-automatic-candidate",publishRequired:true};
    clipLibrary.set(id,clip); created.push(clip);
  }
  vod.clips=[...(Array.isArray(vod.clips)?vod.clips:[]),...created.map(x=>({id:x.id,title:x.title,startSec:x.startSec,duration:x.duration,status:x.status,videoUrl:x.videoUrl}))];
  vod.status="clips_generated"; vod.updatedAt=new Date().toISOString(); vod.localFile=inputFile; vods.set(vod.id,vod); saveState(); return created;
}

async function processKickJob(job) {
  if(job.status==="completed"||job.status==="waiting_publish") return;
  job.updatedAt=Date.now();
  try{
    if(job.status==="waiting_vod"||!job.vodUrl){job.status="finding_vod";job.vodUrl=await discoverKickVodUrl(job.slug);}
    const vodId="kick_"+crypto.createHash("sha1").update(job.vodUrl).digest("hex").slice(0,20);
    let vod=vods.get(vodId);
    if(!vod){
      const file=path.join(DATA_DIR,"vods",vodId+".mp4");
      job.status="downloading"; job.updatedAt=Date.now(); saveState(); await downloadKickVod(job.vodUrl,file);
      vod={id:vodId,title:job.title||("VOD de "+job.slug),url:job.vodUrl,source:"kick-auto",streamer:job.slug,rightsConfirmed:job.rightsConfirmed===true,status:"downloaded",clips:[],localFile:file,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      vods.set(vodId,vod); job.vodId=vodId; saveState();
    }else{
      job.vodId=vodId;
    }
    if(!Array.isArray(vod.clips)||vod.clips.length===0){
      if(!vod.localFile||!fs.existsSync(vod.localFile)) throw new Error("El VOD existe pero falta el archivo local para generar clips.");
      job.status="generating_clips"; job.updatedAt=Date.now(); saveState();
      await generateClipsFromLocalFile(vod,vod.localFile,3,30);
    }
    job.status="waiting_publish"; job.updatedAt=Date.now(); saveState();
  }catch(error){
    job.attempts=(job.attempts||0)+1; job.lastError=String(error.message||error);
    job.status=job.attempts>=8?"failed":"waiting_vod"; job.nextTryAt=Date.now()+Math.min(60*60*1000,Math.max(5*60*1000,job.attempts*5*60*1000)); job.updatedAt=Date.now(); saveState();
  }
}

async function runKickMonitor() {
  if(!kickConfigured()||!kickStreamers.size) return;
  console.log("KICK monitor: comprobando "+kickStreamers.size+" streamer(s).");
  for(const streamer of kickStreamers.values()){
    if(!streamer.enabled) continue;
    try{
      const live=await kickIsLive(streamer.userId), wasLive=Boolean(streamer.live);
      streamer.live=Boolean(live); streamer.lastCheckedAt=Date.now(); streamer.viewerCount=live?.viewer_count||live?.viewerCount||0; streamer.lastLive=live||streamer.lastLive||null;
      if(wasLive!==Boolean(live)) console.log("KICK monitor:",streamer.slug,Boolean(live)?"EN VIVO":"OFFLINE");
      if(wasLive&&!live){
        const duplicate=[...kickJobs.values()].some(j=>j.slug===streamer.slug&&j.status!=="completed"&&j.status!=="failed");
        if(!duplicate){const jobId="kickjob_"+crypto.randomUUID(); kickJobs.set(jobId,{id:jobId,slug:streamer.slug,title:streamer.lastLive?.session_title||("VOD "+streamer.slug),status:"waiting_vod",rightsConfirmed:streamer.rightsConfirmed===true,createdAt:Date.now(),updatedAt:Date.now()}); console.log("KICK monitor: VOD pendiente para",streamer.slug,jobId);}
      }
      saveState();
    }catch(error){streamer.lastError=error.message;streamer.lastCheckedAt=Date.now();console.error("KICK monitor error:",streamer.slug,error.message);saveState();}
  }
  for(const job of kickJobs.values()) if((job.status==="waiting_vod"||job.status==="finding_vod")&&(!job.nextTryAt||job.nextTryAt<=Date.now())) {
    console.log("KICK job:",job.id,job.slug,job.status,"intento",Number(job.attempts||0)+1);
    await processKickJob(job);
  }
}

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


function cleanupPublishedClip(clipId) {
  const clip=clipLibrary.get(clipId); if(!clip) return;
  try{fs.unlinkSync(path.join(DATA_DIR,"clips",clip.id+".mp4"))}catch{}
  clip.status="Publicado"; clip.videoUrl=null; clip.updatedAt=new Date().toISOString(); clipLibrary.set(clip.id,clip);
  const vod=clip.sourceVodId?vods.get(clip.sourceVodId):null;
  if(vod&&Array.isArray(vod.clips)){
    const item=vod.clips.find(x=>x.id===clip.id); if(item)item.status="Publicado";
    const pending=Array.from(clipLibrary.values()).some(x=>x.sourceVodId===vod.id&&x.status!=="Publicado");
    if(!pending){try{if(vod.localFile)fs.unlinkSync(vod.localFile)}catch{};try{if(vod.localFile)fs.unlinkSync(vod.localFile+".part")}catch{};vod.localFile=null;vod.status="completed";vod.updatedAt=new Date().toISOString();vods.set(vod.id,vod);}
  }
  saveState();
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

function signAdminSession(payload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
}
function createAdminSession(res) {
  if (!SESSION_SECRET) return;
  const expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payload = expires + "." + crypto.randomBytes(24).toString("hex");
  const token = payload + "." + signAdminSession(payload);
  adminSessions.set(token, expires);
  setCookie(res, "clipmania_session", token, 7 * 24 * 60 * 60);
}
function isAdmin(req) {
  const token = parseCookies(req).clipmania_session;
  if (!token || !SESSION_SECRET) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const expires = Number(parts[0]);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  const payload = parts[0] + "." + parts[1];
  const expected = signAdminSession(payload);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected))) return false;
  } catch { return false; }
  adminSessions.set(token, expires);
  return true;
}
function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  json(res, 401, { ok:false, error:"Sesión requerida. Conecta tu cuenta de TikTok para continuar." });
  return false;
}
function logoutAdmin(req, res) {
  const token = parseCookies(req).clipmania_session;
  if (token) adminSessions.delete(token);
  setCookie(res, "clipmania_session", "", 0);
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

  if (req.method === "GET" && route === "/kick/callback") {
    const code = parsed.searchParams.get("code");
    const error = parsed.searchParams.get("error");
    if (error) {
      return page(res, "KICK — autorización", `<h1>Autorización KICK</h1><p class="warn">KICK devolvió un error: ${escapeHtml(error)}</p><p><a href="/kick"><button>Volver a KICK Auto</button></a></p>`);
    }
    return page(res, "KICK — autorización", `<h1>KICK conectado</h1><p>${code ? "KICK devolvió el código de autorización correctamente." : "Esta dirección está lista para recibir la redirección de KICK."}</p><p>ClipManiaLatam utiliza esta ruta como callback oficial de la integración.</p><p><a href="/kick"><button>Volver a KICK Auto</button></a></p>`);
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    });
    return res.end();
  }

  try {
    if (req.method === "GET" && route === "/logout") {
      logoutAdmin(req, res);
      res.writeHead(302, { Location: "/" });
      return res.end();
    }

    if (req.method === "GET" && route === "/vods") {
      if (!isAdmin(req)) return page(res, "Acceso requerido", '<h1>🔐 Acceso requerido</h1><p>Conecta TikTok para acceder a la gestión de VODs y clips.</p><p><a href="/tiktok"><button>Conectar TikTok</button></a></p>');
      const list = Array.from(vods.values()).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
      return page(res, "VODs - ClipManiaLatam", `
        <style>
          .vod-toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}
          .vod-form{display:grid;grid-template-columns:2fr 1fr 2fr;gap:10px;background:#151515;border:1px solid #333;border-radius:14px;padding:16px}
          .vod-form input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #444;background:#0d0d0d;color:#fff}
          .vod-list{display:grid;gap:14px;margin-top:20px}.vod-card{background:#151515;border:1px solid #333;border-radius:14px;padding:16px}
          .vod-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.muted{color:#aaa}.ok{color:#70e070}.warn{color:#ffd166}
          @media(max-width:700px){.vod-form{grid-template-columns:1fr}}
        </style>
        <h1>🎥 VODs</h1>
        <p>Registra únicamente VODs que tú o el creador autorizado tienen permiso para utilizar.</p>
        <div class="vod-toolbar"><a href="/panel"><button>← Panel</button></a><a href="/clips"><button>📚 Biblioteca</button></a></div>
        <form id="vodForm" class="vod-form">
          <input id="vodTitle" required placeholder="Título del VOD">
          <input id="vodStreamer" placeholder="Streamer">
          <input id="vodUrl" required type="url" placeholder="URL HTTPS del VOD">
          <label style="grid-column:1/-1"><input id="rights" type="checkbox" required> Confirmo que tengo los derechos o autorización para usar este VOD y crear clips.</label>
          <button type="submit">＋ Registrar VOD</button>
        </form>
        <div id="vodList" class="vod-list">
          ${list.length ? list.map(v=>`
            <article class="vod-card">
              <h3>${escapeHtml(v.title)}</h3>
              <p class="muted">👤 ${escapeHtml(v.streamer||"Sin streamer")} · Estado: ${escapeHtml(v.status||"received")}</p>
              <p><a href="${escapeHtml(v.url||"#")}" target="_blank" rel="noopener">Abrir VOD original</a></p>
              <p class="${v.rightsConfirmed?"ok":"warn"}">${v.rightsConfirmed?"✓ Autorización confirmada":"⚠ Falta confirmar autorización"}</p>
              <div class="vod-actions">
                <button onclick="generateClips('${escapeHtml(v.id)}')">🎬 Generar candidatos</button>
                <a href="/clips"><button type="button">📚 Ver biblioteca</button></a>
                <button onclick="removeVod('${escapeHtml(v.id)}')">🗑️ Eliminar</button>
              </div>
            </article>
          `).join("") : '<div class="vod-card"><h3>No hay VODs</h3><p class="muted">Registra tu primer VOD autorizado arriba.</p></div>'}
        </div>
        <script>
          async function generateClips(id){
            const count=Number(prompt("¿Cuántos clips candidatos? (1-5)","3")||3);
            const duration=Number(prompt("Duración de cada clip en segundos (10-60)","30")||30);
            const r=await fetch("/api/vods/"+encodeURIComponent(id)+"/generate-clips",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({count,duration})});
            const d=await r.json(); if(!r.ok||!d.ok){alert(d.error||"No se pudieron generar clips");return;}
            alert("Se generaron "+d.count+" clips candidatos."); location.reload();
          }
          async function removeVod(id){
            if(!confirm("¿Eliminar este VOD y su referencia de la biblioteca?"))return;
            const r=await fetch("/api/vods/"+encodeURIComponent(id),{method:"DELETE"});
            const d=await r.json(); if(!r.ok||!d.ok){alert(d.error||"No se pudo eliminar");return;} location.reload();
          }
          document.getElementById("vodForm").addEventListener("submit",async e=>{
            e.preventDefault();
            const body={title:document.getElementById("vodTitle").value,streamer:document.getElementById("vodStreamer").value,url:document.getElementById("vodUrl").value,rights_confirmed:document.getElementById("rights").checked};
            const r=await fetch("/api/vods",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
            const d=await r.json(); if(!r.ok||!d.ok){alert(d.error||"No se pudo registrar");return;} e.target.reset(); location.reload();
          });
        </script>
      `);
    }

    if (req.method === "GET" && route === "/clips") {
      if (!isAdmin(req)) return page(res, "Acceso requerido", '<h1>🔐 Acceso requerido</h1><p>Conecta TikTok para acceder a la biblioteca de clips.</p><p><a href="/tiktok"><button>Conectar TikTok</button></a></p>');
      return page(res, "Biblioteca de Clips", `
        <style>
          .clip-toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}.clip-toolbar input,.clip-toolbar select{padding:10px;border-radius:9px;border:1px solid #444;background:#0d0d0d;color:#fff}
          .generator{background:#151515;border:1px solid #333;border-radius:14px;padding:16px;margin:18px 0}.generator-row{display:flex;gap:10px;flex-wrap:wrap}.generator select{flex:1;min-width:220px;padding:11px;background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:9px}
          .clip-form{display:grid;grid-template-columns:2fr 1fr 1fr 2fr;gap:10px;background:#151515;border:1px solid #333;border-radius:14px;padding:16px}.clip-form input,.clip-form select{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #444;background:#0d0d0d;color:#fff}
          .clip-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:16px;margin-top:20px}.clip-card{background:#151515;border:1px solid #333;border-radius:14px;overflow:hidden}.clip-thumb{width:100%;height:160px;object-fit:cover;background:#222;display:block}.clip-placeholder{height:160px;background:#222;display:flex;align-items:center;justify-content:center;font-size:46px}.clip-body{padding:14px}.clip-body h3{margin:0 0 8px}.clip-meta{color:#aaa;font-size:13px;line-height:1.6}.clip-status{display:inline-block;padding:5px 9px;border-radius:999px;background:#292929;margin:9px 0}.clip-actions{display:flex;gap:7px;flex-wrap:wrap}.clip-actions button{font-size:12px}.clip-actions a{text-decoration:none}.clip-summary{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0;color:#bbb;font-size:14px}.clip-summary span{background:#151515;border:1px solid #333;border-radius:10px;padding:8px 11px}.empty{background:#151515;border:1px dashed #444;border-radius:14px;padding:24px}.muted{color:#aaa}
          @media(max-width:800px){.clip-form{grid-template-columns:1fr}.clip-toolbar{flex-direction:column;align-items:stretch}}
        </style>
        <h1>📚 Biblioteca de Clips</h1><p>Organiza, revisa y prepara tus clips antes de publicarlos.</p>
        <div class="generator"><h2>🤖 Generar clips desde un VOD</h2><p class="muted">Selecciona un VOD autorizado. ClipMania creará hasta 3 candidatos de 30 segundos y los guardará automáticamente en esta biblioteca.</p><div class="generator-row"><select id="vodSelect"><option value="">Cargando VODs...</option></select><button id="generate">⚡ Generar clips</button></div><p id="generateResult" class="muted"></p></div>
        <div class="clip-toolbar"><a href="/dashboard"><button>← Panel</button></a><button id="refresh">↻ Actualizar</button><input id="search" type="search" placeholder="🔎 Buscar por título o streamer"><select id="filter"><option value="Todos">Todos los estados</option><option value="Pendiente">Pendiente</option><option value="Listo">Listo</option><option value="Publicado">Publicado</option></select></div>
        <div id="summary" class="clip-summary"></div>
        <form id="clipForm" class="clip-form"><input id="title" placeholder="Título del clip" required><input id="streamer" placeholder="Streamer"><input id="duration" type="number" min="0" placeholder="Duración (s)"><input id="thumbnail" placeholder="URL de miniatura (opcional)"><input id="videoUrl" placeholder="URL del video (opcional)"><select id="status"><option>Pendiente</option><option>Listo</option><option>Publicado</option></select><button type="submit">＋ Guardar clip</button></form>
        <div id="clips" class="clip-grid"><p>Cargando...</p></div>
        <script>
          const esc=v=>String(v??"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); let allClips=[];
          function filtered(){const q=document.getElementById("search").value.trim().toLowerCase(),f=document.getElementById("filter").value;return allClips.filter(c=>{const t=(c.title+" "+(c.streamer||"")).toLowerCase();return(!q||t.includes(q))&&(f==="Todos"||c.status===f);});}
          function render(){const box=document.getElementById("clips"),list=filtered(),total=allClips.length,pending=allClips.filter(c=>c.status==="Pendiente").length,ready=allClips.filter(c=>c.status==="Listo").length,published=allClips.filter(c=>c.status==="Publicado").length;document.getElementById("summary").innerHTML="<span>🎬 Total: "+total+"</span><span>⏳ Pendientes: "+pending+"</span><span>✅ Listos: "+ready+"</span><span>📤 Publicados: "+published+"</span>";if(!list.length){box.innerHTML="<div class='empty'><h3>No hay clips que coincidan</h3><p>Prueba otro texto o cambia el filtro.</p></div>";return;}box.innerHTML=list.map(c=>{const media=c.videoUrl?"<video class='clip-thumb' controls playsinline preload='metadata' src='"+esc(c.videoUrl)+"'></video>":(c.thumbnail?"<img class='clip-thumb' src='"+esc(c.thumbnail)+"' alt='Miniatura' loading='lazy'>":"<div class='clip-placeholder'>🎞️</div>");const publish=c.videoUrl?"<a href='/tiktok/publish?clip_id="+encodeURIComponent(c.id)+"'><button>🎬 Publicar</button></a>":"";return "<article class='clip-card'>"+media+"<div class='clip-body'><h3>"+esc(c.title)+"</h3><div class='clip-meta'>👤 "+esc(c.streamer||"Sin streamer")+"<br>⏱️ "+(c.duration?esc(c.duration+" s"):"Duración no indicada")+"<br>📅 "+esc(new Date(c.createdAt).toLocaleString("es-CO"))+"</div><div class='clip-status'>"+esc(c.status)+"</div><div class='clip-actions'><button onclick=\"setStatus('"+esc(c.id)+"','Pendiente')\">Pendiente</button><button onclick=\"setStatus('"+esc(c.id)+"','Listo')\">Listo</button><button onclick=\"setStatus('"+esc(c.id)+"','Publicado')\">Publicado</button>"+publish+"<button onclick=\"removeClip('"+esc(c.id)+"')\">Eliminar</button></div></div></article>";}).join("");}
          async function load(){try{const[cr,vr]=await Promise.all([fetch("/api/clips"),fetch("/api/vods")]),d=await cr.json(),v=await vr.json();if(!d.ok)throw new Error(d.error||"No se pudo cargar la biblioteca");allClips=d.clips||[];const select=document.getElementById("vodSelect"),vs=v.vods||[];select.innerHTML=vs.length?'<option value="">Selecciona un VOD autorizado</option>'+vs.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.title)+' — '+esc(x.streamer||"sin streamer")+'</option>').join(""):'<option value="">No hay VODs disponibles</option>';render();}catch(e){document.getElementById("clips").innerHTML="<div class='empty'><h3>Error</h3><p>"+esc(e.message)+"</p></div>";}}
          document.getElementById("generate").addEventListener("click",async()=>{const id=document.getElementById("vodSelect").value,out=document.getElementById("generateResult"),btn=document.getElementById("generate");if(!id){out.textContent="❌ Selecciona un VOD.";return;}btn.disabled=true;btn.textContent="Generando...";out.textContent="⏳ Procesando el VOD. Puede tardar varios minutos...";try{const r=await fetch("/api/vods/"+encodeURIComponent(id)+"/generate-clips",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({count:3,duration:30})}),d=await r.json();if(!d.ok)throw new Error(d.error||"No se pudieron generar los clips");out.textContent="✅ Se generaron "+d.count+" clips y ya están en la biblioteca.";await load();}catch(e){out.textContent="❌ "+e.message;}finally{btn.disabled=false;btn.textContent="⚡ Generar clips";}});
          async function setStatus(id,status){await fetch("/api/clips/"+encodeURIComponent(id),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status})});load();} async function removeClip(id){if(!confirm("¿Eliminar este clip?"))return;await fetch("/api/clips/"+encodeURIComponent(id),{method:"DELETE"});load();}
          document.getElementById("clipForm").addEventListener("submit",async e=>{e.preventDefault();const body={title:document.getElementById("title").value,streamer:document.getElementById("streamer").value,duration:Number(document.getElementById("duration").value||0),thumbnail:document.getElementById("thumbnail").value,videoUrl:document.getElementById("videoUrl").value,status:document.getElementById("status").value};const r=await fetch("/api/clips",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});if(r.ok){e.target.reset();document.getElementById("status").value="Pendiente";load();}else alert("No se pudo guardar el clip.");});document.getElementById("search").addEventListener("input",render);document.getElementById("filter").addEventListener("change",render);document.getElementById("refresh").addEventListener("click",load);load();
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
        tiktok_redirect_uri: TIKTOK_REDIRECT_URI,
        kick_configured: kickConfigured(),
        kick_streamers: kickStreamers.size,
        kick_jobs: kickJobs.size
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
      if (tiktokTokens?.access_token && !isAdmin(req)) createAdminSession(res);
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
      createAdminSession(res);
      setCookie(res, "tiktok_oauth_state", "", 0);
      res.writeHead(302, { Location: "/tiktok?connected=1" });
      return res.end();
    }

    if (req.method === "GET" && route === "/tiktok/publish") {
      if (!isAdmin(req)) return page(res, "Acceso requerido", '<h1>🔐 Acceso requerido</h1><p>Conecta TikTok para acceder a la publicación.</p><p><a href="/auth/tiktok"><button>Conectar TikTok</button></a></p>');
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

            const clipId=new URLSearchParams(location.search).get("clip_id")||"";
          const qs=new URLSearchParams({
              title:document.getElementById("title").value,
              clip_id:clipId,
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
            <a class="action secondary" href="/vods">🎥 Gestionar VODs</a><a class="action secondary" href="/clips">📚 Biblioteca de clips</a>
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
          <h2>Automatización</h2>
          <ul>
            <li>Generación de candidatos de clips desde VOD autorizados.</li>
            <li>Biblioteca con búsqueda, filtros, miniaturas y vista previa.</li>
            <li>Historial de publicaciones y estados de TikTok.</li>
            <li>Base preparada para subtítulos, formato vertical y otras plataformas.</li>
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
      if (!requireAdmin(req, res)) return;
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
      saveState();
      return json(res, 201, { ok: true, clip });
    }

    if (req.method === "PATCH" && route.startsWith("/api/clips/")) {
      if (!requireAdmin(req, res)) return;
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
      saveState();
      return json(res, 200, { ok: true, clip: updated });
    }

    if (req.method === "DELETE" && route.startsWith("/api/clips/")) {
      if (!requireAdmin(req, res)) return;
      const id = decodeURIComponent(route.slice("/api/clips/".length));
      if (!clipLibrary.has(id)) return json(res, 404, { ok: false, error: "Clip no encontrado" });
      clipLibrary.delete(id);
      saveState();
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
      if (!requireAdmin(req, res)) return;
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
        const clipId = q.get("clip_id") || "";
      const result = await publishVideoFileToTikTok(tempPath, contentType, {
          title,
          privacyLevel,
          disableComment: q.get("disable_comment") === "true",
          disableDuet: q.get("disable_duet") === "true",
          disableStitch: q.get("disable_stitch") === "true",
          brandContentToggle: q.get("brand_content_toggle") === "true",
          brandOrganicToggle: q.get("brand_organic_toggle") === "true"
        });
      const publishId = result.publish_id;
      if(publishId){
        const job = publishJobs.get(publishId) || { createdAt:Date.now(), title, source:"FILE_UPLOAD", status:"PROCESSING", publishId };
        job.clipId = clipId || job.clipId || null;
        publishJobs.set(publishId, job);
        publishHistory.set(publishId, job);
        saveState();
      }
      return json(res, 200, { ok: true, ...result });
      } finally {
        try { fs.unlinkSync(tempPath); } catch {}
      }
    }

    if (req.method === "POST" && route === "/api/tiktok/publish") {
      if (!requireAdmin(req, res)) return;
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
        const job = { createdAt: Date.now(), videoUrl, title: data.title || "", status: "PROCESSING", publishId, clipId: data.clip_id ? String(data.clip_id) : null };
        publishJobs.set(publishId, job);
        publishHistory.set(publishId, job);
        saveState();
      }
      return json(res, 200, { ok: true, ...result, publish_id: publishId || null });
    }

    if (req.method === "POST" && route === "/api/tiktok/publish/status") {
      if (!requireAdmin(req, res)) return;
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
        if(status==="PUBLISH_COMPLETE" && existing.clipId) cleanupPublishedClip(existing.clipId);
        saveState();
      }
      return json(res, 200, { ok: true, ...statusData });
    }


    if (req.method === "GET" && route === "/kick") {
      if (!requireAdmin(req,res)) return;
      const rows=Array.from(kickStreamers.values()).map(s=>"<tr><td>"+escapeHtml(s.slug)+"</td><td>"+escapeHtml(s.region||"")+"</td><td>"+(s.live?"🟢 EN VIVO":"⚪ OFFLINE")+"</td><td>"+escapeHtml(String(s.viewerCount||0))+"</td><td><button onclick=\"toggleKick('"+escapeHtml(s.id)+"')\">"+(s.enabled?"Desactivar":"Activar")+"</button></td></tr>").join("");
      return page(res,"Monitor KICK","<h1>🎥 Monitor automático de KICK</h1><p>Detecta directos, espera el VOD, descarga, procesa y deja los clips en cola.</p><form id=\"f\"><input name=\"slug\" placeholder=\"usuario de KICK\" required><input name=\"region\" placeholder=\"Región\"><label><input type=\"checkbox\" name=\"rights\" required> Confirmo que tengo autorización para usar este contenido.</label><button>Agregar streamer</button></form><table><tr><th>Streamer</th><th>Región</th><th>Estado</th><th>Viewers</th><th></th></tr>"+rows+"</table><p><a href=\"/panel\">← Panel</a></p><script>f.onsubmit=async(e)=>{e.preventDefault();const d=Object.fromEntries(new FormData(f));const r=await fetch('/api/kick/streamers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:d.slug,region:d.region,rights_confirmed:!!d.rights})});const x=await r.json();if(!x.ok)alert(x.error);else location.reload()};async function toggleKick(id){await fetch('/api/kick/streamers/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:false})});location.reload()}</script>");
    }
    if (req.method === "GET" && route === "/api/kick/status") return json(res,200,{ok:true,configured:kickConfigured(),streamers:Array.from(kickStreamers.values()),jobs:Array.from(kickJobs.values()).sort((a,b)=>b.createdAt-a.createdAt).slice(0,50)});
    if (req.method === "POST" && route === "/api/kick/streamers") {
      if (!requireAdmin(req,res)) return; const data=await readJson(req); if(!data.rights_confirmed)return json(res,400,{ok:false,error:"Debes confirmar que tienes autorización para usar este contenido."});
      const slug=String(data.slug||"").trim().replace(/^https?:\/\/(?:www\.)?kick\.com\//i,"").split(/[/?#]/)[0].toLowerCase(); if(!slug)return json(res,400,{ok:false,error:"Falta el usuario de KICK."});
      try{const channel=await kickResolveStreamer(slug);const userId=Number(channel.user_id||channel.broadcaster_user_id||channel.user?.id);if(!userId)throw new Error("KICK no devolvió el ID del usuario.");const id="kickstream_"+userId;const s={id,slug,region:String(data.region||"").slice(0,60),userId,enabled:true,rightsConfirmed:true,live:false,createdAt:Date.now(),updatedAt:Date.now()};kickStreamers.set(id,s);saveState();return json(res,201,{ok:true,streamer:s});}catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if (req.method === "PATCH" && route.startsWith("/api/kick/streamers/")) {
      if (!requireAdmin(req,res)) return; const id=decodeURIComponent(route.slice("/api/kick/streamers/".length));const s=kickStreamers.get(id);if(!s)return json(res,404,{ok:false,error:"Streamer no encontrado"});const data=await readJson(req);if(data.enabled!==undefined)s.enabled=Boolean(data.enabled);s.updatedAt=Date.now();kickStreamers.set(id,s);saveState();return json(res,200,{ok:true,streamer:s});
    }

    if (req.method === "GET" && route === "/api/vods") {
      return json(res, 200, { ok: true, count: vods.size, vods: Array.from(vods.values()) });
    }

    if (req.method === "POST" && route === "/api/vods") {
      if (!requireAdmin(req, res)) return;
      const data = JSON.parse(await readBody(req) || "{}");
      if (!data.title) return json(res, 400, { ok: false, error: "Falta el título del VOD" });
      const id = crypto.randomUUID();
      if (!data.rights_confirmed) return json(res, 400, { ok:false, error:"Debes confirmar que tienes derechos o autorización para usar este VOD." });
      if (!data.url || !/^https:\/\//i.test(String(data.url))) return json(res, 400, { ok:false, error:"La URL del VOD debe ser HTTPS." });
      const vod = {
        id,
        title: String(data.title).slice(0,200),
        url: String(data.url),
        source: data.source || "manual",
        streamer: String(data.streamer || "").slice(0,80),
        rightsConfirmed: true,
        status: "received",
        clips: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      vods.set(id, vod);
      saveState();
      return json(res, 201, { ok: true, vod });
    }

    if (req.method === "POST" && route.startsWith("/api/vods/") && route.endsWith("/generate-clips")) {
      if (!requireAdmin(req, res)) return;
      const id = decodeURIComponent(route.slice("/api/vods/".length, -"/generate-clips".length));
      const vod = vods.get(id);
      if (!vod) return json(res, 404, { ok:false, error:"VOD no encontrado" });
      try {
        const body = await readJson(req);
        if (!vod.rightsConfirmed) return json(res, 403, { ok:false, error:"Este VOD no tiene confirmación de derechos/autorización." });
        const clips = await generateClipsForVod(vod, body.count, body.duration);
        saveState();
        return json(res, 201, { ok:true, count:clips.length, clips });
      } catch (error) {
        return json(res, 500, { ok:false, error:error.message || "No se pudieron generar los clips" });
      }
    }

    if (req.method === "DELETE" && route.startsWith("/api/vods/")) {
      if (!requireAdmin(req, res)) return;
      const id = decodeURIComponent(route.slice("/api/vods/".length));
      const vod = vods.get(id);
      if (!vod) return json(res, 404, { ok:false, error:"VOD no encontrado" });
      for (const clip of Array.from(clipLibrary.values()).filter(c=>c.sourceVodId===id)) {
        try { fs.unlinkSync(path.join(DATA_DIR,"clips",clip.id+".mp4")); } catch {}
        clipLibrary.delete(clip.id);
      }
      vods.delete(id);
      saveState();
      return json(res,200,{ok:true});
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
  if (kickConfigured()) {
    console.log("KICK monitor activo. Poll cada "+KICK_POLL_MS+" ms. Streamers configurados: "+kickStreamers.size);
    runKickMonitor().catch(e=>console.error("KICK monitor:",e.message));
    setInterval(()=>runKickMonitor().catch(e=>console.error("KICK monitor:",e.message)),KICK_POLL_MS);
  } else console.log("KICK monitor pendiente: configura KICK_CLIENT_ID y KICK_CLIENT_SECRET.");
});
