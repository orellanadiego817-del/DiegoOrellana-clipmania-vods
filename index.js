// ClipManiaLatam GitHub write access verified
const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const vods = new Map();

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(data));
}

function page(res, title, content) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8"
  });

  res.end(`
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - ClipManiaLatam</title>
<style>
body{
  font-family:Arial,sans-serif;
  max-width:850px;
  margin:40px auto;
  padding:20px;
  background:#111;
  color:#eee;
  line-height:1.6
}
h1,h2{color:white}
a{color:#7db7ff}
.box{
  background:#1d1d1d;
  padding:25px;
  border-radius:15px
}
nav{margin-bottom:25px}
</style>
</head>
<body>
<nav>
<a href="/">Inicio</a> |
<a href="/terminos">Términos</a> |
<a href="/privacidad">Privacidad</a>
</nav>
<div class="box">
${content}
</div>
</body>
</html>
`);
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

const server = http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.url === "/health") {
    return json(res, 200, {
      ok: true,
      service: "ClipManiaLatam",
      status: "funcionando"
    });
  }

  if (req.url === "/") {
    return page(res, "ClipManiaLatam", `
      <h1>ClipManiaLatam</h1>
      <p>
        Plataforma para organizar y preparar contenido de video
        para creadores y equipos autorizados.
      </p>

      <p>
        Las conexiones con plataformas externas utilizan
        mecanismos oficiales de autorización.
      </p>

      <p>
        <a href="/terminos">Términos de Servicio</a><br>
        <a href="/privacidad">Política de Privacidad</a>
      </p>
    `);
  }

  if (path === "/terminos" || path === "/terminos/") {
    return page(res, "Términos de Servicio", `
      <h1>Términos de Servicio</h1>

      <p><strong>Última actualización: 27 de septiembre de 2026.</strong></p>

      <h2>1. Servicio</h2>
      <p>
        ClipManiaLatam proporciona herramientas para organizar,
        preparar y compartir contenido de video para creadores
        y equipos autorizados.
      </p>

      <h2>2. Autorización</h2>
      <p>
        Las conexiones con plataformas externas se realizan
        mediante sus mecanismos oficiales de autorización.
        ClipManiaLatam no solicita ni almacena contraseñas
        de dichas plataformas.
      </p>

      <h2>3. Contenido</h2>
      <p>
        El usuario debe contar con los derechos y permisos
        necesarios sobre el contenido que utilice mediante
        el servicio.
      </p>

      <h2>4. Publicación</h2>
      <p>
        La publicación de contenido está sujeta a las reglas
        y permisos de cada plataforma.
      </p>

      <h2>5. Seguridad</h2>
      <p>
        Aplicamos medidas razonables para proteger la
        información procesada.
      </p>

      <h2>6. Cambios</h2>
      <p>
        Estos términos pueden actualizarse cuando sea necesario
        para reflejar cambios en el servicio.
      </p>
    `);
  }

  if (path === "/privacidad" || path === "/privacidad/") {
    return page(res, "Política de Privacidad", `
      <h1>Política de Privacidad</h1>

      <p><strong>Última actualización: 27 de septiembre de 2026.</strong></p>

      <h2>1. Información procesada</h2>
      <p>
        ClipManiaLatam puede procesar información necesaria
        para prestar las funciones solicitadas, incluyendo
        datos relacionados con cuentas y contenido de video.
      </p>

      <h2>2. Plataformas externas</h2>
      <p>
        Cuando el usuario conecta una plataforma mediante
        autorización oficial, los datos recibidos se utilizan
        para las funciones autorizadas.
      </p>

      <h2>3. Contraseñas</h2>
      <p>
        ClipManiaLatam no solicita ni almacena contraseñas
        de cuentas de terceros.
      </p>

      <h2>4. Uso de los datos</h2>
      <p>
        Los datos se utilizan para proporcionar y mantener
        las funciones solicitadas.
      </p>

      <h2>5. Seguridad</h2>
      <p>
        Aplicamos medidas razonables para proteger los datos.
      </p>

      <h2>6. Cambios</h2>
      <p>
        Esta política puede actualizarse cuando cambien
        el servicio o sus integraciones.
      </p>
    `);
  }

  if (req.method === "GET" && req.url === "/api/vods") {
    return json(res, 200, {
      ok: true,
      count: vods.size,
      vods: Array.from(vods.values())
    });
  }

  if (req.method === "POST" && req.url === "/api/vods") {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);

      if (!data.title) {
        return json(res, 400, {
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

      return json(res, 201, {
        ok: true,
        vod
      });

    } catch (error) {
      return json(res, 400, {
        ok: false,
        error: "Solicitud inválida"
      });
    }
  }

  if (req.method === "GET" && req.url.startsWith("/api/vods/")) {
    const id = req.url.split("/")[3];
    const vod = vods.get(id);

    if (!vod) {
      return json(res, 404, {
        ok: false,
        error: "VOD no encontrado"
      });
    }

    return json(res, 200, {
      ok: true,
      vod
    });
  }
  if (req.method === "GET" && req.url === "/terminos") {
    return page(res, "Términos de Servicio", `
      <h1>Términos de Servicio</h1>
      <p><strong>Última actualización: 27 de septiembre de 2026.</strong></p>

      <h2>1. Servicio</h2>
      <p>ClipManiaLatam proporciona herramientas para organizar, preparar y compartir contenido de video para creadores y equipos autorizados.</p>

      <h2>2. Autorización de cuentas</h2>
      <p>Las conexiones con plataformas externas se realizan mediante sus mecanismos oficiales de autorización. ClipManiaLatam no solicita ni almacena contraseñas de dichas plataformas.</p>

      <h2>3. Derechos sobre el contenido</h2>
      <p>El usuario debe contar con los derechos, permisos o autorizaciones necesarios para utilizar y publicar el contenido procesado mediante el servicio.</p>

      <h2>4. Publicación</h2>
      <p>Las publicaciones están sujetas a las reglas y permisos de cada plataforma. Cuando una plataforma exige consentimiento explícito, ClipManiaLatam lo solicitará antes de enviar el contenido.</p>

      <h2>5. Seguridad</h2>
      <p>Aplicamos medidas razonables para proteger la información procesada.</p>
    `);
  }

  if (req.method === "GET" && req.url === "/privacidad") {
    return page(res, "Política de Privacidad", `
      <h1>Política de Privacidad</h1>
      <p><strong>Última actualización: 27 de septiembre de 2026.</strong></p>

      <h2>1. Información procesada</h2>
      <p>ClipManiaLatam puede procesar información necesaria para operar las funciones solicitadas, incluyendo datos básicos de cuenta y datos relacionados con videos y VODs.</p>

      <h2>2. Datos de plataformas</h2>
      <p>Los datos recibidos mediante autorizaciones oficiales se utilizan únicamente para las funciones autorizadas y conforme a las reglas de cada plataforma.</p>

      <h2>3. Contraseñas</h2>
      <p>ClipManiaLatam no solicita ni almacena contraseñas de cuentas de terceros.</p>

      <h2>4. Uso y conservación</h2>
      <p>Los datos se utilizan para prestar las funciones solicitadas y se conservan durante el tiempo razonablemente necesario para esos fines, salvo obligaciones legales.</p>

      <h2>5. Seguridad</h2>
      <p>Aplicamos medidas razonables de seguridad para proteger los datos procesados.</p>

      <h2>6. Cambios</h2>
      <p>Esta política puede actualizarse cuando cambien el servicio o sus integraciones.</p>
    `);
        }
  return json(res, 404, {
    ok: false,
    error: "Ruta no encontrada"
  });
});

server.listen(PORT, () => {
  console.log(`ClipManiaLatam activo en el puerto ${PORT}`);
});
