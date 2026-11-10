/**
 * central.js - tela da Central de Chamadas (discador + historico).
 * Papel: um estado (S), um render, um tratador de cliques e o ramal WebRTC (JsSIP) que liga o
 * navegador ao Asterisk. O audio vai direto navegador <-> Asterisk <-> celular.
 * NAO faz: falar HTTP com o Asterisk (isso e do servidor), guardar dados no navegador (so o tema
 * vai para o localStorage) nem tocar em nada do host alem do /estilos.css.
 */

/* ===== 1. Vocabulario ===== */

// A tela so e servida na raiz do modulo (/central/), entao o caminho dela menos a barra final e o prefixo.
var BASE = location.pathname.replace(/\/+$/, "");
var TESTE_ECO = "600"; // ramal de teste do dialplan: devolve o audio, nao usa o celular nem gasta chip
// Chamada sem caller ID (anonimo): o servidor so aceita digitos, entao guardamos "0" e a tela mostra "Número oculto".
var NUMERO_OCULTO = "0";
var TITULO_BASE = document.title;

var FILTROS = [
  { id: "todas", rotulo: "Todas" },
  { id: "atendida", rotulo: "Atendidas" },
  { id: "perdida", rotulo: "Perdidas" },
  { id: "falha", rotulo: "Falhas" }
];
var ROTULO_STATUS = { atendida: "Atendida", perdida: "Perdida", falha: "Falhou" };
var TECLAS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

// Teste de microfone: o nivel e o RMS do sinal (0 a 1). Abaixo de MIC_MUDO nao ha sinal; acima de MIC_VOZ ha voz.
var MIC_MUDO = 0.003;
var MIC_VOZ = 0.015;
var MIC_TESTE_MAX_MS = 30000;
var MSG_AUDIO_INICIAL = "Clique em Testar microfone, fale e veja a barra mexer. Se não mexer, escolha outro microfone.";
var MSG_SEM_MIDIA = "Este navegador não libera o microfone nesta página. Abra por http://localhost ou use HTTPS.";

// Textos de causa que o JsSIP devolve (em ingles) traduzidos para quem usa a tela.
var CAUSAS = {
  "Busy": "Ocupado",
  "Rejected": "Recusada",
  "Unavailable": "Celular gateway indisponível",
  "Not Found": "Número não aceito pelo Asterisk",
  "Canceled": "Cancelada",
  "Request Timeout": "Sem resposta do Asterisk",
  "Connection Error": "Sem conexão com o Asterisk",
  "Terminated": "Encerrada",
  "No Answer": "Ninguém atendeu",
  "User Denied Media Access": "Microfone negado ou indisponível no navegador",
  "RTP Timeout": "O áudio caiu",
  "WebRTC Error": "Erro de áudio no navegador",
  "Authentication Error": "Ramal sem permissão (senha recusada)",
  "SIP Failure Code": "Falha do Asterisk",
  "Address Incomplete": "Número incompleto",
  "Incompatible SDP": "Áudio incompatível",
  "Bad Media Description": "Áudio incompatível",
  "Internal Error": "Erro interno do navegador",
  // Modo online (relay): o que o celular e o relay contam.
  celular_offline: "O celular não está conectado ao relay",
  celular_caiu: "O celular perdeu a conexão no meio da chamada",
  relay_caiu: "A conexão com o relay caiu",
  sem_resposta_do_celular: "O celular não confirmou o desligamento",
  numero_invalido: "Número inválido",
  erro_audio: "Erro de áudio no celular",
  proibido: "O celular não aceita ligar para esse número (emergência ou fora dos prefixos permitidos)",
  erro_rede: "O celular perdeu a rede no meio da chamada",
  falha: "Falha interna no celular (veja o Registro)",
  normal: "Encerrada"
};

/* ===== Estado unico ===== */

var S = {
  itens: [],
  usuario: null,
  aba: "discar",
  filtro: "todas",
  busca: "",
  visiveis: [],
  carregando: true,
  carregadoEm: 0,
  doCache: false,
  erro: null,
  selecionada: null,
  config: null,
  estado: null,
  ramal: "conectando", // conectando | registrado | desconectado | falhou | bloqueado | inseguro | mock
  ramalDica: "",
  chamada: null, // { direcao, numero, estado, inicio, criadaEm, mudo, audioMsg }
  numero: "",
  // Cartao de audio (so memoria, nada vai para o navegador): dispositivos listados, escolha e estado do teste.
  audio: { entradas: [], saidas: [], idMic: "", idSaida: "", permissao: "pendente", abrindo: false, testando: false, gravando: false, ouvindo: false, msg: "" }
};

// Fora do estado porque nao sao dados da tela: sao objetos vivos e timers.
var UA = null;
var SESSAO = null;
var AUDIO = null;
var CTX_AUDIO = null;
var TIMER_CHAMADA = 0;
var TIMER_TOQUE = 0;
var TIMER_ESTADO = 0;
var TIMER_TOAST = 0;
var MOCK_TIMERS = [];
var VIEW_KEY = "";
var CORPO_MODO = "";
var MIC_STREAM = null;
var MIC_CTX = null;
var MIC_ANALISADOR = null;
var MIC_BUFFER = null;
var MIC_NOME = "";
var MIC_GERACAO = 0;
var MIC_INICIO = 0;
var MIC_PICO = 0;
var MIC_PICO_GRAVACAO = 0;
var MIC_NIVEL = 0;
var TIMER_MEDIDOR = 0;
var TIMER_MIC = 0;
var TIMER_GRAVACAO = 0;
var TIMER_DIAGNOSTICO = 0;
var GRAVADOR = null;
var REPRODUCAO = null;
var DIAG = null;

/* ===== 2. Rede ===== */

function api(caminho, opcoes) {
  opcoes = opcoes || {};
  var cab = { "Content-Type": "application/json" };
  var extra = opcoes.headers || {};
  var k;
  for (k in extra) {
    if (Object.prototype.hasOwnProperty.call(extra, k)) {
      cab[k] = extra[k];
    }
  }
  var pedido = {};
  for (k in opcoes) {
    if (Object.prototype.hasOwnProperty.call(opcoes, k)) {
      pedido[k] = opcoes[k];
    }
  }
  pedido.headers = cab;
  return fetch(BASE + caminho, pedido).then(function (r) {
    return r.text().then(function (txt) {
      var dados;
      try {
        dados = JSON.parse(txt);
      } catch (e) {
        dados = { erro: "Resposta ilegível do servidor" };
      }
      if (!r.ok) {
        var err = new Error((dados && dados.erro) || "Erro " + r.status);
        err.dica = (dados && dados.dica) || "";
        err.status = r.status;
        throw err;
      }
      return dados;
    });
  });
}

/** Resposta 200 que nao e o que o servidor promete (ex.: JSON ilegivel) tambem e erro para a tela. */
function exigirOk(d) {
  if (!d || d.ok !== true) {
    var err = new Error((d && d.erro) || "Resposta inesperada do servidor");
    err.dica = "Abra o console do navegador e a aba Rede para ver o que veio.";
    throw err;
  }
  return d;
}

/* ===== 3. Utilitarios ===== */

function $(s) {
  return document.querySelector(s);
}

