/*
 * Servidor local mínimo para o PWA.
 *
 * Os módulos ES e o service worker precisam de uma origem HTTP. Este servidor
 * entrega somente arquivos de dist/ e escuta apenas no próprio computador.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const publicDirectory = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const host = "127.0.0.1";
const port = Number(process.env.PORT || 4173);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);

function respond(res, status, message) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  res.end(message);
}

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    respond(res, 405, "Método não permitido.");
    return;
  }

  let requestedPath;
  try {
    requestedPath = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
  } catch {
    respond(res, 400, "Endereço inválido.");
    return;
  }

  const target = resolve(publicDirectory, `.${requestedPath}`);
  if (target !== publicDirectory && !target.startsWith(`${publicDirectory}${sep}`)) {
    respond(res, 403, "Acesso negado.");
    return;
  }

  try {
    const fileInfo = await stat(target);
    const filePath = fileInfo.isDirectory() ? resolve(target, "index.html") : target;
    const file = await stat(filePath);
    if (!file.isFile()) {
      respond(res, 404, "Arquivo não encontrado.");
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentTypes.get(extname(filePath).toLowerCase()) || "application/octet-stream",
      "Content-Length": file.size,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  } catch {
    respond(res, 404, "Arquivo não encontrado.");
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`A porta ${port} já está em uso. Feche outro servidor ou inicie com PORT=4174 npm start.`);
    process.exitCode = 1;
    return;
  }
  console.error("Não foi possível iniciar o servidor local:", error.message);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`PRELUX disponível em http://${host}:${port}`);
  console.log("Para encerrar, pressione Ctrl+C nesta janela.");
});
