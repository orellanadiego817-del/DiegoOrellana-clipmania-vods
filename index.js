const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;

// ============================================================================
// Job Abstraction: Persistent-safe in-memory store
// ============================================================================
class JobStore {
  constructor() {
    this.jobs = new Map();
  }

  create(vodUrl, metadata = {}) {
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      vodUrl,
      metadata,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: null,
      error: null
    };
    this.jobs.set(jobId, job);
    return job;
  }

  get(jobId) {
    return this.jobs.get(jobId) || null;
  }

  update(jobId, updates) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    Object.assign(job, updates, { updatedAt: new Date().toISOString() });
    return job;
  }

  list() {
    return Array.from(this.jobs.values());
  }
}

const jobStore = new JobStore();

// ============================================================================
// Utility: Parse JSON request body
// ============================================================================
function parseJSONBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1e6) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// ============================================================================
// Utility: Match URL path with params
// ============================================================================
function matchPath(pathname, pattern) {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  
  if (patternParts.length !== pathParts.length) return null;
  
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// ============================================================================
// Request Handler
// ============================================================================
const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const { method, url } = req;
  const [pathname] = url.split("?");

  try {
    // GET /health
    if (method === "GET" && pathname === "/health") {
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        service: "ClipManiaLatam",
        status: "funcionando"
      }));
      return;
    }

    // GET /
    if (method === "GET" && pathname === "/") {
      res.writeHead(200);
      res.end(JSON.stringify({
        service: "ClipManiaLatam",
        message: "Sistema de VODs activo"
      }));
      return;
    }

    // POST /api/vods (legacy)
    if (method === "POST" && pathname === "/api/vods") {
      const vod = await parseJSONBody(req);
      if (!vod.title) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Falta el título del VOD" }));
        return;
      }
      res.writeHead(201);
      res.end(JSON.stringify({
        ok: true,
        message: "VOD recibido para procesamiento",
        vod: vod
      }));
      return;
    }

    // POST /api/v1/vods (new verified phase)
    if (method === "POST" && pathname === "/api/v1/vods") {
      const payload = await parseJSONBody(req);
      const { vodUrl, title, metadata } = payload;

      if (!vodUrl) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "vodUrl es requerido" }));
        return;
      }

      const job = jobStore.create(vodUrl, {
        title: title || "Sin título",
        ...metadata
      });

      res.writeHead(202);
      res.end(JSON.stringify({
        ok: true,
        message: "VOD registrado para procesamiento",
        jobId: job.id,
        job
      }));
      return;
    }

    // GET /api/v1/jobs/:id (query job status)
    const jobParams = matchPath(pathname, "/api/v1/jobs/:id");
    if (method === "GET" && jobParams) {
      const job = jobStore.get(jobParams.id);
      if (!job) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Job no encontrado" }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, job }));
      return;
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Ruta no encontrada" }));

  } catch (err) {
    res.writeHead(400);
    res.end(JSON.stringify({
      error: err.message || "Error procesando solicitud"
    }));
  }
});

server.listen(PORT, () => {
  console.log(`ClipManiaLatam activo en el puerto ${PORT}`);
});