function esc(v) {
  return String(v === null || v === undefined ? "" : v).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function soDigitos(t) {
  return String(t || "").replace(/\D+/g, "");
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function uid() {
  return Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

/**
 * Aceita "(83) 99999-8888", "+55 83 99999-8888", "083999998888" e devolve so DDD + numero.
 * Espelha o dialplan (10 ou 11 digitos): o Asterisk recusa o resto de qualquer jeito, aqui so avisa antes.
 */
function normalizarNumero(txt) {
  var t = String(txt || "").replace(/[\s().\-]/g, "");
  if (t === TESTE_ECO) {
    return { ok: true, numero: t };
  }
  var d = soDigitos(t);
  if (d.length >= 12 && d.indexOf("55") === 0) {
    d = d.slice(2);
  }
  if ((d.length === 11 || d.length === 12) && d.charAt(0) === "0") {
    d = d.slice(1);
  }
  if (!/^[1-9][1-9](9\d{8}|\d{8})$/.test(d)) {
    return { ok: false, erro: "Use DDD + número (10 ou 11 dígitos), por exemplo 83 99999-8888." };
  }
  return { ok: true, numero: d };
}

function formatarNumero(n) {
  if (String(n) === NUMERO_OCULTO) {
    return "Número oculto";
  }
  var d = soDigitos(n);
  if (d.length >= 12 && d.indexOf("55") === 0) {
    d = d.slice(2);
  }
  if (d.length === 11) {
    return "(" + d.slice(0, 2) + ") " + d.slice(2, 7) + "-" + d.slice(7);
  }
  if (d.length === 10) {
    return "(" + d.slice(0, 2) + ") " + d.slice(2, 6) + "-" + d.slice(6);
  }
  return String(n === null || n === undefined ? "" : n);
}

function hora(ms, comSegundos) {
  var d = new Date(ms);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + (comSegundos ? ":" + pad2(d.getSeconds()) : "");
}

function rotuloDia(ms) {
  var d = new Date(ms);
  var hoje = new Date();
  var ontem = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - 1);
  function mesmo(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  if (mesmo(d, hoje)) {
    return "Hoje";
  }
  if (mesmo(d, ontem)) {
    return "Ontem";
  }
  return pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1) + "/" + d.getFullYear();
}

function duracaoTxt(seg) {
  seg = Math.max(0, Math.floor(seg));
  var h = Math.floor(seg / 3600);
  var m = Math.floor((seg % 3600) / 60);
  var s = seg % 60;
  return (h ? h + ":" + pad2(m) : m) + ":" + pad2(s);
}

function rotuloDirecao(d) {
  return d === "entrada" ? "Recebida" : "Feita";
}

function causaTxt(causa, e) {
  var base = CAUSAS[causa] || causa || "Sem detalhe";
  var cod = e && e.message && e.message.status_code;
  return cod ? base + " (SIP " + cod + ")" : base;
}

function toast(msg) {
  var t = $("#toast");
  t.textContent = msg;
  t.classList.add("visivel");
  clearTimeout(TIMER_TOAST);
  TIMER_TOAST = setTimeout(function () {
    t.classList.remove("visivel");
  }, 2600);
}

function copiar(texto, aviso) {
  function deu() {
    toast(aviso || "Copiado");
  }
  function naoDeu() {
    toast("Não consegui copiar");
  }
  // A API de area de transferencia nao existe fora de contexto seguro (ex.: abrindo pelo IP da maquina).
  function plano() {
    try {
      var ta = document.createElement("textarea");
      ta.value = texto;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "0";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var feito = document.execCommand("copy");
      document.body.removeChild(ta);
      if (feito) {
        deu();
      } else {
        naoDeu();
      }
    } catch (e) {
      naoDeu();
    }
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(texto).then(deu, plano);
  } else {
    plano();
  }
}

function alternarTema() {
  var temas = ["sistema", "claro", "escuro"];
  var atual = document.documentElement.getAttribute("data-tema") || "sistema";
  var prox = temas[(temas.indexOf(atual) + 1) % temas.length];
  document.documentElement.setAttribute("data-tema", prox);
  try {
    localStorage.setItem("2brain-tema", prox);
  } catch (e) {}
  toast("Tema: " + prox);
}

/* ===== 4. Filtros ===== */

function aplicarFiltros() {
  var qd = soDigitos(S.busca);
  var temBusca = S.busca.trim() !== "";
  S.visiveis = S.itens.filter(function (it) {
    if (S.filtro !== "todas" && it.status !== S.filtro) {
      return false;
    }
    if (temBusca && (!qd || String(it.numero).indexOf(qd) < 0)) {
      return false;
    }
    return true;
  });
}

function contar(filtro) {
  if (filtro === "todas") {
    return S.itens.length;
  }
  var n = 0;
  for (var i = 0; i < S.itens.length; i++) {
    if (S.itens[i].status === filtro) {
      n++;
    }
  }
  return n;
}

/* ===== 5. Lista e render ===== */

function achar(id) {
  for (var i = 0; i < S.itens.length; i++) {
    if (S.itens[i].id === id) {
      return S.itens[i];
    }
  }
  return null;
}

function htmlItem(it) {
  var sinal = it.direcao === "entrada" ? "↙" : "↗";
  var extra = it.duracao ? " · " + duracaoTxt(it.duracao) : "";
  return (
    '<button class="nota ch-item ch-st-' + esc(it.status) + '" data-id="' + esc(it.id) + '">' +
    '<span class="ch-sinal">' + esc(sinal) + "</span>" +
    '<span class="ch-item-txt"><strong>' + esc(formatarNumero(it.numero)) + "</strong>" +
    "<span>" + esc(hora(it.inicio) + " · " + rotuloDirecao(it.direcao) + extra) + "</span></span>" +
    '<span class="selo-tipo ch-selo-' + esc(it.status) + '">' + esc(ROTULO_STATUS[it.status] || it.status) + "</span>" +
    "</button>"
  );
}

function htmlVazio(emoji, titulo, texto) {
  return '<div class="vazio"><div class="emoji">' + esc(emoji) + "</div><h3>" + esc(titulo) + "</h3><p>" + esc(texto) + "</p></div>";
}

function htmlEsqueleto() {
  // Html estatico, sem dado externo: nada para escapar.
  return '<div class="esqueleto"><div class="linha"></div><div class="linha"></div><div class="linha"></div><div class="linha"></div></div>';
}

function htmlErro(e) {
  return (
    '<div class="ch-aviso" role="alert"><strong>' + esc(e.message) + "</strong>" +
    (e.dica ? "<span>" + esc(e.dica) + "</span>" : "") +
    '<button class="btn btn-suave" data-acao="recarregar">Tentar de novo</button></div>'
  );
}

function htmlLista(animar) {
  if (!S.visiveis.length) {
    if (S.busca.trim() !== "" || S.filtro !== "todas") {
      return htmlVazio("🔍", "Nada encontrado", "Nenhuma chamada combina com esse filtro ou busca.");
    }
    return htmlVazio("📞", "Sem chamadas ainda", "As chamadas feitas e recebidas aparecem aqui.");
  }
  var h = '<div class="lista' + (animar ? " animar" : "") + '">';
  var diaAtual = "";
  for (var i = 0; i < S.visiveis.length; i++) {
    var it = S.visiveis[i];
    var dia = rotuloDia(it.inicio);
    if (dia !== diaAtual) {
      h += '<div class="cab-secao">' + esc(dia) + "</div>";
      diaAtual = dia;
    }
    h += htmlItem(it);
  }
  return h + "</div>";
}

/* --- verificacoes antes de ligar --- */

function nomeGateway() {
  return (S.config && S.config.gateway && S.config.gateway.nome) || "android-gw";
}

function rotuloRamal() {
  var mapa = {
    registrado: "registrado",
    conectando: "conectando",
    desconectado: "desconectado",
    falhou: "falhou",
    bloqueado: "bloqueado",
    inseguro: "parado",
    mock: "simulado"
  };
  return mapa[S.ramal] || S.ramal;
}

function rotuloGateway() {
  var e = S.estado;
  if (!e) {
    return "consultando";
  }
  if (!e.ari.ok) {
    return "sem resposta do Asterisk";
  }
  if (!e.gateway) {
    return "desconhecido";
  }
  return e.gateway.estado;
}

function saudeLinhas() {
  if (S.config && S.config.online) {
    return saudeLinhasOnline();
  }
  var c = S.config || {};
  var linhas = [];
  var e = S.estado;

  if (c.mock) {
    linhas.push({ nivel: "aviso", titulo: "Modo MOCK", texto: "As chamadas são simuladas. Nada passa pelo Asterisk nem sai pelo chip." });
  }

  if (typeof JsSIP === "undefined") {
    linhas.push({ nivel: "erro", titulo: "Navegador", texto: "A biblioteca JsSIP não carregou (vendor/jssip.min.js)." });
  } else if (!window.isSecureContext) {
    linhas.push({ nivel: "erro", titulo: "Navegador", texto: "O microfone fica bloqueado neste endereço. Abra por http://localhost:3333/central/ ou use HTTPS." });
  } else if (location.protocol === "https:" && c.sip && String(c.sip.wsUrl).indexOf("ws:") === 0) {
    linhas.push({ nivel: "erro", titulo: "Navegador", texto: "Uma página em HTTPS não pode usar ws://. Na v1, abra por http://localhost:3333/central/." });
  } else {
    linhas.push({ nivel: "ok", titulo: "Navegador", texto: "Pronto. O microfone é pedido na primeira chamada." });
  }

  var ramal = S.usuario ? S.usuario.ramal : "";
  if (S.ramal === "registrado") {
    linhas.push({ nivel: "ok", titulo: "Ramal no Asterisk", texto: "Ramal " + ramal + " registrado." });
  } else if (S.ramal === "conectando") {
    linhas.push({ nivel: "espera", titulo: "Ramal no Asterisk", texto: "Conectando ao Asterisk..." });
  } else if (S.ramal === "mock") {
    linhas.push({ nivel: "ok", titulo: "Ramal no Asterisk", texto: "Ramal " + ramal + " simulado." });
  } else if (S.ramal === "bloqueado") {
    linhas.push({ nivel: "aviso", titulo: "Ramal no Asterisk", texto: "Modo somente leitura (READ_ONLY=1): as ligações estão desativadas." });
  } else if (S.ramal === "inseguro") {
    linhas.push({ nivel: "aviso", titulo: "Ramal no Asterisk", texto: "Parado até o navegador liberar o microfone (veja a linha Navegador)." });
  } else {
    linhas.push({ nivel: "erro", titulo: "Ramal no Asterisk", texto: S.ramalDica || "Sem conexão com o Asterisk." });
  }

  if (!e) {
    linhas.push({ nivel: "espera", titulo: "Celular gateway", texto: "Consultando o Asterisk..." });
  } else if (!e.ari.ok) {
    linhas.push({ nivel: "aviso", titulo: "Celular gateway", texto: "Não consegui perguntar ao Asterisk: " + e.ari.erro + (e.ari.dica ? ". " + e.ari.dica : "") });
  } else if (!e.gateway || e.gateway.estado === "ausente") {
    linhas.push({ nivel: "erro", titulo: "Celular gateway", texto: "O Asterisk não conhece o endpoint " + nomeGateway() + ". Rode de novo o instalar.sh." });
  } else if (e.gateway.estado === "online") {
    linhas.push({ nivel: "ok", titulo: "Celular gateway", texto: "Registrado e pronto (uma chamada por vez)." + (e.gateway.emChamada ? " Em chamada agora." : "") });
  } else if (e.gateway.estado === "offline") {
    linhas.push({
      nivel: "erro",
      titulo: "Celular gateway",
      texto: "Offline. No celular: abra o Voice SIP Agent, confira a aba Health e ligue Take over calls. Se o celular reiniciou, ligue o Wi-Fi e a Depuração sem fio: o app reconecta sozinho.",
      acao: "conectar-celular",
      acaoRotulo: "Conectar celular"
    });
  } else {
    linhas.push({ nivel: "aviso", titulo: "Celular gateway", texto: "O Asterisk não sabe dizer se o celular está online." });
  }
  return linhas;
}

/** Texto do motivo pelo qual nao da para ligar agora. Vazio = pode ligar. */
function motivoBloqueio() {
  var c = S.config;
  if (!c) {
    return "Carregando...";
  }
  if (c.mock) {
    return "";
  }
  if (c.somenteLeitura) {
    return "Modo somente leitura (READ_ONLY=1): ligações desativadas.";
  }
  if (c.online) {
    return motivoBloqueioOnline();
  }
  if (typeof JsSIP === "undefined") {
    return "A biblioteca JsSIP não carregou.";
  }
  if (!window.isSecureContext) {
    return "O navegador bloqueia o microfone neste endereço. Abra por http://localhost:3333/central/.";
  }
  if (S.ramal !== "registrado") {
    return "O ramal ainda não registrou no Asterisk (veja as verificações acima).";
  }
  // O teste de eco (600) nao passa pelo celular, entao nao pode ficar preso ao estado dele:
  // e justamente o que se usa para testar o navegador antes de o celular estar configurado.
  var soEco = String(S.numero).replace(/\s/g, "") === TESTE_ECO;
  var e = S.estado;
  if (!soEco && e && e.ari.ok && e.gateway && (e.gateway.estado === "offline" || e.gateway.estado === "ausente")) {
    return "O celular gateway está offline (veja as verificações acima).";
  }
  return "";
}

function renderSaude() {
  var el = $("#blocoSaude");
  if (!el) {
    return;
  }
  var linhas = saudeLinhas();
  var h = '<section class="ch-saude" aria-label="Verificações antes de ligar">';
  for (var i = 0; i < linhas.length; i++) {
    var l = linhas[i];
    h +=
      '<div class="ch-linha"><span class="ch-ponto ch-n-' + esc(l.nivel) + '"></span>' +
      '<div class="ch-linha-txt"><strong>' + esc(l.titulo) + "</strong><span>" + esc(l.texto) + "</span></div>" +
      (l.acao ? '<button class="btn btn-suave ch-linha-btn" data-acao="' + esc(l.acao) + '">' + esc(l.acaoRotulo) + "</button>" : "") +
      "</div>";
  }
  el.innerHTML = h + "</section>";
}

/* --- discador --- */

function htmlDiscador() {
  var h = '<div id="blocoGuia"></div><div id="blocoSaude"></div><div id="blocoAudio"></div><section class="ch-discador">';
  h +=
    '<input id="campoNumero" class="ch-visor" type="tel" inputmode="tel" autocomplete="off"' +
    ' placeholder="DDD + número" aria-label="Número a discar" value="' + esc(S.numero) + '">';
  h += '<div class="ch-teclado">';
  for (var i = 0; i < TECLAS.length; i++) {
    h += '<button class="ch-tecla" data-tecla="' + esc(TECLAS[i]) + '">' + esc(TECLAS[i]) + "</button>";
  }
  h += "</div>";
  h +=
    '<div class="ch-acoes"><button class="btn btn-suave ch-apagar" data-acao="apagar" aria-label="Apagar">⌫</button>' +
    '<button class="btn btn-largo ch-ligar" id="btnLigar" data-acao="ligar">Ligar</button></div>';
  h += '<p class="ch-dica" id="dicaDiscar"></p>';
  if (S.config && S.config.mock) {
    h += '<button class="btn btn-suave btn-largo" data-acao="simular">Simular chamada recebida (modo MOCK)</button>';
  }
  return h + '</section><div id="blocoRecentes"></div>';
}

/**
 * Atualiza o discador sem refazer o HTML: refazer apagaria o que a pessoa esta digitando
 * e fecharia o teclado do celular a cada consulta de estado.
 */
function atualizarDiscador() {
  var btn = $("#btnLigar");
  if (!btn) {
    return;
  }
  var campo = $("#campoNumero");
  if (campo && campo.value !== S.numero && document.activeElement !== campo) {
    campo.value = S.numero;
  }
  var motivo = motivoBloqueio();
  btn.disabled = !!(S.chamada || motivo);
  $("#dicaDiscar").textContent = S.chamada ? "Em chamada: as teclas enviam tons (DTMF)." : motivo;
  atualizarAudio();
}

function renderRecentes() {
  var el = $("#blocoRecentes");
  if (!el) {
    return;
  }
  var topo = S.itens.slice(0, 3);
  if (!topo.length) {
    el.innerHTML = '<p class="ch-dica">As chamadas feitas e recebidas aparecem aqui.</p>';
    return;
  }
  var h = '<div class="ch-recentes-topo"><span class="cab-secao">Últimas chamadas</span>' +
    '<button class="ch-link" data-aba="historico">Ver tudo</button></div><div class="lista">';
  for (var i = 0; i < topo.length; i++) {
    h += htmlItem(topo[i]);
  }
  el.innerHTML = h + "</div>";
}

/* --- faixa da chamada em andamento --- */

function rotuloEstadoChamada(c) {
  if (c.estado === "tocando") {
    return "Tocando...";
  }
  if (c.estado === "discando") {
    return "Discando...";
  }
  if (c.estado === "chamando") {
    return "Chamando... (sem som de chamada: é assim mesmo)";
  }
  if (c.estado === "atendendo") {
    return "Atendendo...";
  }
  return duracaoTxt((Date.now() - c.inicio) / 1000);
}

function renderChamada() {
  var el = $("#blocoChamada");
  var c = S.chamada;
  if (!c) {
    el.innerHTML = "";
    el.hidden = true;
    return;
  }
  el.hidden = false;
  var h =
    '<div class="ch-chamada ch-ch-' + esc(c.estado) + '" role="status">' +
    '<div class="ch-chamada-txt"><strong>' + esc(formatarNumero(c.numero)) + "</strong>" +
    "<span>" + esc(c.direcao === "entrada" ? "Chamada recebida" : "Chamada feita") + ' · <span id="chTempo">' + esc(rotuloEstadoChamada(c)) + "</span></span>" +
    '<span class="ch-audio-diag" id="chAudio">' + esc(c.audioMsg || "") + "</span></div>" +
    '<div class="ch-chamada-acoes">';
  if (c.estado === "tocando") {
    h += '<button class="btn ch-btn-atender" data-acao="atender">Atender</button>' +
      '<button class="btn ch-btn-desligar" data-acao="recusar">Recusar</button>';
  } else {
    h += '<button class="btn btn-suave" data-acao="mudo">' + esc(c.mudo ? "Ativar som" : "Silenciar") + "</button>" +
      '<button class="btn ch-btn-desligar" data-acao="desligar">Desligar</button>';
  }
  el.innerHTML = h + "</div></div>";
}

/* --- resumo, abas, filtros e corpo --- */

function renderResumo() {
  var el = $("#resumoTopo");
  if (S.carregando) {
    el.textContent = "Carregando...";
    return;
  }
  if (S.erro) {
    el.textContent = "Não foi possível carregar";
    return;
  }
  if (S.config && S.config.online) {
    el.textContent = resumoOnline();
    return;
  }
  var partes = ["Ramal " + (S.usuario ? S.usuario.ramal : "") + ": " + rotuloRamal(), "Gateway: " + rotuloGateway()];
  var fresco = S.carregadoEm ? "estado de " + hora(S.carregadoEm, true) + (S.doCache ? " (cache)" : " (ao vivo)") : "";
  el.textContent = partes.join(" · ") + (fresco ? " · " + fresco : "");
}

function renderAbas() {
  var caixa = $("#abasGrupo");
  var botoes = caixa.querySelectorAll("[data-aba]");
  for (var i = 0; i < botoes.length; i++) {
    var ativo = botoes[i].getAttribute("data-aba") === S.aba;
    botoes[i].classList.toggle("ativo", ativo);
    botoes[i].setAttribute("aria-selected", ativo ? "true" : "false");
    if (ativo) {
      caixa.style.setProperty("--i", String(i));
    }
  }
  caixa.style.setProperty("--n", String(botoes.length));
}

function renderFiltros() {
  var el = $("#filtros");
  var caixaBusca = $("#caixaBusca");
  var historico = S.aba === "historico" && !S.erro && !S.carregando;
  el.hidden = !historico;
  caixaBusca.hidden = !historico;
  caixaBusca.classList.toggle("tem-texto", S.busca.length > 0);
  if (!historico) {
    return;
  }
  var h = '<div class="chips">';
  for (var i = 0; i < FILTROS.length; i++) {
    var f = FILTROS[i];
    h += '<button class="chip' + (S.filtro === f.id ? " ativo" : "") + '" data-filtro="' + esc(f.id) + '">' +
      esc(f.rotulo) + ' <span class="n">' + esc(contar(f.id)) + "</span></button>";
  }
  el.innerHTML = h + "</div>";
}

function renderCorpo() {
  var corpo = $("#blocoCorpo");
  // So anima a lista quando a visao muda; filtrar/atualizar com a mesma visao nao reanima.
  var chave = [S.aba, S.busca, S.filtro].join("|");
  var mudou = chave !== VIEW_KEY;
  VIEW_KEY = chave;

  if (S.carregando) {
    corpo.innerHTML = htmlEsqueleto();
    CORPO_MODO = "esqueleto";
    return;
  }
  if (S.erro) {
    corpo.innerHTML = htmlErro(S.erro);
    CORPO_MODO = "erro";
    return;
  }
  if (S.aba === "discar") {
    if (CORPO_MODO !== "discar") {
      corpo.innerHTML = htmlDiscador();
      CORPO_MODO = "discar";
      renderAudio();
    }
    renderGuia();
    renderSaude();
    atualizarDiscador();
    renderRecentes();
    return;
  }
  if (S.aba === "registro" && S.config && S.config.online) {
    renderRegistroAba();
    return;
  }
  corpo.innerHTML = htmlLista(mudou);
  CORPO_MODO = "lista";
}

function render() {
  aplicarFiltros();
  renderResumo();
  renderAbas();
  renderFiltros();
  renderCorpo();
  renderChamada();
}

/* ===== 6. Selecao ===== */

function mudarAba(aba) {
  S.aba = aba;
  if (aba !== "discar") {
    pararTesteMic();
  }
  render();
}

function abrirItem(id) {
  var it = achar(id);
  if (!it) {
    return;
  }
  S.selecionada = id;
  abrirSheet(formatarNumero(it.numero), htmlDetalhe(it));
}

/* ===== 7. Sheet de detalhe ===== */

function linhaDetalhe(rotulo, texto) {
  return '<div class="detalhe-rot">' + esc(rotulo) + '</div><div class="detalhe-txt">' + esc(texto) + "</div>";
}

function htmlDetalhe(it) {
  var h = "";
  h += linhaDetalhe("Direção", rotuloDirecao(it.direcao));
  h += linhaDetalhe("Número", formatarNumero(it.numero));
  h += linhaDetalhe("Quando", rotuloDia(it.inicio) + ", " + hora(it.inicio, true));
  h += linhaDetalhe("Duração", it.duracao ? duracaoTxt(it.duracao) : "Não atendida");
  h += linhaDetalhe("Resultado", ROTULO_STATUS[it.status] || it.status);
  if (it.causa) {
    h += linhaDetalhe("Detalhe", it.causa);
  }
  h +=
    '<div class="ch-sheet-acoes">' +
    '<button class="btn btn-largo" data-acao="ligar-de-novo" data-numero="' + esc(it.numero) + '">Ligar de novo</button>' +
    '<button class="btn btn-suave btn-largo" data-acao="copiar" data-numero="' + esc(it.numero) + '">Copiar número</button>' +
    "</div>";
  return h;
}

function abrirSheet(titulo, html) {
  $("#sheetTitulo").textContent = titulo;
  // O html chega pronto de quem chama, e cada dado externo ja passou por esc() la.
  $("#sheetCorpo").innerHTML = html;
  $("#sheet").classList.add("aberto");
  $("#cortina").classList.add("aberta");
}

function fecharSheet() {
  pararCelular();
  $("#sheet").classList.remove("aberto");
  $("#cortina").classList.remove("aberta");
  S.selecionada = null;
}

/* ===== 8. Ramal e chamadas (WebRTC via JsSIP) ===== */

function tocarCampainha(ligar) {
  clearInterval(TIMER_TOQUE);
  TIMER_TOQUE = 0;
  document.title = ligar ? "Chamada recebida - " + TITULO_BASE : TITULO_BASE;
  if (!ligar) {
    return;
  }
  var Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    return;
  }
  try {
    if (!CTX_AUDIO) {
      CTX_AUDIO = new Ctx();
    }
    if (CTX_AUDIO.state === "suspended") {
      CTX_AUDIO.resume();
    }
    var toque = function () {
      var osc = CTX_AUDIO.createOscillator();
      var ganho = CTX_AUDIO.createGain();
      osc.frequency.value = 440;
      ganho.gain.value = 0.08;
      osc.connect(ganho);
      ganho.connect(CTX_AUDIO.destination);
      osc.start();
      osc.stop(CTX_AUDIO.currentTime + 0.9);
    };
    toque();
    TIMER_TOQUE = setInterval(toque, 3000);
  } catch (e) {
    // Sem som de campainha o aviso visual e o titulo da aba continuam funcionando.
  }
}

function limparChamada() {
  clearInterval(TIMER_CHAMADA);
  TIMER_CHAMADA = 0;
  pararDiagnostico();
  tocarCampainha(false);
  for (var i = 0; i < MOCK_TIMERS.length; i++) {
    clearTimeout(MOCK_TIMERS[i]);
  }
  MOCK_TIMERS = [];
  if (AUDIO) {
    AUDIO.srcObject = null;
  }
  SESSAO = null;
  S.chamada = null;
}

function registrarHistorico(item) {
  item.id = "l" + uid(); // provisorio: o servidor devolve o id definitivo
  S.itens.unshift(item);
  render();
  if (S.config && S.config.online) {
    // Na Vercel nao ha onde guardar: o historico fica so neste navegador.
    historicoLocalGravar(S.itens);
    return;
  }
  api("/api/chamadas", { method: "POST", body: JSON.stringify(item) })
    .then(function (r) {
      if (r && r.item && r.item.id) {
        item.id = r.item.id;
      }
    })
    .catch(function (e) {
      toast("Histórico não salvo no servidor: " + (e.dica || e.message));
    });
}

function finalizarChamada(status, causa) {
  var c = S.chamada;
  if (!c) {
    return;
  }
  var seg = c.inicio ? Math.round((Date.now() - c.inicio) / 1000) : 0;
  var item = { direcao: c.direcao, numero: c.numero, inicio: c.inicio || c.criadaEm, duracao: seg, status: status, causa: causa };
  limparChamada();
  registrarHistorico(item);
}

function marcarAtendida() {
  var c = S.chamada;
  if (!c || c.inicio) {
    return;
  }
  c.estado = "atendida";
  c.inicio = Date.now();
  tocarCampainha(false);
  clearInterval(TIMER_CHAMADA);
  TIMER_CHAMADA = setInterval(function () {
    var t = $("#chTempo");
    if (t && S.chamada && S.chamada.estado === "atendida") {
      t.textContent = duracaoTxt((Date.now() - S.chamada.inicio) / 1000);
    }
  }, 1000);
  renderChamada();
  atualizarDiscador();
  iniciarDiagnostico();
}

function terminou(sessao, e) {
  if (sessao !== SESSAO || !S.chamada) {
    return;
  }
  var c = S.chamada;
  var causa = e && e.cause;
  var quem = e && e.originator;
  if (c.inicio) {
    var fim = quem === "local" ? "Você desligou" : quem === "remote" ? "O outro lado desligou" : causaTxt(causa, e);
    finalizarChamada("atendida", fim);
    return;
  }
  if (c.direcao === "entrada") {
    finalizarChamada("perdida", causa === "Canceled" ? "Quem ligou desistiu" : quem === "local" ? "Recusada por você" : causaTxt(causa, e));
    return;
  }
  finalizarChamada("falha", quem === "local" && causa === "Canceled" ? "Cancelada por você" : causaTxt(causa, e));
}

function ligarAudioRemoto(sessao) {
  function anexar(pc) {
    pc.addEventListener("track", function (ev) {
      var fluxo = ev.streams && ev.streams[0] ? ev.streams[0] : new MediaStream([ev.track]);
      AUDIO.srcObject = fluxo;
      var p = AUDIO.play();
      if (p && p.catch) {
        p.catch(function () {
          toast("Clique na página para liberar o áudio");
        });
      }
    });
  }
  // Chamada feita: o JsSIP ja criou a conexao antes de entregar a sessao. Chamada recebida: so cria ao atender.
  if (sessao.connection) {
    anexar(sessao.connection);
  }
  sessao.on("peerconnection", function (d) {
    anexar(d.peerconnection);
  });
}

function ouvirSessao(sessao) {
  sessao.on("progress", function () {
    if (sessao === SESSAO && S.chamada && S.chamada.estado === "discando") {
      S.chamada.estado = "chamando";
      renderChamada();
    }
  });
  sessao.on("accepted", function () {
    if (sessao === SESSAO) {
      marcarAtendida();
    }
  });
  sessao.on("confirmed", function () {
    if (sessao === SESSAO) {
      marcarAtendida();
    }
  });
  sessao.on("ended", function (e) {
    terminou(sessao, e);
  });
  sessao.on("failed", function (e) {
    terminou(sessao, e);
  });
}

function chegouChamada(sessao) {
  var id = sessao.remote_identity;
  var bruto = id && id.uri && id.uri.user ? id.uri.user : "";
  var numero = String(bruto).replace(/[^0-9+*#]/g, "").slice(0, 32) || NUMERO_OCULTO;
  pararTesteMic();
  S.chamada = { direcao: "entrada", numero: numero, estado: "tocando", inicio: 0, criadaEm: Date.now(), mudo: false };
  tocarCampainha(true);
  render();
}

function iniciarRamal() {
  var c = S.config;
  S.usuario = { ramal: c.sip ? c.sip.ramal : "", nome: c.sip ? c.sip.nomeExibicao : "" };
  if (UA) {
    return;
  }
  if (c.mock) {
    S.ramal = "mock";
    return;
  }
  if (c.online) {
    iniciarOnline();
    return;
  }
  if (c.somenteLeitura || !c.sip) {
    S.ramal = "bloqueado";
    return;
  }
  if (typeof JsSIP === "undefined") {
    S.ramal = "falhou";
    S.ramalDica = "A biblioteca JsSIP não carregou.";
    return;
  }
  if (!window.isSecureContext) {
    S.ramal = "inseguro";
    return;
  }
  try {
    UA = new JsSIP.UA({
      sockets: [new JsSIP.WebSocketInterface(c.sip.wsUrl)],
      uri: "sip:" + c.sip.ramal + "@" + c.sip.dominio,
      password: c.sip.senha,
      display_name: c.sip.nomeExibicao || c.sip.ramal,
      register: true,
      // Sem renovacao de sessao no meio da chamada: o celular gateway so precisa tratar INVITE e BYE.
      session_timers: false
    });
  } catch (e) {
    S.ramal = "falhou";
    S.ramalDica = "Configuração do ramal inválida: " + e.message;
    return;
  }

  UA.on("disconnected", function () {
    S.ramal = "desconectado";
    S.ramalDica = "Sem conexão com " + c.sip.wsUrl + ". Confira se o Asterisk está rodando: sudo systemctl status asterisk";
    render();
  });
  UA.on("registered", function () {
    S.ramal = "registrado";
    S.ramalDica = "";
    render();
  });
  UA.on("unregistered", function () {
    if (S.ramal === "registrado") {
      S.ramal = "desconectado";
      S.ramalDica = "O Asterisk removeu o registro do ramal. Há outra aba da Central aberta?";
      render();
    }
  });
  UA.on("registrationFailed", function (e) {
    var cod = e && e.response ? e.response.status_code : 0;
    S.ramal = "falhou";
    S.ramalDica =
      cod === 401 || cod === 403
        ? "O Asterisk recusou a senha do ramal. SIP_SENHA no .env precisa ser a mesma do pjsip.conf."
        : "O registro do ramal falhou" + (cod ? " (SIP " + cod + ")" : "") + ". Confira o Asterisk: sudo asterisk -rvvv";
    render();
  });
  UA.on("newRTCSession", function (e) {
    var sessao = e.session;
    if (e.originator === "remote") {
      // Uma chamada por vez: o celular gateway so tem uma linha.
      if (S.chamada) {
        sessao.terminate({ status_code: 486, reason_phrase: "Busy Here" });
        return;
      }
      SESSAO = sessao;
      chegouChamada(sessao);
    } else {
      SESSAO = sessao;
    }
    ligarAudioRemoto(sessao);
    ouvirSessao(sessao);
  });
  UA.start();
}

function ligar() {
  if (S.chamada) {
    return;
  }
  var motivo = motivoBloqueio();
  if (motivo) {
    toast(motivo);
    return;
  }
  var r = normalizarNumero(S.numero);
  if (!r.ok) {
    toast(r.erro);
    return;
  }
  pararTesteMic();
  S.chamada = { direcao: "saida", numero: r.numero, estado: "discando", inicio: 0, criadaEm: Date.now(), mudo: false };
  render();
  if (S.config.mock) {
    mockLigar();
    return;
  }
  try {
    SESSAO = UA.call("sip:" + r.numero + "@" + S.config.sip.dominio, {
      mediaConstraints: restricoesMic(),
      // Sem servidor STUN de proposito: na v1 tudo e local e so os candidatos da propria maquina bastam.
      pcConfig: { iceServers: [] },
      rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false }
    });
  } catch (e) {
    limparChamada();
    render();
    toast("Não consegui iniciar a chamada: " + e.message);
  }
}

function desligar() {
  if (!S.chamada) {
    return;
  }
  if (S.config.mock) {
    mockEncerrar();
    return;
  }
  if (SESSAO) {
    SESSAO.terminate();
  }
}

function atender() {
  var c = S.chamada;
  if (!c || c.estado !== "tocando") {
    return;
  }
  tocarCampainha(false);
  c.estado = "atendendo";
  renderChamada();
  if (S.config.mock) {
    mockAtender();
    return;
  }
  SESSAO.answer({
    mediaConstraints: restricoesMic(),
    pcConfig: { iceServers: [] }
  });
}

function recusar() {
  var c = S.chamada;
  if (!c || c.estado !== "tocando") {
    return;
  }
  if (S.config.mock) {
    mockEncerrar();
    return;
  }
  SESSAO.terminate({ status_code: 603, reason_phrase: "Decline" });
}

function alternarMudo() {
  var c = S.chamada;
  if (!c) {
    return;
  }
  c.mudo = !c.mudo;
  if (!S.config.mock && SESSAO) {
    if (c.mudo) {
      SESSAO.mute({ audio: true });
    } else {
      // O padrao do JsSIP no unmute liga o video tambem; aqui so existe audio.
      SESSAO.unmute({ audio: true });
    }
  }
  renderChamada();
}

/** Devolve true se a tecla foi enviada como DTMF (chamada atendida). */
function enviarDtmf(tecla) {
  var c = S.chamada;
  if (!c || c.estado !== "atendida") {
    return false;
  }
  // RFC2833 porque o Asterisk esta com dtmf_mode=rfc4733; o padrao do JsSIP e SIP INFO, que ele ignora.
  if (!S.config.mock && SESSAO) {
    SESSAO.sendDTMF(tecla, { transportType: "RFC2833" });
  }
  return true;
}

/* --- modo MOCK: mesma tela, sem Asterisk --- */

function mockLigar() {
  MOCK_TIMERS.push(
    setTimeout(function () {
      if (S.chamada && S.chamada.estado === "discando") {
        S.chamada.estado = "chamando";
        renderChamada();
      }
    }, 700)
  );
  MOCK_TIMERS.push(
    setTimeout(function () {
      if (S.chamada && !S.chamada.inicio) {
        marcarAtendida();
      }
    }, 2400)
  );
}

function mockChegou() {
  if (S.chamada) {
    toast("Já existe uma chamada em andamento");
    return;
  }
  S.chamada = { direcao: "entrada", numero: "83999998888", estado: "tocando", inicio: 0, criadaEm: Date.now(), mudo: false };
  tocarCampainha(true);
  render();
}

function mockAtender() {
  MOCK_TIMERS.push(
    setTimeout(function () {
      if (S.chamada && !S.chamada.inicio) {
        marcarAtendida();
      }
    }, 500)
  );
}

function mockEncerrar() {
  var c = S.chamada;
  if (!c) {
    return;
  }
  if (c.inicio) {
    finalizarChamada("atendida", "Você desligou");
  } else if (c.direcao === "entrada") {
    finalizarChamada("perdida", "Recusada por você");
  } else {
    finalizarChamada("falha", "Cancelada por você");
  }
}

/* ===== 8b. Audio: escolher e testar o microfone ===== */

function temMidia() {
  return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

function temSaidaEscolhivel() {
  return !!(AUDIO && typeof AUDIO.setSinkId === "function");
}

function temDispositivo(lista, id) {
  for (var i = 0; i < lista.length; i++) {
    if (lista[i].id === id) {
      return true;
    }
  }
  return false;
}

function htmlOpcoes(lista, atual, rotuloGenerico) {
  var h = '<option value=""' + (atual ? "" : " selected") + ">Padrão do sistema</option>";
  for (var i = 0; i < lista.length; i++) {
    var nome = lista[i].nome || rotuloGenerico + " " + (i + 1);
    h += '<option value="' + esc(lista[i].id) + '"' + (lista[i].id === atual ? " selected" : "") + ">" + esc(nome) + "</option>";
  }
  return h;
}

/** Monta o cartao. So e refeito quando a lista de dispositivos muda: refazer fecharia um seletor aberto. */
function renderAudio() {
  var el = $("#blocoAudio");
  if (!el) {
    return;
  }
  var a = S.audio;
  var h =
    '<section class="ch-audio" aria-label="Teste de áudio">' +
    '<div class="ch-audio-topo"><strong>Áudio</strong><span class="ch-audio-estado" id="audioEstado"></span></div>' +
    '<label class="ch-audio-rot" for="selMic">Microfone</label>' +
    '<select class="ch-select" id="selMic">' + htmlOpcoes(a.entradas, a.idMic, "Microfone") + "</select>";
  if (temSaidaEscolhivel()) {
    h +=
      '<label class="ch-audio-rot" for="selSaida">Saída de som</label>' +
      '<select class="ch-select" id="selSaida">' + htmlOpcoes(a.saidas, a.idSaida, "Saída") + "</select>";
  }
  h +=
    '<div class="ch-medidor" aria-hidden="true"><div class="ch-medidor-barra" id="medidorBarra"></div></div>' +
    '<div class="ch-audio-acoes">' +
    '<button class="btn btn-suave" id="btnTestarMic" data-acao="testar-mic">Testar microfone</button>' +
    '<button class="btn btn-suave" id="btnGravar" data-acao="gravar-teste">Gravar 3 s e ouvir</button></div>' +
    '<p class="ch-dica ch-audio-msg" id="audioMsg" role="status" aria-live="polite"></p></section>';
  el.innerHTML = h;
  atualizarAudio();
}

function rotuloEstadoMic() {
  var a = S.audio;
  if (!temMidia()) {
    return "indisponível";
  }
  if (a.testando && MIC_NOME) {
    return "usando: " + MIC_NOME;
  }
  if (a.permissao === "ok") {
    return "liberado";
  }
  if (a.permissao === "negada") {
    return "bloqueado";
  }
  return "ainda não testado";
}

function desenharMedidor() {
  var b = $("#medidorBarra");
  if (b) {
    b.style.width = Math.round(MIC_NIVEL * 100) + "%";
  }
}

/** Atualiza botoes, textos e medidor sem refazer o HTML (igual ao atualizarDiscador). */
function atualizarAudio() {
  var bt = $("#btnTestarMic");
  if (!bt) {
    return;
  }
  var a = S.audio;
  var emChamada = !!S.chamada;
  var ocupado = a.gravando || a.ouvindo;
  bt.textContent = a.testando || a.abrindo ? "Parar teste" : "Testar microfone";
  bt.disabled = emChamada || ocupado;
  var bg = $("#btnGravar");
  bg.textContent = a.gravando ? "Gravando..." : a.ouvindo ? "Tocando..." : "Gravar 3 s e ouvir";
  bg.disabled = emChamada || ocupado || a.abrindo;
  $("#selMic").disabled = emChamada || a.gravando;
  $("#audioEstado").textContent = rotuloEstadoMic();
  var texto = a.msg || MSG_AUDIO_INICIAL;
  if (!temMidia()) {
    texto = MSG_SEM_MIDIA;
  } else if (emChamada) {
    texto = "Em chamada: o microfone só pode ser trocado antes de ligar.";
  }
  var m = $("#audioMsg");
  if (m.textContent !== texto) {
    m.textContent = texto;
  }
  desenharMedidor();
}

function listarDispositivos() {
  if (!temMidia() || !navigator.mediaDevices.enumerateDevices) {
    return Promise.resolve();
  }
  return navigator.mediaDevices.enumerateDevices().then(
    function (lista) {
      var ent = [];
      var sai = [];
      for (var i = 0; i < lista.length; i++) {
        var d = lista[i];
        if (!d.deviceId) {
          continue; // sem permissao o navegador esconde id e nome
        }
        if (d.kind === "audioinput") {
          ent.push({ id: d.deviceId, nome: d.label });
        } else if (d.kind === "audiooutput") {
          sai.push({ id: d.deviceId, nome: d.label });
        }
      }
      var a = S.audio;
      a.entradas = ent;
      a.saidas = sai;
      if (a.idMic && ent.length && !temDispositivo(ent, a.idMic)) {
        a.idMic = "";
        a.msg = "O microfone escolhido saiu da lista. Voltei para o padrão do sistema.";
      }
      if (a.idSaida && sai.length && !temDispositivo(sai, a.idSaida)) {
        a.idSaida = "";
        aplicarSaida(AUDIO);
      }
      renderAudio();
    },
    function () {}
  );
}

function iniciarDispositivos() {
  listarDispositivos();
  if (temMidia() && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", function () {
      listarDispositivos();
    });
  }
}

/** Restricoes usadas no teste E na chamada: o que voce testou e o que a chamada usa. */
function restricoesMic() {
  var id = S.audio.idMic;
  return { audio: id ? { deviceId: { exact: id } } : true, video: false };
}

function textoErroMic(e) {
  var n = e && e.name;
  if (n === "NotAllowedError" || n === "SecurityError" || n === "PermissionDeniedError") {
    return "O navegador bloqueou o microfone. Clique no cadeado ao lado do endereço, libere o microfone e tente de novo.";
  }
  if (n === "NotFoundError" || n === "OverconstrainedError") {
    return "Esse microfone não foi encontrado. Escolha outro na lista ou conecte o microfone.";
  }
  if (n === "NotReadableError" || n === "AbortError") {
    return "Não consegui abrir o microfone: outro programa pode estar usando, ou o sistema o bloqueou.";
  }
  return "Não consegui abrir o microfone" + (e && e.message ? " (" + e.message + ")" : "") + ".";
}

function fecharFluxo(fluxo) {
  var trilhas = fluxo && fluxo.getTracks ? fluxo.getTracks() : [];
  for (var i = 0; i < trilhas.length; i++) {
    trilhas[i].onended = null;
    trilhas[i].stop();
  }
}

function aplicarSaida(el) {
  if (!el || typeof el.setSinkId !== "function") {
    return Promise.resolve();
  }
  var p = el.setSinkId(S.audio.idSaida || "");
  if (!p || !p.catch) {
    return Promise.resolve();
  }
  return p.catch(function () {
    toast("Não consegui usar essa saída de som");
  });
}

/** Liga o medidor de nivel. Devolve false se o navegador nao tem Web Audio (o gravar e ouvir ainda funciona). */
function abrirMedidor(fluxo) {
  var Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    return false;
  }
  try {
    MIC_CTX = new Ctx();
    if (MIC_CTX.state === "suspended") {
      MIC_CTX.resume();
    }
    var fonte = MIC_CTX.createMediaStreamSource(fluxo);
    MIC_ANALISADOR = MIC_CTX.createAnalyser();
    MIC_ANALISADOR.fftSize = 1024;
    // Sem ligar na saida de som: so mede, nao devolve a sua voz no alto-falante.
    fonte.connect(MIC_ANALISADOR);
    MIC_BUFFER = new Uint8Array(MIC_ANALISADOR.fftSize);
    MIC_INICIO = Date.now();
    MIC_PICO = 0;
    MIC_NIVEL = 0;
    TIMER_MEDIDOR = setInterval(medirMic, 100);
    return true;
  } catch (e) {
    MIC_ANALISADOR = null;
    return false;
  }
}

