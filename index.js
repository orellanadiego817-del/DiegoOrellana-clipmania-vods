const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;

// JobStore en memoria: almacena jobs por UUID
const jobs = new Map();

function generateJobId() {
  return crypto.randomUUID();
}

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // GET /health (legacy endpoint)
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({
      ok: true,
      service: "ClipManiaLatam",
      status: "funcionando"
    }));
    return;
  }

  // GET / (legacy endpoint)
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200);
    res.end(JSON.stringify({
      service: "ClipManiaLatam",
      message: "Sistema de VODs activo"
    }));
    return;
  }

  // GET /api/vods (legacy endpoint)
  if (req.method === "GET" && req.url === "/api/vods") {
    res.writeHead(200);
    res.end(JSON.stringify({
      vods: []
    }));
    return;
  }

  // POST /api/v1/vods - Registra un VOD y devuelve jobId
  if (req.method === "POST" && req.url === "/api/v1/vods") {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        const payload = JSON.parse(body);

        if (!payload.url) {
          res.writeHead(400);
          res.end(JSON.stringify({
            error: "Campo 'url' requerido"
          }));
          return;
        }

        // Crear job
        const jobId = generateJobId();
        jobs.set(jobId, {
          id: jobId,
          url: payload.url,
          status: "pending",
          createdAt: new Date().toISOString()
        });

        res.writeHead(202);
        res.end(JSON.stringify({
          ok: true,
          jobId: jobId,
          message: "VOD registrado para procesamiento"
        }));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({
          error: "JSON inválido"
        }));
      }
    });

    return;
  }

  // GET /api/v1/jobs/:id - Consulta estado de un job
  const jobMatchv1 = req.url.match(/^\/api\/v1\/jobs\/([a-f0-9\-]+)$/);
  if (req.method === "GET" && jobMatchv1) {
    const jobId = jobMatchv1[1];
    const job = jobs.get(jobId);

    if (!job) {
      res.writeHead(404);
      res.end(JSON.stringify({
        error: "Job no encontrado"
      }));
      return;
    }

    res.writeHead(200);
    res.end(JSON.stringify(job));
    return;
  }

  // 404
  res.writeHead(404);
  res.end(JSON.stringify({
    error: "Ruta no encontrada"
  }));
});

server.listen(PORT, () => {
  console.log(`ClipManiaLatam activo en el puerto ${PORT}`);
});

