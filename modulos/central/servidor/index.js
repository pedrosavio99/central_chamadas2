/**
 * index.js - router Express do modulo central (unico ponto do servidor que o host enxerga).
 * Papel: servir a tela (HTML + estaticos) e entregar /api/* ao rotas.mjs.
 * NAO faz: regra de negocio (rotas.mjs), chamadas ao Asterisk (nucleo.mjs) nem importar o host.
 */
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rotear } from "./rotas.mjs";
import { ErroHttp, abrirApk } from "./nucleo.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const PUBLICO = path.join(AQUI, "..", "publico");

const router = express.Router();

// Casca HTML sem cache: ela referencia os scripts pelo nome, entao uma versao velha em cache esconderia correcoes.
router.get("/", (req, res) => {
  // Os links do HTML sao relativos (central.css, central.js). Sem a barra final eles apontariam para a raiz do host.
  if (!req.originalUrl.split("?")[0].endsWith("/")) {
    res.redirect(302, req.baseUrl + "/");
    return;
  }
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(PUBLICO, "central.html"));
});

router.use(express.static(PUBLICO, { fallthrough: true, maxAge: 0 }));

// Download do APK do celular. Sem exigir "acesso do proprio PC": e o celular, na rede local, que baixa.
// So entrega o .apk que a pasta apk-celular/ tem agora (nome simples, sem caminho vindo do cliente).
router.get("/apk/:nome", (req, res) => {
  try {
    const apk = abrirApk(req.params.nome);
    res.set({
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Length": String(apk.tamanho),
      "Content-Disposition": 'attachment; filename="' + apk.nome + '"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(apk.caminho)
      .on("error", () => res.destroy())
      .pipe(res);
  } catch (err) {
    const status = err instanceof ErroHttp ? err.status : 500;
    if (status >= 500) console.error("[central]", err);
    res.status(status).type("text/plain").send(err.message + (err.dica ? "\n" + err.dica : ""));
  }
});

router.use(async (req, res, next) => {
  if (!req.path.startsWith("/api")) {
    next();
    return;
  }
  try {
    const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    res.set("Cache-Control", "no-store");
    res.json(await rotear(req, url));
  } catch (err) {
    const status = err instanceof ErroHttp ? err.status : 500;
    if (status >= 500) console.error("[central]", err);
    res.status(status).json({ erro: err.message, dica: err.dica || "" });
  }
});

export default router;