function textoDoTeste() {
  if (MIC_PICO >= MIC_VOZ) {
    return "Está captando a sua voz. Esse microfone funciona.";
  }
  if (Date.now() - MIC_INICIO < 4000) {
    return "";
  }
  if (MIC_PICO < MIC_MUDO) {
    return "Sem sinal nenhum. Esse microfone não está captando: troque na lista ou confira se ele está mudo no sistema.";
  }
  return "Sinal muito fraco. Chegue mais perto ou aumente o volume de entrada nas configurações de som.";
}

function medirMic() {
  if (!MIC_ANALISADOR) {
    return;
  }
  MIC_ANALISADOR.getByteTimeDomainData(MIC_BUFFER);
  var soma = 0;
  for (var i = 0; i < MIC_BUFFER.length; i++) {
    var v = (MIC_BUFFER[i] - 128) / 128;
    soma += v * v;
  }
  var rms = Math.sqrt(soma / MIC_BUFFER.length);
  if (rms > MIC_PICO) {
    MIC_PICO = rms;
  }
  var a = S.audio;
  if (a.gravando && rms > MIC_PICO_GRAVACAO) {
    MIC_PICO_GRAVACAO = rms;
  }
  // Escala em decibeis: -60 dB (silencio) a -15 dB (voz alta) vira 0 a 100% da barra.
  var db = (20 * Math.log(Math.max(rms, 0.00001))) / Math.LN10;
  var alvo = Math.min(1, Math.max(0, (db + 60) / 45));
  MIC_NIVEL = Math.max(alvo, MIC_NIVEL * 0.85);
  desenharMedidor();
  if (a.gravando || a.ouvindo) {
    return;
  }
  var texto = textoDoTeste();
  if (texto && texto !== a.msg) {
    a.msg = texto;
    atualizarAudio();
  }
}

