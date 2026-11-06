/**
 * app.js - fabrica do Express do host.
 * Papel: configurar o Express, servir public/ e montar os modulos em /<prefixo>.
 * NAO faz: listen (isso e do server.js, para a Vercel poder importar o app sem abrir porta)
 * nem acessa banco no /health.
 */

// Precisa ser o primeiro import: o nucleo do modulo le process.env assim que e carregado.
import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import central from "../modulos/central/servidor/index.js";

const AQUI = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Sem banco de proposito: o health so diz que o processo esta de pe.
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use(express.static(path.join(AQUI, "..", "public")));

// Acoplamento 1 de 2 do modulo central: comentar esta linha desliga o modulo sem mexer no host.
app.use("/central", central);

// Express 5 so reconhece o tratador de erro pelos 4 parametros, mesmo sem usar o next.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ erro: "Erro interno inesperado." });
});

export default app;
