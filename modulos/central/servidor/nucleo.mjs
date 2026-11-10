/**
 * nucleo.mjs - configuracao, chamadas ao Asterisk e normalizacao do modulo central.
 * Papel: ler o .env do modulo, perguntar ao Asterisk (ARI) se o celular gateway e o ramal estao
 * online, guardar o historico de chamadas em memoria e manter o cache.
 * NAO faz: importar o host, responder HTTP ao navegador (isso e do rotas.mjs) nem participar da
 * chamada (o audio vai direto navegador <-> Asterisk <-> celular, sem passar por este servidor).
 */
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
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

// Modo online: o navegador fala com o relay (Render) e nao com um Asterisk. Liga com RELAY_URL, com MODO=online
// ou sozinho na Vercel (la nao existe Asterisk). MODO=local forca o modo Asterisk mesmo na Vercel.
function decidirOnline() {
  const modo = env("MODO", "").toLowerCase();
  if (modo === "local") return false;
  if (modo === "online") return true;
  return !!env("RELAY_URL") || !!process.env.VERCEL;
}

export const cfg = {
  online: decidirOnline(),
  relayUrl: env("RELAY_URL").replace(/\/+$/, ""),
  apkUrl: env("APK_URL"),
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
  // Senha e porta que o celular usa para registrar. Servem so para montar o QR de "Conectar celular".
  gwSenha: env("GW_SENHA"),
  gwPorta: env("GW_PORTA", "5060"),
  ariUsuario: env("ARI_USUARIO", "central"),
  ariSenha: env("ARI_SENHA")
};

/**
 * Aqui "token" sao as credenciais do Asterisk. Sem elas nada protegido responde, a nao ser em MOCK.
 */
export function exigirToken() {
  if (cfg.mock || cfg.online) return;
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
  if (cfg.online) {
    // No modo online quem sabe do celular e o relay, e o navegador conversa direto com ele.
    return Promise.resolve({ ok: true, online: true, ari: { ok: true, erro: "", dica: "" }, gateway: null, ramal: null, cache: false, carregadoEm: Date.now() });
  }
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
  if (cfg.online && !cfg.mock) {
    // Nada secreto aqui: so o endereco publico do relay. O codigo de acesso o usuario digita na tela.
    return {
      ok: true,
      mock: false,
      somenteLeitura: cfg.somenteLeitura,
      online: { relay: cfg.relayUrl, apk: cfg.apkUrl },
      gateway: { nome: "celular" },
      sip: { wsUrl: "", dominio: "online", ramal: "online", senha: "", nomeExibicao: cfg.sipNome },
      cache: false,
      carregadoEm: Date.now()
    };
  }
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

/* ===== Dados para configurar o celular (QR) ===== */

// Interfaces que nunca sao a rede do celular: loopback, docker, maquinas virtuais e VPNs.
const IGNORAR_INTERFACE = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|tailscale|zt|wg|tun|tap)/i;

function ipPrivado(ip) {
  const p = String(ip).split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31);
}

/** IPv4 de rede local deste computador, 192.168.x primeiro (o padrao de roteador domestico). */
export function ipsLocais(interfaces = os.networkInterfaces()) {
  const achados = [];
  for (const [nome, lista] of Object.entries(interfaces || {})) {
    if (IGNORAR_INTERFACE.test(nome)) continue;
    for (const e of lista || []) {
      const v4 = e.family === "IPv4" || e.family === 4;
      if (!v4 || e.internal || !ipPrivado(e.address)) continue;
      achados.push({ ip: e.address, interface: nome });
    }
  }
  const peso = (ip) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : 2);
  return achados.sort((a, b) => peso(a.ip) - peso(b.ip));
}

/**
 * O que o navegador precisa para desenhar o QR do app: IP do PC, porta, usuario e senha do celular.
 * O JSON do QR e montado la; o servidor so entrega os ingredientes (e so ao proprio PC, ver rotas.mjs).
 */
export function montarCelular() {
  const base = { ok: true, mock: cfg.mock, cache: false, carregadoEm: Date.now() };
  if (cfg.mock) {
    return { ...base, ips: [{ ip: "192.168.0.10", interface: "wlan0" }], porta: 5060, usuario: cfg.gateway, senha: "mock-senha-celular" };
  }
  if (cfg.somenteLeitura) {
    throw new ErroHttp(403, "Modo somente leitura (READ_ONLY=1): a senha do celular não é entregue", "Troque READ_ONLY para 0 no .env do módulo e reinicie o servidor.");
  }
  if (!cfg.gwSenha) {
    throw new ErroHttp(
      409,
      "Falta a senha do celular (GW_SENHA) no .env do módulo",
      "Rode: bash modulos/central/asterisk/instalar.sh. Ele cria a GW_SENHA e grava a mesma senha no Asterisk."
    );
  }
  return { ...base, ips: ipsLocais(), porta: Number(cfg.gwPorta) || 5060, usuario: cfg.gateway, senha: cfg.gwSenha };
}

/* ===== APK do celular (download pela rede local) ===== */

// O APK vem do GitHub Actions (artefato .zip). Quem roda a Central extrai o .apk nesta pasta e o painel
// "Conectar celular" mostra um QR com o link. Fica fora de /api de proposito: quem baixa e o celular, na rede.
const PASTA_APK_REL = "modulos/central/apk-celular";
const NOME_APK = /^[A-Za-z0-9._-]{1,120}\.apk$/;

function pastaApk() {
  return path.join(raizModulo(), "apk-celular");
}