function cancelarGravacao() {
  clearTimeout(TIMER_GRAVACAO);
  TIMER_GRAVACAO = 0;
  if (GRAVADOR) {
    var gr = GRAVADOR;
    GRAVADOR = null;
    gr.onstop = null;
    gr.ondataavailable = null;
    try {
      gr.stop();
    } catch (e) {}
  }
  S.audio.gravando = false;
}

function pararReproducao() {
  var r = REPRODUCAO;
  REPRODUCAO = null;
  S.audio.ouvindo = false;
  if (!r) {
    return;
  }
  r.el.onended = null;
  r.el.onerror = null;
  try {
    r.el.pause();
  } catch (e) {}
  if (window.URL && URL.revokeObjectURL) {
    URL.revokeObjectURL(r.url);
  }
}

/** Para tudo (medidor, gravacao, reproducao) e solta o microfone. Se vier texto, ele vira a mensagem do cartao. */
function pararTesteMic(msg) {
  var a = S.audio;
  MIC_GERACAO++;
  cancelarGravacao();
  pararReproducao();
  clearInterval(TIMER_MEDIDOR);
  TIMER_MEDIDOR = 0;
  clearTimeout(TIMER_MIC);
  TIMER_MIC = 0;
  if (MIC_STREAM) {
    fecharFluxo(MIC_STREAM);
    MIC_STREAM = null;
  }
  if (MIC_CTX) {
    try {
      var p = MIC_CTX.close();
      if (p && p.catch) {
        p.catch(function () {});
      }
    } catch (e) {}
    MIC_CTX = null;
  }
  MIC_ANALISADOR = null;
  MIC_NIVEL = 0;
  MIC_NOME = "";
  a.testando = false;
  a.abrindo = false;
  if (msg !== undefined) {
    a.msg = msg;
  }
  atualizarAudio();
}

