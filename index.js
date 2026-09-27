const http = require("http");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({
      ok: true,
      service: "ClipManiaLatam",
      status: "funcionando"
    }));
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200);
    res.end(JSON.stringify({
      service: "ClipManiaLatam",
      message: "Sistema de VODs activo"
    }));
    return;
  }

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
