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
  "User Denied Media Access": "Microfone negado no navegador",
  "RTP Timeout": "O áudio caiu",
  "WebRTC Error": "Erro de áudio no navegador",
  "Authentication Error": "Ramal sem permissão (senha recusada)",
  "SIP Failure Code": "Falha do Asterisk",
  "Address Incomplete": "Número incompleto",
  "Incompatible SDP": "Áudio incompatível",
  "Bad Media Description": "Áudio incompatível",
  "Internal Error": "Erro interno do navegador"
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
  chamada: null, // { direcao, numero, estado, inicio, criadaEm, mudo }
  numero: ""
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
      texto: "Offline. No celular: abra o Voice SIP Agent, confira a aba Health e ligue Take over calls. Se o celular reiniciou, inicie o Shizuku de novo."
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
      '<div class="ch-linha-txt"><strong>' + esc(l.titulo) + "</strong><span>" + esc(l.texto) + "</span></div></div>";
  }
  el.innerHTML = h + "</section>";
}

/* --- discador --- */

function htmlDiscador() {
  var h = '<div id="blocoSaude"></div><section class="ch-discador">';
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
    "<span>" + esc(c.direcao === "entrada" ? "Chamada recebida" : "Chamada feita") + ' · <span id="chTempo">' + esc(rotuloEstadoChamada(c)) + "</span></span></div>" +
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
    }
    renderSaude();
    atualizarDiscador();
    renderRecentes();
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
  S.chamada = { direcao: "saida", numero: r.numero, estado: "discando", inicio: 0, criadaEm: Date.now(), mudo: false };
  render();
  if (S.config.mock) {
    mockLigar();
    return;
  }
  try {
    SESSAO = UA.call("sip:" + r.numero + "@" + S.config.sip.dominio, {
      mediaConstraints: { audio: true, video: false },
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
    mediaConstraints: { audio: true, video: false },
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

/* ===== 9. Carregamento ===== */

function carregarEstado() {
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
  } else if (nome === "simular") {
    mockChegou();
  } else if (nome === "recarregar") {
    carregar();
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
carregar();