/** Abre o microfone escolhido e liga o medidor. Resolve com o fluxo; em erro a mensagem do cartao ja foi escrita. */
function iniciarTesteMic() {
  var a = S.audio;
  if (MIC_STREAM) {
    return Promise.resolve(MIC_STREAM);
  }
  if (a.abrindo) {
    return Promise.reject(new Error("abrindo"));
  }
  if (!temMidia()) {
    a.msg = MSG_SEM_MIDIA;
    atualizarAudio();
    return Promise.reject(new Error("sem midia"));
  }
  var geracao = ++MIC_GERACAO;
  a.abrindo = true;
  a.msg = "Permita o microfone no aviso do navegador...";
  atualizarAudio();
  return navigator.mediaDevices.getUserMedia(restricoesMic()).then(
    function (fluxo) {
      if (geracao !== MIC_GERACAO) {
        fecharFluxo(fluxo); // a pessoa parou o teste enquanto o aviso de permissao estava aberto
        throw new Error("cancelado");
      }
      a.abrindo = false;
      a.permissao = "ok";
      MIC_STREAM = fluxo;
      var trilha = fluxo.getAudioTracks ? fluxo.getAudioTracks()[0] : null;
      MIC_NOME = trilha && trilha.label ? trilha.label : "";
      if (trilha) {
        trilha.onended = function () {
          if (MIC_STREAM === fluxo) {
            pararTesteMic("O microfone foi desconectado.");
          }
        };
      }
      a.testando = true;
      a.msg = abrirMedidor(fluxo)
        ? "Fale algo: a barra verde precisa mexer."
        : "Este navegador não mostra o medidor. Use Gravar 3 s e ouvir.";
      TIMER_MIC = setTimeout(function () {
        pararTesteMic("Teste encerrado. Clique em Testar microfone para repetir.");
      }, MIC_TESTE_MAX_MS);
      listarDispositivos(); // agora com permissao: nomes aparecem
      atualizarAudio();
      return fluxo;
    },
    function (e) {
      if (geracao === MIC_GERACAO) {
        a.abrindo = false;
        a.testando = false;
        a.msg = textoErroMic(e);
        if (e && (e.name === "NotAllowedError" || e.name === "SecurityError" || e.name === "PermissionDeniedError")) {
          a.permissao = "negada";
        }
        if (e && (e.name === "NotFoundError" || e.name === "OverconstrainedError") && a.idMic) {
          a.idMic = "";
          a.msg = "Esse microfone não foi encontrado. Voltei para o padrão do sistema: clique em Testar microfone de novo.";
          renderAudio();
        }
        atualizarAudio();
      }
      throw e;
    }
  );
}

function alternarTesteMic() {
  var a = S.audio;
  if (S.chamada || a.gravando || a.ouvindo) {
    return;
  }
  if (a.testando || a.abrindo) {
    pararTesteMic("Teste encerrado.");
  } else {
    iniciarTesteMic().catch(function () {});
  }
}

function reproduzir(blob, pico) {
  var a = S.audio;
  if (pico >= 0 && pico < MIC_MUDO) {
    a.msg = "A gravação saiu muda. Esse microfone não está captando: troque na lista ou confira se ele está mudo no sistema.";
    atualizarAudio();
    return;
  }
  if (!window.URL || !URL.createObjectURL || typeof Audio === "undefined") {
    a.msg = "Gravei, mas este navegador não toca a gravação.";
    atualizarAudio();
    return;
  }
  var url = URL.createObjectURL(blob);
  var el = new Audio(url);
  function falhou() {
    if (REPRODUCAO && REPRODUCAO.el === el) {
      pararReproducao();
      a.msg = "O navegador não deixou tocar a gravação. Clique em Gravar de novo.";
      atualizarAudio();
    }
  }
  el.onended = function () {
    if (REPRODUCAO && REPRODUCAO.el === el) {
      pararReproducao();
      a.msg = "Terminou. Se você ouviu a sua voz, o microfone e a saída de som estão certos.";
      atualizarAudio();
    }
  };
  el.onerror = falhou;
  REPRODUCAO = { el: el, url: url };
  a.ouvindo = true;
  a.msg = "Tocando o que foi gravado...";
  atualizarAudio();
  aplicarSaida(el)
    .then(function () {
      var p = el.play();
      return p && p.then ? p : undefined;
    })
    .catch(falhou);
}

function gravarEOuvir() {
  var a = S.audio;
  if (S.chamada || a.gravando || a.ouvindo || a.abrindo) {
    return;
  }
  if (typeof MediaRecorder === "undefined") {
    a.msg = "Este navegador não grava o áudio de teste. Use o medidor (Testar microfone).";
    atualizarAudio();
    return;
  }
  var tinhaTeste = a.testando;
  iniciarTesteMic()
    .then(function (fluxo) {
      var pedacos = [];
      var gr;
      function falha() {
        cancelarGravacao();
        a.msg = "Não consegui gravar neste navegador. Use o medidor (Testar microfone).";
        if (!tinhaTeste) {
          pararTesteMic();
        }
        atualizarAudio();
      }
      try {
        gr = new MediaRecorder(fluxo);
        gr.ondataavailable = function (ev) {
          if (ev.data && ev.data.size) {
            pedacos.push(ev.data);
          }
        };
        gr.onstop = function () {
          if (GRAVADOR !== gr) {
            return;
          }
          GRAVADOR = null;
          clearTimeout(TIMER_GRAVACAO);
          TIMER_GRAVACAO = 0;
          a.gravando = false;
          var pico = MIC_ANALISADOR ? MIC_PICO_GRAVACAO : -1;
          if (!tinhaTeste) {
            pararTesteMic();
          }
          reproduzir(new Blob(pedacos, { type: gr.mimeType || "audio/webm" }), pico);
        };
        GRAVADOR = gr;
        MIC_PICO_GRAVACAO = 0;
        a.gravando = true;
        a.msg = "Gravando 3 segundos. Fale agora...";
        gr.start();
        TIMER_GRAVACAO = setTimeout(function () {
          if (GRAVADOR === gr) {
            try {
              gr.stop();
            } catch (e) {
              falha();
            }
          }
        }, 3000);
      } catch (e) {
        falha();
        return;
      }
      atualizarAudio();
    })
    .catch(function () {});
}

function escolherMic(id) {
  var a = S.audio;
  a.idMic = id || "";
  if (a.testando || a.abrindo) {
    pararTesteMic();
    iniciarTesteMic().catch(function () {});
  } else {
    a.msg = "Microfone escolhido. Clique em Testar microfone para conferir.";
    atualizarAudio();
  }
}

