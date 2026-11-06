/**
 * nucleo.mjs - configuracao, chamadas ao Asterisk e normalizacao do modulo central.
 * Papel: ler o .env do modulo, perguntar ao Asterisk (ARI) se o celular gateway e o ramal estao
 * online, guardar o historico de chamadas em memoria e manter o cache.
 * NAO faz: importar o host, responder HTTP ao navegador (isso e do rotas.mjs) nem participar da
 * chamada (o audio vai direto navegador <-> Asterisk <-> celular, sem passar por este servidor).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ===== Erros ===== */

export class ErroHttp extends Error {
  constructor(status, message, dica = "") {
    super(message);
    this.name = "ErroHttp";
    this.status = status;
    this.dica = dica;
  }
}

/* ===== Env do modulo ===== */

function raizModulo() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  } catch {
    // Alguns empacotadores entregam um import.meta.url que nao e file://; o cwd e o melhor palpite.
    return process.cwd();
  }
}

function carregarEnvModulo() {
  const arq = path.join(raizModulo(), ".env");
  let texto;
  try {
    texto = fs.readFileSync(arq, "utf8");
  } catch {
    return; // sem .env no modulo e normal: o host ou o ambiente podem ter definido tudo
  }
  for (const bruta of texto.split(/\r?\n/)) {
    const linha = bruta.trim();
    if (!linha || linha.startsWith("#")) continue;
    const i = linha.indexOf("=");
    if (i < 0) continue;
    const chave = linha.slice(0, i).trim();
    let valor = linha.slice(i + 1).trim();
    const aspa = valor[0];
    if (valor.length >= 2 && (aspa === '"' || aspa === "'") && valor[valor.length - 1] === aspa) {
      valor = valor.slice(1, -1);
    }
    // Nunca sobrescreve: o .env da raiz e o ambiente (shell, Vercel) mandam mais que o do modulo.
    if (chave && process.env[chave] === undefined) process.env[chave] = valor;
  }
}
carregarEnvModulo();

/* ===== Config ===== */

function env(nome, padrao = "") {
  const v = process.env[nome];
  return v === undefined || v === "" ? padrao : v;
}

function numeroNaoNegativo(txt, padrao) {
  const n = Number(txt);
  return Number.isFinite(n) && n >= 0 ? n : padrao;
}

const host = env("ASTERISK_HOST", "localhost");
const portaHttp = env("ASTERISK_HTTP_PORT", "8088");

export const cfg = {
  mock: env("MOCK", "0") === "1",
  somenteLeitura: env("READ_ONLY", "0") === "1",
  cacheMs: numeroNaoNegativo(env("CACHE_TTL_MS", "5000"), 5000),
  configRemota: env("CONFIG_REMOTA", "0") === "1",
  host,
  portaHttp,
  // O navegador usa o endereco como esta no .env (localhost e um contexto seguro, o IP da rede nao e).
  wsUrl: env("ASTERISK_WS_URL", "ws://" + host + ":" + portaHttp + "/ws"),
  // O servidor Node usa 127.0.0.1 no lugar de localhost: o Asterisk escuta so em IPv4 e o localhost
  // pode resolver para ::1 primeiro.
  ariUrl: "http://" + (host === "localhost" ? "127.0.0.1" : host) + ":" + portaHttp + "/ari",
  sipDominio: env("SIP_DOMINIO", host),
  sipRamal: env("SIP_RAMAL", "atendente"),
  sipSenha: env("SIP_SENHA"),
  sipNome: env("SIP_NOME", "Atendente"),
  gateway: env("GATEWAY_ENDPOINT", "android-gw"),
  ariUsuario: env("ARI_USUARIO", "central"),
  ariSenha: env("ARI_SENHA")
};

/**
 * Aqui "token" sao as credenciais do Asterisk. Sem elas nada protegido responde, a nao ser em MOCK.
 */
export function exigirToken() {
  if (cfg.mock) return;
  const falta = [];
  if (!cfg.sipSenha) falta.push("SIP_SENHA");
  if (!cfg.ariSenha) falta.push("ARI_SENHA");
  if (falta.length) {
    throw new ErroHttp(
      401,
      "Faltam credenciais do Asterisk: " + falta.join(", "),
      "Rode: bash modulos/central/asterisk/instalar.sh (cria o .env com senhas novas) ou preencha modulos/central/.env. Para ver a tela sem Asterisk, use MOCK=1."
    );
  }
}

/* ===== Cache ===== */

const cache = new Map();

/** Cache com TTL proprio, para operacoes caras. */
export async function comCacheTtl(chave, ttl, produzir) {
  const e = cache.get(chave);
  if (e && Date.now() - e.em < ttl) return { ...e.valor, cache: true };
  const valor = await produzir();
  cache.set(chave, { em: Date.now(), valor });
  return { ...valor, cache: false };
}

/** Cache padrao das listagens (janela = CACHE_TTL_MS). */
export function comCache(chave, produzir) {
  return comCacheTtl(chave, cfg.cacheMs, produzir);
}

/* ===== Asterisk (ARI) ===== */

async function perguntarAri(caminho) {
  const auth = Buffer.from(cfg.ariUsuario + ":" + cfg.ariSenha).toString("base64");
  let r;
  try {
    r = await fetch(cfg.ariUrl + caminho, {
      headers: { Authorization: "Basic " + auth },
      signal: AbortSignal.timeout(3000)
    });
  } catch {
    throw new ErroHttp(
      502,
      "O Asterisk não respondeu em " + cfg.host + ":" + cfg.portaHttp,
      "Confira se ele está rodando: sudo systemctl status asterisk"
    );
  }
  if (r.status === 401) {
    throw new ErroHttp(502, "O Asterisk recusou o usuário ou a senha do ARI", "ARI_SENHA no .env precisa ser a mesma do /etc/asterisk/ari.conf");
  }
  if (r.status === 404) {
    throw new ErroHttp(502, "O ARI do Asterisk não está habilitado", "Faltam http.conf e ari.conf. Rode de novo o instalar.sh");
  }
  if (!r.ok) throw new ErroHttp(502, "O ARI respondeu HTTP " + r.status, "");
  return r.json();
}