/** O .apk mais novo da pasta (nome simples, arquivo comum, nao vazio), ou null. Nada de subpastas. */
export function acharApk() {
  let nomes;
  try {
    nomes = fs.readdirSync(pastaApk());
  } catch {
    return null;
  }
  let melhor = null;
  for (const nome of nomes) {
    if (!NOME_APK.test(nome)) continue;
    const caminho = path.join(pastaApk(), nome);
    let st;
    try {
      st = fs.statSync(caminho);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size <= 0) continue;
    if (!melhor || st.mtimeMs > melhor.modificadoEm) melhor = { nome, caminho, tamanho: st.size, modificadoEm: st.mtimeMs };
  }
  return melhor;
}

/** Valida o nome pedido no download: so entrega o arquivo que acharApk() anuncia (sem caminhos do cliente). */
export function abrirApk(nome) {
  if (cfg.mock) {
    throw new ErroHttp(404, "Modo MOCK: não há APK para baixar", "Rode sem MOCK=1 para servir o APK da pasta " + PASTA_APK_REL + "/.");
  }
  const apk = acharApk();
  if (!apk || apk.nome !== nome) {
    throw new ErroHttp(404, "APK não encontrado", "Coloque o .apk em " + PASTA_APK_REL + "/ e abra o painel Conectar celular para ver o link atual.");
  }
  return apk;
}

const shaCache = new Map();

function sha256Arquivo(apk) {
  const chave = apk.nome + "|" + apk.tamanho + "|" + apk.modificadoEm;
  if (shaCache.has(chave)) return shaCache.get(chave);
  const p = new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(apk.caminho)
      .on("error", reject)
      .on("data", (b) => h.update(b))
      .on("end", () => resolve(h.digest("hex")));
  });
  shaCache.set(chave, p);
  p.catch(() => shaCache.delete(chave));
  if (shaCache.size > 8) shaCache.delete(shaCache.keys().next().value);
  return p;
}

/** O que o painel precisa para a aba "Baixar o app": o APK da pasta (se houver) e os IPs do PC para o link. */
export async function montarApk() {
  const base = { ok: true, mock: cfg.mock, cache: false, carregadoEm: Date.now(), pasta: PASTA_APK_REL };
  if (cfg.mock) {
    return {
      ...base,
      ips: [{ ip: "192.168.0.10", interface: "wlan0" }],
      apk: { nome: "voice-sip-agent-exemplo-qr-debug.apk", tamanho: 31457280, modificadoEm: Date.now(), sha256: "0".repeat(64) }
    };
  }
  const achado = acharApk();
  let apk = null;
  if (achado) {
    try {
      apk = { nome: achado.nome, tamanho: achado.tamanho, modificadoEm: achado.modificadoEm, sha256: await sha256Arquivo(achado) };
    } catch {
      apk = null; // o arquivo sumiu no meio da leitura: para o painel e como se nao houvesse
    }
  }
  return { ...base, ips: ipsLocais(), apk };
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

/* ===== Relato do celular (passo a passo ao vivo) ===== */

// Depois de ler o QR da aba "2. Configurar", o app conta de tempos em tempos em que passo da configuracao esta
// (pareamento, helper, acesso as chamadas, audio, SIP). Fica so na memoria, por sessao do painel (sid), e some
// sozinho. Nao carrega senha: o app nunca poe senha no log e ainda troca a senha do SIP por *** antes de mandar.
const RELATOS = new Map();
const RELATO_VALIDADE_MS = 30 * 60 * 1000;
const RELATO_MAX_SESSOES = 8;
const SID_VALIDO = /^[A-Za-z0-9._-]{4,63}$/;

function textoCurto(v, max) {
  return String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

export function registrarRelato(corpo, agora = Date.now()) {
  const c = corpo && typeof corpo === "object" ? corpo : {};
  const sid = textoCurto(c.sid, 63);
  if (!SID_VALIDO.test(sid)) {
    throw new ErroHttp(400, "Relato sem sessão válida", "O app manda o campo sid (o nome do pareamento do QR).");
  }
  const log = Array.isArray(c.log) ? c.log.slice(-20).map((l) => textoCurto(l, 200)).filter(Boolean) : [];
  for (const [k, v] of RELATOS) {
    if (agora - v.recebidoEm > RELATO_VALIDADE_MS) RELATOS.delete(k);
  }
  RELATOS.delete(sid);
  RELATOS.set(sid, {
    sid,
    recebidoEm: agora,
    android: textoCurto(c.android, 60),
    configurado: c.configurado === true,
    pareado: c.pareado === true,
    helper: textoCurto(c.helper, 30),
    helperDetalhe: textoCurto(c.helperDetalhe, 300),
    acesso: c.acesso === true,
    audio: c.audio === true,
    sip: c.sip === true,
    sipDetalhe: textoCurto(c.sipDetalhe, 300),
    pronto: c.pronto === true,
    detalhe: textoCurto(c.detalhe, 300),
    log
  });
  while (RELATOS.size > RELATO_MAX_SESSOES) RELATOS.delete(RELATOS.keys().next().value);
  return { ok: true };
}

export function buscarRelato(sid, agora = Date.now()) {
  const id = textoCurto(sid, 63);
  const r = SID_VALIDO.test(id) ? RELATOS.get(id) : undefined;
  const vivo = r && agora - r.recebidoEm <= RELATO_VALIDADE_MS;
  return { ok: true, relato: vivo ? { ...r, idadeMs: agora - r.recebidoEm } : null, cache: false, carregadoEm: agora };
}