function escolherSaida(id) {
  S.audio.idSaida = id || "";
  aplicarSaida(AUDIO);
  S.audio.msg = "Saída escolhida. Use Gravar 3 s e ouvir para conferir.";
  atualizarAudio();
}

/* --- diagnostico do audio durante a chamada (RTCPeerConnection.getStats) --- */

function pararDiagnostico() {
  clearInterval(TIMER_DIAGNOSTICO);
  TIMER_DIAGNOSTICO = 0;
  DIAG = null;
}

function iniciarDiagnostico() {
  pararDiagnostico();
  if (!S.config || S.config.mock) {
    return;
  }
  DIAG = { env: -1, rec: -1, semEnv: 0, semRec: 0, pico: -1, n: 0 };
  TIMER_DIAGNOSTICO = setInterval(medirAudioChamada, 1000);
}

function textoDiagnostico(d) {
  if (d.n < 4) {
    return "Áudio: verificando...";
  }
  if (d.semEnv >= 3) {
    return "Áudio: o navegador não está enviando som. Confira o microfone no cartão Áudio.";
  }
  if (d.semRec >= 4) {
    if (S.config && S.config.online) {
      return "Áudio: nada chega do celular pelo relay. Veja a aba Registro (o app precisa estar com Take over calls ligado).";
    }
    return "Áudio: nada chega do Asterisk (rede, ICE ou DTLS). Não é o microfone.";
  }
  if (AUDIO && AUDIO.srcObject && AUDIO.paused) {
    return "Áudio: o som chegou, mas o navegador não está tocando. Clique na página.";
  }
  if (d.n >= 6 && d.pico >= 0 && d.pico < 0.005) {
    return "Áudio: o som trafega, mas o microfone não captou nada até agora. Fale algo; se continuar assim, troque de microfone.";
  }
  return "Áudio: trafegando nos dois sentidos.";
}

function escreverDiagnostico(c, texto) {
  if (c.audioMsg === texto) {
    return;
  }
  c.audioMsg = texto;
  var el = $("#chAudio");
  if (el) {
    el.textContent = texto;
  }
}

function aplicarMedicao(c, d, env, rec, nivel) {
  d.n++;
  if (env > d.env) {
    d.env = env;
    d.semEnv = 0;
  } else {
    d.semEnv++;
  }
  if (rec > d.rec) {
    d.rec = rec;
    d.semRec = 0;
  } else {
    d.semRec++;
  }
  if (nivel > d.pico) {
    d.pico = nivel;
  }
  escreverDiagnostico(c, textoDiagnostico(d));
}

function medirAudioChamada() {
  var c = S.chamada;
  var d = DIAG;
  if (c && d && c.estado === "atendida" && SESSAO && typeof SESSAO.estatisticas === "function") {
    // Modo online: o proprio ramal online conta os quadros (nao ha WebRTC para perguntar).
    var st = SESSAO.estatisticas();
    aplicarMedicao(c, d, st.env, st.rec, st.nivel);
    return;
  }
  var pc = SESSAO && SESSAO.connection;
  if (!c || !d || c.estado !== "atendida" || !pc || typeof pc.getStats !== "function") {
    return;
  }
  pc.getStats().then(
    function (rel) {
      if (S.chamada !== c || DIAG !== d) {
        return;
      }
      var env = -1;
      var rec = -1;
      var nivel = -1;
      rel.forEach(function (r) {
        if ((r.kind || r.mediaType) !== "audio") {
          return;
        }
        if (r.type === "outbound-rtp" && typeof r.packetsSent === "number") {
          env = r.packetsSent;
        } else if (r.type === "inbound-rtp" && typeof r.packetsReceived === "number") {
          rec = r.packetsReceived;
        } else if (r.type === "media-source" && typeof r.audioLevel === "number") {
          nivel = r.audioLevel;
        }
      });
      aplicarMedicao(c, d, env, rec, nivel);
    },
    function () {}
  );
}

/* ===== 8c. Conectar celular (QR para o app Voice SIP Agent) ===== */

// O painel tem tres abas. "1. Baixar o app": QR com o link do APK que a Central serve (pasta apk-celular/).
// "2. Configurar": QR com o JSON de configuracao que o app sabe importar, mais a chave extra "adbPairing"
// (nome e senha de pareamento, sorteados a cada abertura do painel). "3. Parear": o QR que a tela
// "Parear dispositivo com codigo QR" da Depuracao sem fio do Android le (WIFI:T:ADB;S:nome;P:senha;;), com o
// mesmo nome e a mesma senha: o app, que recebeu os dois pela aba 2, pareia sozinho. Tudo e montado aqui no
// navegador com o que o servidor entrega (/api/apk e /api/celular, so ao proprio PC) e nao e gravado.
var QR_VISIVEL_MS = 120000;
var CEL_CONSULTA_MS = 5000;
var TIMER_CEL_CONSULTA = 0;
var TIMER_CEL_QR = 0;
var TIMER_CEL_LIMPAR = 0;
var COMANDO_APK = "python3 -m zipfile -e ~/Downloads/voice-sip-agent-apk.zip modulos/central/apk-celular";
S.celular = null; // { aba, carregando, erro, dados, apk, apkErro, ips, ip, outro, par, relato, qrVisivel, viuOffline }

function ipValido(ip) {
  var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || "").trim());
  if (!m) {
    return false;
  }
  for (var i = 1; i <= 4; i++) {
    if (Number(m[i]) > 255) {
      return false;
    }
  }
  return true;
}

function celularConectado() {
  var e = S.estado;
  return !!(e && e.ari && e.ari.ok && e.gateway && e.gateway.estado === "online");
}

function tamanhoTxt(bytes) {
  return (Number(bytes) / 1048576).toFixed(1).replace(".", ",") + " MB";
}

// 32 simbolos (base32 em minusculas): 256 e multiplo de 32, entao o sorteio por resto nao tem vies.
var ALFABETO_PAR = "abcdefghijklmnopqrstuvwxyz234567";

/** n caracteres sorteados com o gerador seguro do navegador. So letras e numeros: vao em QR e em JSON sem escape. */
function sorteio(n) {
  var bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  var s = "";
  for (var i = 0; i < n; i++) {
    s += ALFABETO_PAR.charAt(bytes[i] % ALFABETO_PAR.length);
  }
  return s;
}

/** Nome e senha do pareamento desta abertura do painel (o mesmo par vai na aba 2 e na aba 3). */
function novoPareamento() {
  return { nome: "studio-" + sorteio(10), senha: sorteio(12) };
}

/** O JSON que o app importa (formato voice-sip-agent-config v1). So as chaves que a Central conhece. */
function jsonCelular() {
  if (S.config && S.config.online) {
    return jsonCelularOnline();
  }
  var c = S.celular;
  var d = c && c.dados;
  if (!d) {
    return "";
  }
  var cfg = {
    format: "voice-sip-agent-config",
    version: 1,
    sip: { server: String(c.ip).trim(), port: d.porta, transport: "udp", srtp: "off", domain: "", user: d.usuario, password: d.senha },
    routing: { target: d.usuario }
  };
  if (c.par) {
    // Chaves extras que so o nosso app entende: ele as separa antes de ler o arquivo.
    cfg.adbPairing = { name: c.par.nome, password: c.par.senha };
    // Onde o app conta em que passo da configuracao esta (a lista ao vivo do painel).
    var central = urlCentral();
    if (central) {
      cfg.central = { url: central };
    }
  }
  return JSON.stringify(cfg);
}

/** Endereco da Central visto pelo celular (o IP escolhido no painel), sem a barra final. */
function urlCentral() {
  var c = S.celular;
  if (!c || !c.ip || !String(c.ip).trim()) {
    return "";
  }
  return location.protocol + "//" + String(c.ip).trim() + (location.port ? ":" + location.port : "") + BASE;
}

/** O QR que o Android le em "Parear dispositivo com codigo QR": WIFI:T:ADB;S:nome;P:senha;; */
function textoPar() {
  var c = S.celular;
  return c && c.par ? "WIFI:T:ADB;S:" + c.par.nome + ";P:" + c.par.senha + ";;" : "";
}

/** O link que o celular abre para baixar o APK: IP escolhido, mesma porta desta pagina. */
function urlApk() {
  var c = S.celular;
  var a = c && c.apk && c.apk.apk;
  if (!a || !ipValido(c.ip)) {
    return "";
  }
  return location.protocol + "//" + String(c.ip).trim() + (location.port ? ":" + location.port : "") + BASE + "/apk/" + encodeURIComponent(a.nome);
}

/** Desenha o QR como SVG (um unico path). As cores vem do CSS, por token. */
function svgQr(texto) {
  var q = qrcode(0, "M");
  q.addData(texto);
  q.make();
  var n = q.getModuleCount();
  var margem = 4;
  var d = "";
  for (var r = 0; r < n; r++) {
    for (var col = 0; col < n; col++) {
      if (q.isDark(r, col)) {
        d += "M" + (col + margem) + " " + (r + margem) + "h1v1h-1z";
      }
    }
  }
  var lado = n + 2 * margem;
  return (
    '<svg class="ch-qr-svg" viewBox="0 0 ' + lado + " " + lado + '" role="img"' +
    ' aria-label="QR code" shape-rendering="crispEdges"><path d="' + d + '"></path></svg>'
  );
}

function avisoCelular(titulo, dica) {
  return '<p class="ch-cel-aviso"><strong>' + esc(titulo) + "</strong>" + (dica ? "<br>" + esc(dica) : "") + "</p>";
}

/** QR pronto para a tela, ou o aviso do que faltou. */
function htmlQr(texto) {
  if (typeof qrcode === "undefined") {
    return avisoCelular("A biblioteca de QR não carregou", "Falta o arquivo vendor/qrcode.js.");
  }
  try {
    return '<div class="ch-qr">' + svgQr(texto) + "</div>";
  } catch (err) {
    return avisoCelular("Não consegui gerar o QR", err.message);
  }
}

function renderCelAba() {
  var c = S.celular;
  var caixa = $("#chCelAbas");
  if (!caixa || !c) {
    return;
  }
  var botoes = caixa.querySelectorAll("[data-valor]");
  for (var i = 0; i < botoes.length; i++) {
    var ativo = botoes[i].getAttribute("data-valor") === c.aba;
    botoes[i].classList.toggle("ativo", ativo);
    botoes[i].setAttribute("aria-selected", ativo ? "true" : "false");
    if (ativo) {
      caixa.style.setProperty("--i", String(i));
    }
  }
  $("#chCelApk").hidden = c.aba !== "apk";
  $("#chCelCfg").hidden = c.aba !== "config";
  $("#chCelPar").hidden = c.aba !== "par";
  $("#chCelRelato").hidden = c.aba === "apk";
  var ipCaixa = $("#chCelIp");
  if (ipCaixa) {
    ipCaixa.hidden = c.aba === "par"; // o QR de pareamento nao depende do IP
  }
}

function c0online() {
  return !!(S.celular && S.celular.online);
}

function renderCelEstado() {
  var el = $("#chCelEstado");
  if (!el) {
    return;
  }
  var e = S.estado;
  var nivel = "espera";
  var titulo = "Consultando";
  var texto = "Perguntando ao Asterisk...";
  if (c0online() && !celularConectado()) {
    var fase = Online.estado().fase;
    nivel = fase === "online" ? "aviso" : "espera";
    titulo = fase === "online" ? "Aguardando o celular" : "Entre na Central primeiro";
    texto = fase === "online" ? "Siga os passos desta aba. Esta tela avisa quando o celular entrar no relay." : "Digite o código de acesso na tela principal.";
  } else if (celularConectado()) {
    nivel = "ok";
    titulo = "Celular conectado";
    texto = c0online() ? "O relay já vê o celular conectado." : "O Asterisk já vê o celular registrado.";
  } else if (e && e.ari && !e.ari.ok) {
    nivel = "aviso";
    titulo = "Sem resposta do Asterisk";
    texto = e.ari.erro || "";
  } else if (e) {
    titulo = "Aguardando o celular";
    texto = "Siga os passos desta aba. Esta tela avisa quando o celular registrar.";
  }
  var linha =
    '<span class="ch-ponto ch-n-' + nivel + '"></span>' +
    '<div class="ch-linha-txt"><strong>' + esc(titulo) + "</strong><span>" + esc(texto) + "</span></div>";
  el.innerHTML = linha;
  var outra = $("#chCelEstadoPar");
  if (outra) {
    outra.innerHTML = linha;
  }
}

