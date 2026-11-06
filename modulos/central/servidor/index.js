/**
 * index.js - router Express do modulo central (unico ponto do servidor que o host enxerga).
 * Papel: servir a tela (HTML + estaticos) e entregar /api/* ao rotas.mjs.
 * NAO faz: regra de negocio (rotas.mjs), chamadas ao Asterisk (nucleo.mjs) nem importar o host.
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rotear } from "./rotas.mjs";
import { ErroHttp } from "./nucleo.mjs";

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
