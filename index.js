const http = require("http");
const { v4: uuidv4 } = require("uuid");

const PORT = process.env.PORT || 8080;

// In-memory JobStore: minimal, no persistence
const jobStore = new Map();

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // GET /health
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({
      ok: true,
      service: "ClipManiaLatam",
      status: "funcionando"
    }));
    return;
  }

  // GET /
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200);
    res.end(JSON.stringify({
      service: "ClipManiaLatam",
      message: "Sistema de VODs activo"
    }));
    return;
  }

  // POST /api/v1/vods - register VOD and create job
  if (req.method === "POST" && req.url === "/api/v1/vods") {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        const data = JSON.parse(body);

        if (!data.url) {
          res.writeHead(400);
          res.end(JSON.stringify({
            error: "Falta el campo 'url'"
          }));
          return;
        }

        // Create job entry
        const jobId = uuidv4();
        jobStore.set(jobId, {
          id: jobId,
          vodUrl: data.url,
          status: "pending",
          createdAt: new Date().toISOString()
        });

        res.writeHead(201);
        res.end(JSON.stringify({
          ok: true,
          message: "VOD registrado para procesamiento",
          jobId: jobId,
          vodUrl: data.url
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

  // GET /api/v1/jobs/:id - query job status
  if (req.method === "GET" && req.url.startsWith("/api/v1/jobs/")) {
    const jobId = req.url.split("/").pop();

    if (!jobId) {
      res.writeHead(400);
      res.end(JSON.stringify({
        error: "Job ID requerido"
      }));
      return;
    }

    const job = jobStore.get(jobId);
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

  // Legacy POST /api/vods (preserved for compatibility)
  if (req.method === "POST" && req.url === "/api/vods") {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        const vod = JSON.parse(body);

        if (!vod.title) {
          res.writeHead(400);
          res.end(JSON.stringify({
            error: "Falta el título del VOD"
          }));
          return;
        }

        res.writeHead(201);
        res.end(JSON.stringify({
          ok: true,
          message: "VOD recibido para procesamiento",
          vod: vod
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

  res.writeHead(404);
  res.end(JSON.stringify({
    error: "Ruta no encontrada"
  }));
});

server.listen(PORT, () => {
  console.log(`ClipManiaLatam activo en el puerto ${PORT}`);
});