function renderCelApk() {
  var el = $("#chCelApkCorpo");
  var c = S.celular;
  if (!el || !c) {
    return;
  }
  if (c.carregando) {
    el.innerHTML = '<p class="ch-dica">Carregando...</p>';
    return;
  }
  if (c.apkErro) {
    el.innerHTML = avisoCelular(c.apkErro.message, c.apkErro.dica);
    return;
  }
  if (c.online) {
    el.innerHTML = htmlApkOnline();
    return;
  }
  var a = c.apk && c.apk.apk;
  if (!a) {
    el.innerHTML =
      '<p class="ch-cel-aviso"><strong>Ainda não há APK na pasta da Central</strong><br>' +
      "Baixe o artefato voice-sip-agent-apk da execução do workflow no GitHub e, no terminal, na pasta do projeto, rode:</p>" +
      '<pre class="ch-cel-cmd">' + esc(COMANDO_APK) + "</pre>" +
      '<div class="ch-cel-botoes">' +
      '<button class="btn btn-suave" data-acao="copiar-texto" data-texto="' + esc(COMANDO_APK) + '" data-aviso="Comando copiado">Copiar comando</button>' +
      '<button class="btn btn-suave" data-acao="celular-reler">Procurar de novo</button></div>';
    return;
  }
  if (!ipValido(c.ip)) {
    el.innerHTML = avisoCelular("Informe o IP deste computador na rede", "Algo como 192.168.0.10. No terminal: hostname -I");
    return;
  }
  var url = urlApk();
  el.innerHTML =
    '<ol class="ch-cel-passos">' +
    "<li>No celular, abra a câmera e aponte para o QR (celular e computador na mesma rede Wi-Fi).</li>" +
    "<li>Toque no link e baixe o arquivo. Se o Chrome avisar que o download é inseguro ou perigoso, escolha baixar mesmo assim: é o seu próprio APK, servido por este computador.</li>" +
    "<li>Abra o arquivo baixado. O Android pede para permitir instalar apps desconhecidos para o navegador.</li>" +
    "<li>Depois volte aqui e abra <strong>2. Configurar</strong>.</li></ol>" +
    '<div class="ch-qr-caixa">' + htmlQr(url) +
    '<p class="ch-cel-arq"><strong>' + esc(a.nome) + "</strong><br>" + esc(tamanhoTxt(a.tamanho)) + " · SHA-256 " + esc(String(a.sha256).slice(0, 16)) + "...</p>" +
    '<p class="ch-cel-url">' + esc(url) + "</p>" +
    '<div class="ch-cel-botoes">' +
    '<button class="btn btn-suave" data-acao="copiar-texto" data-texto="' + esc(url) + '" data-aviso="Link copiado">Copiar link</button>' +
    '<button class="btn btn-suave" data-acao="celular-reler">Procurar de novo</button></div></div>';
}

function renderCelQr() {
  var el = $("#chCelQr");
  var c = S.celular;
  if (!el || !c) {
    return;
  }
  if (c.carregando) {
    el.innerHTML = '<p class="ch-dica">Carregando as configurações...</p>';
    return;
  }
  if (c.erro) {
    el.innerHTML = avisoCelular(c.erro.message, c.erro.dica);
    return;
  }
  if (c.online && !Online.estado().tokenCelular) {
    el.innerHTML = avisoCelular("Entre na Central primeiro", "O QR leva o endereço do relay e a senha do celular, que só existem depois que você entra com o código de acesso.");
    return;
  }
  if (!c.online && !ipValido(c.ip)) {
    el.innerHTML = avisoCelular("Informe o IP deste computador na rede", "Algo como 192.168.0.10. No terminal: hostname -I");
    return;
  }
  var h;
  if (!c.qrVisivel) {
    h = '<p class="ch-dica">QR escondido por segurança.</p>';
  } else {
    var json = jsonCelular();
    if (!/^[\x20-\x7e]+$/.test(json)) {
      h = avisoCelular("A senha tem caractere fora do ASCII", "O QR não leva acentos. Rode de novo o instalar.sh para gerar uma senha nova.");
    } else {
      h = htmlQr(json);
    }
  }
  el.innerHTML =
    '<div class="ch-qr-caixa">' + h +
    '<button class="btn btn-suave" data-acao="celular-qr">' + (c.qrVisivel ? "Esconder QR" : "Mostrar QR") + "</button></div>";
}

/**
 * Os passos do celular ao vivo, a partir do que o app relata (POST /api/celular/relato). O app so comeca a
 * relatar depois de ler o QR da aba 2. O primeiro passo que falta mostra o motivo; os seguintes ficam em espera.
 */
function renderCelRelato() {
  var el = $("#chCelRelato");
  var c = S.celular;
  if (!el || !c) {
    return;
  }
  var r = c.relato;
  if (!r) {
    el.innerHTML = celularConectado()
      ? ""
      : '<p class="ch-dica">Ainda não recebi nada do app. Depois de escanear o QR da aba 2 no app, os passos do celular aparecem aqui ao vivo' +
        (c.online ? " (basta o celular ter internet)." : " (o celular precisa estar na mesma rede que este computador).") + "</p>";
    return;
  }
  var falhou = r.helper === "PAIRING_FAILED" || r.helper === "ERROR";
  var passos = [
    { ok: r.configurado, nome: "Servidor configurado no app", falta: "No app, depois de escanear o QR da aba 2, toque em Import." },
    {
      ok: r.pareado,
      nome: "Pareado com a Depuração sem fio",
      falta: r.helper === "PAIRING_FAILED" && r.helperDetalhe
        ? "O pareamento falhou: " + r.helperDetalhe
        : "Faça a aba 3: Depuração sem fio, Parear dispositivo com código QR."
    },
    { ok: r.helper === "CONNECTED", nome: "Acesso privilegiado (helper)", falta: r.helperDetalhe || r.helper },
    { ok: r.acesso, nome: "Acesso às chamadas", falta: r.detalhe },
    { ok: r.audio, nome: "Áudio das chamadas", falta: r.detalhe },
    c.online
      ? { ok: Online.estado().telefone, nome: "Conectado ao relay (online)", falta: r.sipDetalhe || r.detalhe || "O app ainda não entrou no relay." }
      : { ok: r.sip, nome: "Registro no Asterisk", falta: r.sipDetalhe || r.detalhe }
  ];
  var achouFalta = false;
  var h = '<p class="ch-dica"><strong>Passo a passo do celular (ao vivo)</strong></p>';
  for (var i = 0; i < passos.length; i++) {
    var p = passos[i];
    var nivel = "ok";
    var txt = "";
    if (!p.ok) {
      if (!achouFalta) {
        achouFalta = true;
        nivel = falhou && i === 2 ? "erro" : "aviso";
        txt = p.falta || "";
      } else {
        nivel = "espera";
      }
    }
    h +=
      '<div class="ch-linha"><span class="ch-ponto ch-n-' + nivel + '"></span>' +
      '<div class="ch-linha-txt"><strong>' + esc(p.nome) + "</strong>" + (txt ? "<span>" + esc(txt) + "</span>" : "") + "</div></div>";
  }
  if (r.idadeMs > 20000 && !(c.online && Online.estado().telefone)) {
    h +=
      '<p class="ch-cel-aviso">Sem notícias do app há ' + Math.round(r.idadeMs / 1000) +
      " s. Ele pode ter sido fechado ou ter saído da rede.</p>";
  }
  h +=
    '<details class="ch-cel-log"><summary>Registro do app (para suporte)</summary><pre class="ch-cel-cmd">' +
    esc((r.android ? "Android " + r.android + "\n" : "") + (r.log || []).join("\n")) +
    "</pre></details>";
  el.innerHTML = h;
}

/** O QR da aba 3 (pareamento). Segue o mesmo "esconder por seguranca" do QR da aba 2. */
function renderCelParQr() {
  var el = $("#chCelParQr");
  var c = S.celular;
  if (!el || !c) {
    return;
  }
  var h = c.qrVisivel ? htmlQr(textoPar()) : '<p class="ch-dica">QR escondido por segurança.</p>';
  el.innerHTML =
    '<div class="ch-qr-caixa">' + h +
    '<button class="btn btn-suave" data-acao="celular-qr">' + (c.qrVisivel ? "Esconder QR" : "Mostrar QR") + "</button></div>";
}

function renderCelIp() {
  var el = $("#chCelIp");
  var c = S.celular;
  if (!el) {
    return;
  }
  if (!c || c.online || c.carregando || (!c.dados && !c.apk)) {
    el.innerHTML = "";
    return;
  }
  var ips = c.ips || [];
  var h = '<div class="ch-cel-ip"><label class="ch-audio-rot" for="selCelularIp">IP deste computador na rede</label>';
  if (ips.length) {
    h += '<select id="selCelularIp" class="ch-select">';
    for (var i = 0; i < ips.length; i++) {
      var sel = !c.outro && c.ip === ips[i].ip ? " selected" : "";
      h += '<option value="' + esc(ips[i].ip) + '"' + sel + ">" + esc(ips[i].ip + " (" + ips[i].interface + ")") + "</option>";
    }
    h += '<option value="__outro"' + (c.outro ? " selected" : "") + ">Digitar outro IP...</option></select>";
  }
  if (c.outro || !ips.length) {
    h +=
      '<input id="campoCelularIp" class="ch-cel-campo" type="text" inputmode="decimal" autocomplete="off"' +
      ' placeholder="192.168.0.10" aria-label="IP deste computador" value="' + esc(c.ip) + '">';
  }
  el.innerHTML = h + "</div>";
}

function htmlCelular() {
  return (
    '<div class="ch-celular">' +
    '<div class="segmentado ch-cel-abas" id="chCelAbas" role="tablist"><span class="indicador"></span>' +
    '<button data-acao="celular-aba" data-valor="apk" role="tab">1. Baixar o app</button>' +
    '<button data-acao="celular-aba" data-valor="config" role="tab">2. Configurar</button>' +
    '<button data-acao="celular-aba" data-valor="par" role="tab">3. Parear</button></div>' +
    '<div class="ch-cel-painel" id="chCelApk"><div id="chCelApkCorpo"></div></div>' +
    '<div class="ch-cel-painel" id="chCelCfg">' +
    '<div class="ch-linha ch-cel-estado" id="chCelEstado"></div>' +
    '<ol class="ch-cel-passos">' +
    "<li>Instale o app (aba 1) e abra-o.</li>" +
    "<li>No app, toque em <strong>Scan QR code</strong> (fica na caixa <strong>First setup</strong>, no topo; depois do pareamento a caixa some e o botão fica na seção <strong>Configuration file</strong>).</li>" +
    "<li>Aponte a câmera para o QR abaixo, confira as mudanças e toque em <strong>Import</strong>.</li>" +
    "<li>Na primeira vez, siga para a aba <strong>3. Parear</strong>. Depois, ligue <strong>Take over calls</strong> no app.</li>" +
    "</ol>" +
    '<div id="chCelQr"></div>' +
    '<p class="ch-dica">O QR contém a senha do celular: não mostre a ninguém nem tire foto. Ele se esconde sozinho em 2 minutos.</p>' +
    "</div>" +
    '<div class="ch-cel-painel" id="chCelPar">' +
    '<div class="ch-linha ch-cel-estado" id="chCelEstadoPar"></div>' +
    '<ol class="ch-cel-passos">' +
    "<li>Antes, na aba <strong>2. Configurar</strong>, escaneie o QR no app. É ali que o app recebe a senha deste pareamento.</li>" +
    "<li>No celular (no mesmo Wi-Fi do computador): Configurações, Opções do desenvolvedor, ligue a <strong>Depuração sem fio</strong> (Wireless debugging) e toque nela para entrar.</li>" +
    "<li>Toque em <strong>Parear dispositivo com código QR</strong> (Pair device with QR code). A câmera abre: aponte para o QR abaixo.</li>" +
    "<li>Pronto. O app pareia sozinho e avisa numa notificação. Não digite código nenhum. Acompanhe os passos ao vivo logo abaixo do QR.</li>" +
    "</ol>" +
    '<div id="chCelParQr"></div>' +
    '<p class="ch-dica">É uma vez só. O QR contém a senha do pareamento: não tire foto; ele se esconde sozinho em 2 minutos. Se fechar esta janela, os QRs mudam: escaneie a aba 2 de novo.</p>' +
    "</div>" +
    '<div id="chCelRelato"></div>' +
    '<div id="chCelIp"></div>' +
    "</div>"
  );
}

