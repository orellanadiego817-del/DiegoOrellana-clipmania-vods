const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

// Cola temporal de VODs.
// Más adelante la conectaremos al procesamiento real de clips.
const vods = new Map();

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });

  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      // Protección básica contra solicitudes demasiado grandes.
      if (body.length > 1024 * 1024) {
        reject(new Error("Solicitud demasiado grande"));
        req.destroy();
      }
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Permitir OPTIONS para futuras conexiones desde paneles/web.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  // ---------------------------------------
  // HEALTH CHECK
  // ---------------------------------------
  if (req.method === "GET" && req.url === "/health") {
    return sendJSON(res, 200, {
      ok: true,
      service: "ClipManiaLatam",
      status: "funcionando",
      time: new Date().toISOString()
    });
  }

  // ---------------------------------------
  // INICIO
  // ---------------------------------------
  if (req.method === "GET" && req.url === "/") {
    return sendJSON(res, 200, {
      service: "ClipManiaLatam",
      message: "Sistema de VODs activo",
      version: "1.1.0",
      endpoints: [
        "GET /health",
        "GET /api/vods",
        "POST /api/vods",
        "GET /api/vods/:id"
      ]
    });
  }

  // ---------------------------------------
  // LISTAR VODS
  // ---------------------------------------
  if (req.method === "GET" && req.url === "/api/vods") {
    return sendJSON(res, 200, {
      ok: true,
      count: vods.size,
      vods: Array.from(vods.values())
    });
  }

  // ---------------------------------------
  // RECIBIR UN VOD
  // ---------------------------------------
  if (req.method === "POST" && req.url === "/api/vods") {
    try {
      const body = await readBody(req);

      if (!body) {
        return sendJSON(res, 400, {
          ok: false,
          error: "El cuerpo de la solicitud está vacío"
        });
      }

      let data;

      try {
        data = JSON.parse(body);
      } catch {
        return sendJSON(res, 400, {
          ok: false,
          error: "JSON inválido"
        });
      }

      if (!data.title) {
        return sendJSON(res, 400, {
          ok: false,
          error: "Falta el título del VOD"
        });
      }

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

      console.log(`VOD recibido: ${vod.title} | ID: ${id}`);

      return sendJSON(res, 201, {
        ok: true,
        message: "VOD recibido para procesamiento",
        vod
      });

    } catch (error) {
      console.error("Error procesando VOD:", error);

      return sendJSON(res, 500, {
        ok: false,
        error: "Error interno procesando el VOD"
      });
    }
  }

  // ---------------------------------------
  // CONSULTAR UN VOD POR ID
  // ---------------------------------------
  if (req.method === "GET" && req.url.startsWith("/api/vods/")) {
    const id = req.url.split("/")[3];

    const vod = vods.get(id);

    if (!vod) {
      return sendJSON(res, 404, {
        ok: false,
        error: "VOD no encontrado"
      });
    }

    return sendJSON(res, 200, {
      ok: true,
      vod
    });
  }

  // ---------------------------------------
  // RUTA NO ENCONTRADA
  // ---------------------------------------
  return sendJSON(res, 404, {
    ok: false,
    error: "Ruta no encontrada"
  });
});

server.listen(PORT, () => {
  console.log(`ClipManiaLatam activo en el puerto ${PORT}`);
});