function normalizarEndpoint(e) {
  const bruto = e && e.state;
  return {
    nome: String((e && e.resource) || ""),
    estado: bruto === "online" ? "online" : bruto === "offline" ? "offline" : "desconhecido",
    emChamada: Array.isArray(e && e.channel_ids) && e.channel_ids.length > 0
  };
}

function ausente(nome) {
  return { nome, estado: "ausente", emChamada: false };
}

/**
 * Estado do celular gateway e do ramal do navegador, visto pelo Asterisk.
 * Falha do ARI NAO vira erro HTTP: a tela continua util e mostra o motivo no cartao de verificacoes.
 */
export function buscarEstado() {
  if (cfg.mock) {
    return comCache("estado-mock", async () => ({
      ok: true,
      ari: { ok: true, erro: "", dica: "" },
      gateway: { nome: cfg.gateway, estado: "online", emChamada: false },
      ramal: { nome: cfg.sipRamal, estado: "online", emChamada: false },
      carregadoEm: Date.now()
    }));
  }
  return comCache("estado", async () => {
    const carregadoEm = Date.now();
    try {
      const lista = await perguntarAri("/endpoints/PJSIP");
      const todos = (Array.isArray(lista) ? lista : []).map(normalizarEndpoint);
      const achar = (nome) => todos.find((e) => e.nome === nome) || ausente(nome);
      return {
        ok: true,
        ari: { ok: true, erro: "", dica: "" },
        gateway: achar(cfg.gateway),
        ramal: achar(cfg.sipRamal),
        carregadoEm
      };
    } catch (err) {
      return {
        ok: true,
        ari: { ok: false, erro: err.message, dica: err.dica || "" },
        gateway: null,
        ramal: null,
        carregadoEm
      };
    }
  });
}

/* ===== Config entregue ao navegador ===== */

export function montarConfig() {
  const base = {
    ok: true,
    mock: cfg.mock,
    somenteLeitura: cfg.somenteLeitura,
    gateway: { nome: cfg.gateway },
    cache: false,
    carregadoEm: Date.now()
  };
  if (cfg.mock) {
    return { ...base, sip: { wsUrl: "ws://mock.invalid/ws", dominio: "mock", ramal: cfg.sipRamal, senha: "mock", nomeExibicao: cfg.sipNome } };
  }
  // Em somente leitura o navegador nem recebe a senha: sem ela nao existe como ligar.
  if (cfg.somenteLeitura) return { ...base, sip: null };
  return {
    ...base,
    sip: { wsUrl: cfg.wsUrl, dominio: cfg.sipDominio, ramal: cfg.sipRamal, senha: cfg.sipSenha, nomeExibicao: cfg.sipNome }
  };
}

/* ===== Historico de chamadas (em memoria) ===== */

// Em memoria de proposito na v1: zera ao reiniciar o servidor. Na Vercel zera a cada instancia fria.
const MAX_CHAMADAS = 200;
const DIRECOES = ["saida", "entrada"];
const STATUS = ["atendida", "perdida", "falha"];
const chamadas = [];
let contador = 0;

if (cfg.mock) {
  const agora = Date.now();
  chamadas.push(
    { id: "m1", direcao: "saida", numero: "83999998888", inicio: agora - 25 * 60000, duracao: 94, status: "atendida", causa: "Você desligou" },
    { id: "m2", direcao: "entrada", numero: "11988887777", inicio: agora - 2 * 3600000, duracao: 0, status: "perdida", causa: "Quem ligou desistiu" },
    { id: "m3", direcao: "saida", numero: "2133334444", inicio: agora - 26 * 3600000, duracao: 0, status: "falha", causa: "Ocupado" }
  );
}

export function listarChamadas() {
  return { ok: true, itens: chamadas.slice(), total: chamadas.length, cache: false, carregadoEm: Date.now() };
}

export function registrarChamada(corpo) {
  const c = corpo && typeof corpo === "object" ? corpo : {};
  if (!DIRECOES.includes(c.direcao)) throw new ErroHttp(400, "Campo direcao inválido", "Use saida ou entrada.");
  if (!STATUS.includes(c.status)) throw new ErroHttp(400, "Campo status inválido", "Use atendida, perdida ou falha.");
  const numero = String(c.numero ?? "").replace(/[^0-9+*#]/g, "").slice(0, 32);
  if (!numero) throw new ErroHttp(400, "Campo numero vazio", "Envie o número da chamada.");

  const agora = Date.now();
  let inicio = Number(c.inicio);
  if (!Number.isFinite(inicio) || inicio <= 0 || inicio > agora + 60000) inicio = agora;
  let duracao = Math.round(Number(c.duracao));
  if (!Number.isFinite(duracao) || duracao < 0) duracao = 0;
  duracao = Math.min(duracao, 86400);
  const causa = String(c.causa ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, 120);

  contador += 1;
  const item = { id: agora.toString(36) + contador.toString(36), direcao: c.direcao, numero, inicio, duracao, status: c.status, causa };
  chamadas.unshift(item);
  if (chamadas.length > MAX_CHAMADAS) chamadas.length = MAX_CHAMADAS;
  return item;
}