function agendarQr() {
  clearTimeout(TIMER_CEL_QR);
  TIMER_CEL_QR = setTimeout(function () {
    var c = S.celular;
    if (c && c.qrVisivel) {
      c.qrVisivel = false;
      renderCelQr();
      renderCelParQr();
    }
  }, QR_VISIVEL_MS);
}

/** O que o app do celular relatou nesta sessao do painel (ou null). Falha de rede nao atrapalha o resto. */
function lerRelatoCelular(meu) {
  if (!meu.par || meu.online) {
    return Promise.resolve();
  }
  return api("/api/celular/relato?sid=" + encodeURIComponent(meu.par.nome))
    .then(function (d) {
      meu.relato = d && d.relato ? d.relato : null;
    })
    .catch(function () {});
}

/** Pergunta o estado ao Asterisk enquanto o painel esta aberto, para avisar quando o celular registrar. */
function consultarCelular() {
  var meu = S.celular;
  if (!meu) {
    return;
  }
  if (!$("#chCelEstado")) {
    pararCelular();
    return;
  }
  if (document.hidden) {
    return;
  }
  Promise.all([carregarEstado(), lerRelatoCelular(meu)]).then(function () {
    if (S.celular !== meu) {
      return;
    }
    var e = S.estado;
    var on = celularConectado();
    if (!on && e && e.ari && e.ari.ok) {
      meu.viuOffline = true;
    }
    if (on && meu.viuOffline) {
      meu.viuOffline = false;
      meu.qrVisivel = false;
      clearTimeout(TIMER_CEL_QR);
      toast("Celular conectado");
      renderCelQr();
      renderCelParQr();
    }
    renderCelRelato();
    renderCelEstado();
    render();
  });
}

/** Le de novo a pasta do APK (depois de copiar um APK novo para la). */
function lerApkCelular(avisar) {
  var meu = S.celular;
  if (!meu) {
    return Promise.resolve();
  }
  return api("/api/apk")
    .then(function (d) {
      meu.apk = exigirOk(d);
      meu.apkErro = null;
      if (!meu.ips.length && d.ips && d.ips.length) {
        meu.ips = d.ips;
        meu.ip = d.ips[0].ip;
        meu.outro = false;
      }
    })
    .catch(function (e) {
      meu.apkErro = e;
    })
    .then(function () {
      if (S.celular !== meu) {
        return;
      }
      renderCelApk();
      renderCelIp();
      if (avisar) {
        toast(meu.apk && meu.apk.apk ? "APK encontrado" : "Ainda não achei o APK");
      }
    });
}

function abrirCelular() {
  if (S.config && S.config.online) {
    abrirCelularOnline();
    return;
  }
  pararCelular();
  var e0 = S.estado;
  var meu = {
    aba: celularConectado() ? "config" : "apk",
    carregando: true,
    erro: null,
    dados: null,
    apk: null,
    apkErro: null,
    ips: [],
    ip: "",
    outro: false,
    par: novoPareamento(),
    relato: null,
    qrVisivel: true,
    viuOffline: !!(e0 && e0.ari && e0.ari.ok && !celularConectado())
  };
  S.celular = meu;
  abrirSheet("Conectar celular", htmlCelular());
  renderCelAba();
  renderCelEstado();
  renderCelApk();
  renderCelIp();
  renderCelQr();
  renderCelParQr();
  renderCelRelato();
  var pCel = api("/api/celular")
    .then(function (d) {
      meu.dados = exigirOk(d);
    })
    .catch(function (e) {
      meu.erro = e;
    });
  var pApk = api("/api/apk")
    .then(function (d) {
      meu.apk = exigirOk(d);
    })
    .catch(function (e) {
      meu.apkErro = e;
    });
  Promise.all([pCel, pApk]).then(function () {
    if (S.celular !== meu) {
      return;
    }
    var ips = (meu.dados && meu.dados.ips) || (meu.apk && meu.apk.ips) || [];
    meu.ips = ips;
    meu.ip = ips.length ? ips[0].ip : "";
    meu.outro = !ips.length;
    meu.carregando = false;
    agendarQr();
    renderCelApk();
    renderCelIp();
    renderCelQr();
  });
  TIMER_CEL_CONSULTA = setInterval(consultarCelular, CEL_CONSULTA_MS);
  consultarCelular();
}

/** Chamado ao fechar o painel: para a consulta e tira a senha da tela e da memoria. */
function pararCelular() {
  clearInterval(TIMER_CEL_CONSULTA);
  TIMER_CEL_CONSULTA = 0;
  clearTimeout(TIMER_CEL_QR);
  TIMER_CEL_QR = 0;
  if (!S.celular) {
    return;
  }
  S.celular = null;
  // Espera o painel terminar de descer para nao piscar; se outro conteudo abriu nesse meio tempo, nao mexe.
  clearTimeout(TIMER_CEL_LIMPAR);
  TIMER_CEL_LIMPAR = setTimeout(function () {
    if (!S.celular && !$("#sheet").classList.contains("aberto")) {
      $("#sheetCorpo").innerHTML = "";
    }
  }, 400);
}

function trocarAbaCelular(aba) {
  var c = S.celular;
  if (!c || (aba !== "apk" && aba !== "config" && aba !== "par")) {
    return;
  }
  c.aba = aba;
  if (aba !== "apk" && c.qrVisivel) {
    agendarQr();
  }
  renderCelAba();
  if (aba === "apk" && !c.online && !c.carregando && !(c.apk && c.apk.apk)) {
    lerApkCelular(false);
  }
}

function alternarQrCelular() {
  var c = S.celular;
  if (!c) {
    return;
  }
  c.qrVisivel = !c.qrVisivel;
  if (c.qrVisivel) {
    agendarQr();
  } else {
    clearTimeout(TIMER_CEL_QR);
  }
  renderCelQr();
  renderCelParQr();
}

function escolherIpCelular(valor) {
  var c = S.celular;
  if (!c) {
    return;
  }
  c.outro = valor === "__outro";
  c.ip = c.outro ? "" : valor;
  renderCelIp();
  renderCelQr();
  renderCelApk();
}

/** So redesenha os QRs: o campo de texto continua o mesmo, entao o teclado nao fecha. */
function digitarIpCelular(valor) {
  var c = S.celular;
  if (!c) {
    return;
  }
  c.ip = valor;
  renderCelQr();
  renderCelApk();
}

/* ===== 9. Carregamento ===== */

function carregarEstado() {
  if (S.config && S.config.online) {
    onSincronizar();
    return Promise.resolve();
  }
  return api("/api/estado")
    .then(function (d) {
      S.estado = exigirOk(d);
      S.carregadoEm = d.carregadoEm;
      S.doCache = !!d.cache;
    })
    .catch(function (e) {
      S.estado = { ari: { ok: false, erro: e.message, dica: e.dica || "" }, gateway: null, ramal: null };
      S.carregadoEm = Date.now();
      S.doCache = false;
    });
}

function carregarChamadas() {
  if (S.config && S.config.online) {
    S.itens = historicoLocalLer();
    return Promise.resolve();
  }
  return api("/api/chamadas").then(function (d) {
    S.itens = exigirOk(d).itens || [];
  });
}

function agendarEstado() {
  if (TIMER_ESTADO) {
    return;
  }
  TIMER_ESTADO = setInterval(function () {
    if (document.hidden || S.erro) {
      return;
    }
    carregarEstado().then(render);
  }, 10000);
}

function carregar() {
  S.carregando = true;
  S.erro = null;
  render();
  return api("/api/config")
    .then(function (cfg) {
      S.config = exigirOk(cfg);
      iniciarRamal();
      return Promise.all([carregarEstado(), carregarChamadas()]);
    })
    .then(
      function () {
        S.carregando = false;
      },
      function (e) {
        S.carregando = false;
        S.erro = e;
      }
    )
    .then(function () {
      render();
      agendarEstado();
    });
}

/* ===== 10. Eventos ===== */

function tecla(t) {
  if (enviarDtmf(t)) {
    return;
  }
  S.numero += t;
  var campo = $("#campoNumero");
  if (campo) {
    campo.value = S.numero;
  }
  atualizarDiscador();
}

function acao(nome, alvo) {
  if (nome === "ligar") {
    ligar();
  } else if (nome === "desligar") {
    desligar();
  } else if (nome === "atender") {
    atender();
  } else if (nome === "recusar") {
    recusar();
  } else if (nome === "mudo") {
    alternarMudo();
  } else if (nome === "tema") {
    alternarTema();
  } else if (nome === "apagar") {
    S.numero = S.numero.slice(0, -1);
    var campo = $("#campoNumero");
    if (campo) {
      campo.value = S.numero;
    }
    atualizarDiscador();
  } else if (nome === "limpar-busca") {
    S.busca = "";
    $("#campoBusca").value = "";
    render();
  } else if (nome === "fechar-sheet") {
    fecharSheet();
  } else if (nome === "copiar") {
    copiar(alvo.getAttribute("data-numero"), "Número copiado");
  } else if (nome === "ligar-de-novo") {
    S.numero = alvo.getAttribute("data-numero") || "";
    fecharSheet();
    mudarAba("discar");
    toast("Número no discador");
  } else if (nome === "testar-mic") {
    alternarTesteMic();
  } else if (nome === "gravar-teste") {
    gravarEOuvir();
  } else if (nome === "conectar-celular") {
    abrirCelular();
  } else if (nome === "celular-qr") {
    alternarQrCelular();
  } else if (nome === "celular-aba") {
    trocarAbaCelular(alvo.getAttribute("data-valor"));
  } else if (nome === "celular-reler") {
    lerApkCelular(true);
  } else if (nome === "copiar-texto") {
    copiar(alvo.getAttribute("data-texto") || "", alvo.getAttribute("data-aviso") || "Copiado");
  } else if (nome === "simular") {
    mockChegou();
  } else if (nome === "recarregar") {
    carregar();
  } else if (typeof acaoOnline === "function") {
    acaoOnline(nome, alvo);
  }
}

// Um unico tratador de clique para a tela toda: o innerHTML troca os botoes, os handlers nao precisam ser refeitos.
document.addEventListener("click", function (ev) {
  var alvo = ev.target.closest("[data-aba],[data-filtro],[data-tecla],[data-id],[data-acao]");
  if (!alvo) {
    return;
  }
  if (alvo.hasAttribute("data-aba")) {
    mudarAba(alvo.getAttribute("data-aba"));
  } else if (alvo.hasAttribute("data-filtro")) {
    S.filtro = alvo.getAttribute("data-filtro");
    render();
  } else if (alvo.hasAttribute("data-tecla")) {
    tecla(alvo.getAttribute("data-tecla"));
  } else if (alvo.hasAttribute("data-id")) {
    abrirItem(alvo.getAttribute("data-id"));
  } else {
    acao(alvo.getAttribute("data-acao"), alvo);
  }
});

document.addEventListener("input", function (ev) {
  var t = ev.target;
  if (t && t.id === "campoNumero") {
    S.numero = t.value;
    atualizarDiscador();
  } else if (t && t.id === "campoBusca") {
    S.busca = t.value;
    render();
  } else if (t && t.id === "campoCelularIp") {
    digitarIpCelular(t.value);
  }
});

document.addEventListener("change", function (ev) {
  var t = ev.target;
  if (t && t.id === "selMic") {
    escolherMic(t.value);
  } else if (t && t.id === "selSaida") {
    escolherSaida(t.value);
  } else if (t && t.id === "selCelularIp") {
    escolherIpCelular(t.value);
  }
});

document.addEventListener("keydown", function (ev) {
  if (ev.key === "Enter" && ev.target && ev.target.id === "campoNumero") {
    ligar();
  } else if (ev.key === "Escape") {
    fecharSheet();
  }
});

document.addEventListener("visibilitychange", function () {
  if (!document.hidden && !S.carregando && !S.erro) {
    carregarEstado().then(render);
  }
});

// Ao fechar a aba, desregistra o ramal: o Asterisk para de achar que o atendente ainda esta la.
window.addEventListener("pagehide", function () {
  try {
    if (UA) {
      UA.stop();
    }
  } catch (e) {}
});

AUDIO = $("#audioRemoto");
iniciarDispositivos();
carregar();
