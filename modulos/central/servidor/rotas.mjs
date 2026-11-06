/**
 * rotas.mjs - roteamento da API do modulo central, independente de framework.
 * Papel: receber (req, url) e devolver um objeto; erros viram ErroHttp.
 * NAO faz: falar com o Asterisk (nucleo.mjs), enviar resposta HTTP (index.js) nem guardar estado.
 * Caminhos sao relativos ao ponto de montagem: /api/health vira /central/api/health.
 */
import {
  ErroHttp,
  cfg,
  exigirToken,
  buscarEstado,
  montarConfig,
  montarCelular,
  montarApk,
  listarChamadas,
  registrarChamada
} from "./nucleo.mjs";

const VERSAO = "1.0.0";

const ROTAS_VALIDAS = [
  "GET /api/health",
  "GET /api/config",
  "GET /api/celular",
  "GET /api/apk",
  "GET /api/estado",
  "GET /api/chamadas",
  "POST /api/chamadas"
];

/* ===== Guardas ===== */

function ehLocal(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Impede que OUTRA pagina aberta no navegador use este servidor em nome do usuario.
 * Origin ausente = chamada que nao vem de pagina (curl, app): passa.
 */
export function verificarOrigem(req) {
  const origem = req.headers.origin;
  if (!origem) return;
  let u;
  try {
    u = new URL(origem);
  } catch {
    throw new ErroHttp(403, "Origem inválida", "O cabeçalho Origin não é uma URL.");
  }
  if (ehLocal(u.hostname)) return;
  if (u.host === req.headers.host) return;
  throw new ErroHttp(403, "Origem não permitida: " + origem, "Acesse a tela pelo mesmo endereço do servidor.");
}

export function guardaDeEscrita(req) {
  if (cfg.somenteLeitura) {
    throw new ErroHttp(403, "Modo somente leitura (READ_ONLY=1)", "Troque READ_ONLY para 0 no .env do módulo e reinicie o servidor.");
  }
  verificarOrigem(req);
}

/**
 * Extra em relacao ao contrato: a senha do ramal so sai para quem acessa do proprio computador.
 * O servidor escuta em 0.0.0.0 (contrato do host), entao sem isto qualquer aparelho da rede leria a
 * senha que liga pelo chip da empresa.
 */
function exigirLocal(req) {
  if (cfg.mock || cfg.configRemota) return;
  const ip = (req.socket && req.socket.remoteAddress) || "";
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return;
  throw new ErroHttp(
    403,
    "As credenciais do ramal só são entregues a quem acessa deste computador",
    "Abra http://localhost:3333/central/ no PC onde o servidor roda. Acesso remoto (v2, com HTTPS) exige CONFIG_REMOTA=1."
  );
}

/** Le o JSON do corpo. O host ja roda express.json; sem ele, le o stream na mao (limite de 1 MB). */
export async function lerCorpo(req) {
  if (req.body !== undefined) {
    return req.body && typeof req.body === "object" ? req.body : {};
  }
  const partes = [];
  let total = 0;
  for await (const parte of req) {
    total += parte.length;
    if (total > 1048576) throw new ErroHttp(413, "Corpo grande demais", "O limite é 1 MB.");
    partes.push(parte);
  }
  if (!partes.length) return {};
  try {
    return JSON.parse(Buffer.concat(partes).toString("utf8"));
  } catch {
    throw new ErroHttp(400, "JSON inválido no corpo", "Envie um JSON válido.");
  }
}

/* ===== Roteamento ===== */

export async function rotear(req, url) {
  const caminho = url.pathname.replace(/\/+$/, "") || "/";
  const metodo = req.method;

  // O health vem primeiro e nao pede credencial: serve para saber se o modulo esta montado.
  if (metodo === "GET" && caminho === "/api/health") {
    return { ok: true, modulo: "central", versao: VERSAO, mock: cfg.mock, somenteLeitura: cfg.somenteLeitura };
  }

  if (metodo === "GET" && caminho === "/api/config") {
    exigirToken();
    verificarOrigem(req);
    exigirLocal(req);
    return montarConfig();
  }

  // Entrega a senha do celular gateway (para o QR): mesmas travas do /api/config, so o proprio PC.
  if (metodo === "GET" && caminho === "/api/celular") {
    exigirToken();
    verificarOrigem(req);
    exigirLocal(req);
    return montarCelular();
  }

  // Informacoes do APK servido pela Central (nome, tamanho, SHA-256) e IPs do PC. O download em si e
  // GET /apk/<arquivo> (index.js), fora do /api, porque quem baixa e o celular.
  if (metodo === "GET" && caminho === "/api/apk") {
    exigirToken();
    verificarOrigem(req);
    exigirLocal(req);
    return montarApk();
  }

  if (metodo === "GET" && caminho === "/api/estado") {
    exigirToken();
    return buscarEstado();
  }

  if (metodo === "GET" && caminho === "/api/chamadas") {
    exigirToken();
    return listarChamadas();
  }

  if (metodo === "POST" && caminho === "/api/chamadas") {
    exigirToken();
    guardaDeEscrita(req);
    const corpo = await lerCorpo(req);
    return { ok: true, item: registrarChamada(corpo), cache: false, carregadoEm: Date.now() };
  }

  throw new ErroHttp(404, "Rota não encontrada: " + metodo + " " + caminho, "Rotas válidas: " + ROTAS_VALIDAS.join(", "));
}
