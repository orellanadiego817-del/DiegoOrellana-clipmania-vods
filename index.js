const http = require("http");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });

  if (req.url === "/health") {
    res.end("ClipMania VODs funcionando correctamente");
    return;
  }

  res.end("ClipManiaLatam - sistema de VODs activo");
});

server.listen(PORT, () => {
  console.log(`ClipMania VODs activo en el puerto ${PORT}`);
});
