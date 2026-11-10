/**
 * online-ui.js - tela do modo online (entrar, guia passo a passo, verificacoes, aba Registro, celular).
 * Papel: desenhar o que o modo online precisa e ligar o ramal online (online.js) ao estado do central.js.
 * Roda no mesmo escopo global do central.js (S, esc, toast, copiar, render...). Cada funcao daqui so e chamada
 * quando S.config.online esta ligado; no modo Asterisk local este arquivo fica parado.
 * NAO faz: falar com o relay (online.js) nem guardar o codigo de acesso fora do navegador.
 */

var ON_LS_CODIGO = "central-online-codigo";
var ON_LS_RELAY = "central-online-relay";
var ON_LS_HIST = "central-online-historico";

var ON = {
  codigo: "",
  relay: "",
  lembrar: true,
  assinaturaGuia: "",
  agendado: 0,
  iniciado: false
};

/* ===== Utilitarios ===== */

function onLer(chave) {
  try {
    return localStorage.getItem(chave) || "";
  } catch (e) {
    return "";
  }
}

function onGravar(chave, valor) {
  try {
    if (valor) {
      localStorage.setItem(chave, valor);
    } else {
      localStorage.removeItem(chave);
    }
  } catch (e) {}
}

function emOnline() {
  return !!(S.config && S.config.online);
}

function relayConfigurado() {
  return (S.config && S.config.online && S.config.online.relay) || "";
}

/* ===== Ramal online (a cara do iniciarRamal do JsSIP) ===== */

function iniciarOnline() {
  var c = S.config;
  S.usuario = { ramal: "online", nome: c.sip ? c.sip.nomeExibicao : "" };
  if (UA) {
    return;
  }
  ON.relay = onLer(ON_LS_RELAY) || relayConfigurado();
  ON.codigo = onLer(ON_LS_CODIGO);
  ON.lembrar = true;
  if (!ON.iniciado) {
    ON.iniciado = true;
    var abas = $("#abasGrupo");
    if (abas && !abas.querySelector('[data-aba="registro"]')) {
      var b = document.createElement("button");
      b.setAttribute("data-aba", "registro");
      b.setAttribute("role", "tab");
      b.textContent = "Registro";
      abas.appendChild(b);
    }
    Online.aoMudar(onAoMudar);
    Online.aoLog(onAoLog);
    Online.log("Central online aberta em " + location.origin + " (navegador: " + navigator.userAgent.split(") ").pop() + ")");
  }
  UA = Online.criarUA();
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
  S.ramal = "desconectado";
  S.ramalDica = "Digite o código de acesso para entrar.";
  onSincronizar();
  if (ON.relay && ON.codigo) {
    Online.conectar({ http: ON.relay, codigo: ON.codigo, sala: "principal", nome: "navegador" });
  }
}

/** Traduz o estado do relay para o que o central.js ja sabe desenhar (S.ramal e S.estado). */
function onSincronizar() {
  var e = Online.estado();
  var mapa = { parado: "desconectado", acordando: "conectando", conectando: "conectando", reconectando: "conectando", online: "registrado", erro: "falhou" };
  S.ramal = mapa[e.fase] || "desconectado";
  S.ramalDica = e.erro ? e.erro.msg : "";
  var noar = e.fase === "online";
  S.estado = {
    ok: true,
    ari: { ok: true, erro: "", dica: "" },
    gateway: { nome: "celular", estado: noar ? (e.telefone ? "online" : "offline") : "desconhecido", emChamada: !!e.chamada },
    ramal: { nome: "online", estado: noar ? "online" : "offline", emChamada: !!e.chamada },
    carregadoEm: Date.now(),
    online: true
  };
  S.carregadoEm = Date.now();
  S.doCache = false;
}

function onAoMudar() {
  onSincronizar();
  var cel = S.celular;
  if (cel && cel.online) {
    var e = Online.estado();
    cel.relato = e.relato ? onRelatoComIdade(e) : null;
    if (e.telefone && cel.viuOffline) {
      cel.viuOffline = false;
      cel.qrVisivel = false;
      clearTimeout(TIMER_CEL_QR);
      toast("Celular conectado");
      renderCelQr();
      renderCelParQr();
    }
    if (!e.telefone) {
      cel.viuOffline = true;
    }
    renderCelRelato();
    renderCelEstado();
    renderCelQr();
  }
  if (!ON.agendado) {
    ON.agendado = requestAnimationFrame(function () {
      ON.agendado = 0;
      if (!S.carregando) {
        render();
      }
    });
  }
}

function onRelatoComIdade(e) {
  var r = {};
  for (var k in e.relato) {
    if (Object.prototype.hasOwnProperty.call(e.relato, k)) {
      r[k] = e.relato[k];
    }
  }
  r.idadeMs = Date.now() - (e.relatoEm || Date.now());
  return r;
}

/* ===== Historico (so neste navegador) ===== */

function historicoLocalLer() {
  try {
    var itens = JSON.parse(onLer(ON_LS_HIST) || "[]");
    return Array.isArray(itens) ? itens : [];
  } catch (e) {
    return [];
  }
}

function historicoLocalGravar(itens) {
  onGravar(ON_LS_HIST, JSON.stringify(itens.slice(0, 200)));
}

/* ===== Verificacoes (o cartao "antes de ligar") ===== */

function onNavegadorLinha() {
  if (!window.isSecureContext) {
    return { nivel: "erro", titulo: "Navegador", texto: "O microfone fica bloqueado neste endereço. Abra a Central por HTTPS (o endereço do Render) ou por http://localhost." };
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return { nivel: "erro", titulo: "Navegador", texto: "Este navegador não libera o microfone. Use Chrome, Edge, Firefox ou Safari atuais." };
  }
  var Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || typeof AudioWorkletNode === "undefined") {
    return { nivel: "erro", titulo: "Navegador", texto: "Este navegador não tem AudioWorklet. Atualize o navegador." };
  }
  return { nivel: "ok", titulo: "Navegador", texto: "Pronto. O microfone é pedido na primeira chamada." };
}

function passoCelularFalta(r) {
  if (!r) {
    return "";
  }
  if (!r.configurado) {
    return "O app ainda não recebeu a configuração: no app, toque em Scan QR code, escaneie o QR da aba 2 e toque em Import.";
  }
  if (!r.pareado) {
    return r.helper === "PAIRING_FAILED" && r.helperDetalhe ? "O pareamento falhou: " + r.helperDetalhe : "Falta parear com a Depuração sem fio (aba 3 do Conectar celular).";
  }
  if (r.helper !== "CONNECTED") {
    return "Acesso privilegiado (helper) ainda não conectou: " + (r.helperDetalhe || r.helper || "aguardando");
  }
  if (!r.acesso || !r.audio) {
    return r.detalhe || "O app ainda não tem acesso às chamadas ou ao áudio. No app, ligue Take over calls.";
  }
  return r.detalhe || "";
}

function saudeLinhasOnline() {
  var e = Online.estado();
  var linhas = [];
  linhas.push(onNavegadorLinha());

  // Relay
  if (e.fase === "online") {
    linhas.push({ nivel: "ok", titulo: "Relay (servidor online)", texto: "Conectado" + (e.versao ? " (versão " + e.versao + ")" : "") + (e.rtt >= 0 ? ", latência " + e.rtt + " ms" : "") + ".", acao: "sair-online", acaoRotulo: "Sair" });
  } else if (e.fase === "acordando") {
    linhas.push({
      nivel: "espera",
      titulo: "Relay (servidor online)",
      texto: "Acordando o servidor, tentativa " + e.tentativa + ". O Render grátis dorme depois de 15 minutos parado e leva até 1 minuto para voltar." + (e.tentativa > 12 ? " Está demorando: confira se o serviço está Live no painel do Render e se a URL está certa." : "")
    });
  } else if (e.fase === "conectando" || e.fase === "reconectando") {
    linhas.push({ nivel: "espera", titulo: "Relay (servidor online)", texto: e.fase === "reconectando" ? "Conexão perdida. Tentando de novo sozinho..." : "Entrando com o código de acesso..." });
  } else if (e.fase === "erro" && e.erro) {
    var dicas = {
      auth: "Confira o código: ele é o valor de ACCESS_CODE no Render (Environment). Maiúsculas e minúsculas importam.",
      sem_codigo: "No Render, abra o serviço, Environment, crie ACCESS_CODE e salve. Espere o deploy terminar.",
      endereco: "A URL deve ser a do serviço no Render, por exemplo https://central-relay.onrender.com",
      substituido: "Você abriu a Central em outra aba ou aparelho. Só uma aba por vez fica com a linha. Toque em Entrar para voltar para esta.",
      bloqueado: "Muitos erros seguidos de código. Espere 10 minutos."
    };
    linhas.push({ nivel: "erro", titulo: "Relay (servidor online)", texto: e.erro.msg + (dicas[e.erro.codigo] ? " " + dicas[e.erro.codigo] : "") });
  } else {
    linhas.push({ nivel: "aviso", titulo: "Relay (servidor online)", texto: "Ainda não entrou. Digite o código de acesso no passo 1 acima." });
  }

  // Celular
  if (e.fase !== "online") {
    linhas.push({ nivel: "espera", titulo: "Celular gateway", texto: "Só dá para saber depois de entrar no relay." });
  } else if (e.telefone) {
    linhas.push({ nivel: "ok", titulo: "Celular gateway", texto: "Conectado ao relay" + (e.app ? " (app " + e.app + ")" : "") + " e pronto para chamadas (uma por vez)." + (e.chamada ? " Em chamada agora." : "") });
  } else {
    var falta = passoCelularFalta(e.relato);
    linhas.push({
      nivel: "erro",
      titulo: "Celular gateway",
      texto: "O celular não está conectado ao relay. " + (falta ? falta : "Abra o app Voice SIP Agent, confira que ele tem internet e que Take over calls está ligado. Primeira vez? Toque em Conectar celular."),
      acao: "conectar-celular",
      acaoRotulo: "Conectar celular"
    });
  }
  return linhas;
}

function motivoBloqueioOnline() {
  var e = Online.estado();
  var nav = onNavegadorLinha();
  if (nav.nivel === "erro") {
    return nav.texto;
  }
  if (e.fase !== "online") {
    return "Entre na Central primeiro (passo 1 acima).";
  }
  if (!e.telefone) {
    return "O celular não está conectado ao relay (veja as verificações acima).";
  }
  return "";
}

function resumoOnline() {
  var e = Online.estado();
  var nomes = { parado: "fora", acordando: "acordando o servidor", conectando: "conectando", reconectando: "reconectando", online: "online", erro: "com erro" };
  var cel = e.fase === "online" ? (e.telefone ? "online" : "offline") : "?";
  return "Linha: " + (nomes[e.fase] || e.fase) + " · Celular: " + cel + (e.rtt >= 0 && e.fase === "online" ? " · " + e.rtt + " ms" : "");
}

/* ===== Cartao "proximo passo" (entrar / conectar celular) ===== */

function onLimitesLista() {
  return (
    "<ul>" +
    "<li>O servidor grátis do Render dorme após 15 min sem uso. A primeira conexão do dia leva até 1 minuto.</li>" +
    "<li>O áudio vai pela internet em WebSocket: pode haver meio segundo de atraso e picotes em rede ruim. Use fone de ouvido para não dar eco.</li>" +
    "<li>Uma linha, um atendente por vez. Abrir a Central em outra aba tira a linha da primeira.</li>" +
    "<li>O histórico fica só neste navegador.</li></ul>"
  );
}

function onTextoLimites() {
  return '<details class="ch-guia-lim"><summary>O que esperar do modo grátis</summary>' + onLimitesLista() + "</details>";
}

function onAssinaturaGuia() {
  var e = Online.estado();
  return [e.fase, e.erro ? e.erro.codigo : "", e.fase === "online" ? (e.telefone ? "tel" : "semtel") : "", e.fase === "acordando" ? (e.tentativa > 12 ? "demora" : "") : ""].join("|");
}

function htmlGate(e) {
  var erro = e.fase === "erro" && e.erro ? '<p class="ch-cel-aviso"><strong>' + esc(e.erro.msg) + "</strong></p>" : "";
  var precisaRelay = !relayConfigurado();
  return (
    '<section class="ch-guia" aria-label="Passo 1">' +
    '<p class="ch-guia-passo">Passo 1 de 3</p><h2 class="ch-guia-titulo">Entrar na Central</h2>' +
    '<p class="ch-dica">Digite o código de acesso que você definiu no Render (variável <strong>ACCESS_CODE</strong>). ' +
    "Se o servidor estiver dormindo, ele acorda sozinho em até 1 minuto.</p>" + erro +
    (precisaRelay
      ? '<label class="ch-audio-rot" for="campoRelay">Endereço do relay (Render)</label>' +
        '<input id="campoRelay" class="ch-cel-campo" type="url" inputmode="url" autocomplete="off" placeholder="https://central-relay.onrender.com" value="' + esc(ON.relay) + '">' +
        '<p class="ch-dica">Dica: se a Central estiver na Vercel, coloque esse endereço na variável RELAY_URL e este campo some. No Render isso já é automático.</p>'
      : "") +
    '<label class="ch-audio-rot" for="campoCodigo">Código de acesso</label>' +
    '<input id="campoCodigo" class="ch-cel-campo" type="password" autocomplete="current-password" placeholder="seu código" value="' + esc(ON.codigo) + '">' +
    '<label class="ch-guia-lembrar"><input id="campoLembrar" type="checkbox"' + (ON.lembrar ? " checked" : "") + "> Lembrar neste navegador</label>" +
    '<div class="ch-cel-botoes"><button class="btn btn-largo" data-acao="entrar-online">Entrar</button>' +
    '<button class="btn btn-suave" data-acao="guia">Guia completo</button></div>' +
    onTextoLimites() +
    "</section>"
  );
}

function htmlAcordando(e) {
  return (
    '<section class="ch-guia" aria-label="Passo 1">' +
    '<p class="ch-guia-passo">Passo 1 de 3</p><h2 class="ch-guia-titulo">' + esc(e.fase === "acordando" ? "Acordando o servidor..." : e.fase === "reconectando" ? "Reconectando..." : "Entrando...") + "</h2>" +
    '<p class="ch-dica">' +
    esc(
      e.fase === "acordando"
        ? "O servidor grátis do Render estava dormindo. Isso leva até 1 minuto e só acontece depois de um tempo sem uso. Pode deixar esta tela aberta."
        : "Só um instante."
    ) +
    "</p>" +
    '<div class="ch-cel-botoes"><button class="btn btn-suave" data-acao="sair-online">Cancelar</button></div>' +
    "</section>"
  );
}

function htmlSemCelular() {
  return (
    '<section class="ch-guia" aria-label="Passo 2">' +
    '<p class="ch-guia-passo">Passo 2 de 3</p><h2 class="ch-guia-titulo">Conectar o celular</h2>' +
    '<p class="ch-dica">Você já está na Central. Falta o celular (a chipeira) aparecer aqui. O celular só precisa de internet, não precisa estar na mesma rede.</p>' +
    '<ol class="ch-cel-passos">' +
    "<li>Toque em <strong>Conectar celular</strong> e instale o app no celular (aba 1).</li>" +
    "<li>No app: <strong>Scan QR code</strong>, aponte para o QR da aba 2 e toque em <strong>Import</strong>.</li>" +
    "<li>Na primeira vez, faça o pareamento da Depuração sem fio com o QR da aba 3.</li>" +
    "<li>No app, ligue <strong>Take over calls</strong>. Esta tela avisa quando o celular entrar.</li></ol>" +
    '<div class="ch-cel-botoes"><button class="btn btn-largo" data-acao="conectar-celular">Conectar celular</button>' +
    '<button class="btn btn-suave" data-acao="guia">Guia completo</button></div>' +
    onTextoLimites() +
    "</section>"
  );
}

function renderGuia() {
  var el = $("#blocoGuia");
  if (!el) {
    return;
  }
  if (!emOnline()) {
    el.innerHTML = "";
    return;
  }
  var e = Online.estado();
  var sig = onAssinaturaGuia();
  if (sig === ON.assinaturaGuia && el.innerHTML) {
    return;
  }
  ON.assinaturaGuia = sig;
  var h = "";
  if (e.fase === "parado" || e.fase === "erro") {
    h = htmlGate(e);
  } else if (e.fase !== "online") {
    h = htmlAcordando(e);
  } else if (!e.telefone) {
    h = htmlSemCelular();
  }
  el.innerHTML = h;
}

/* ===== Aba Registro ===== */

function htmlRegistro() {
  return (
    '<section class="ch-reg">' +
    '<p class="ch-dica">Aqui aparece tudo o que o site, o relay e o app contam, em ordem de horário. Toque em <strong>Copiar tudo</strong> e cole na conversa para eu ver o que aconteceu.</p>' +
    '<div class="ch-cel-botoes"><button class="btn" data-acao="copiar-log">Copiar tudo</button>' +
    '<button class="btn btn-suave" data-acao="baixar-log">Baixar .txt</button>' +
    '<button class="btn btn-suave" data-acao="limpar-log">Limpar</button></div>' +
    '<div class="ch-reg-estado" id="chRegEstado"></div>' +
    '<pre class="ch-log" id="chRegistro" tabindex="0"></pre>' +
    "</section>"
  );
}

function registroTexto() {
  var l = Online.linhas();
  var s = [];
  for (var i = 0; i < l.length; i++) {
    s.push(Online.formatarLinha(l[i]));
  }
  return s.join("\n");
}

function renderRegistroConteudo() {
  var pre = $("#chRegistro");
  if (!pre) {
    return;
  }
  // Se a pessoa esta selecionando texto, nao atualiza: trocar o texto derrubaria a selecao.
  var sel = window.getSelection ? window.getSelection() : null;
  if (sel && sel.toString() && pre.contains(sel.anchorNode)) {
    return;
  }
  var perto = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.textContent = registroTexto() || "(vazio)";
  if (perto) {
    pre.scrollTop = pre.scrollHeight;
  }
  var est = $("#chRegEstado");
  if (est) {
    est.textContent = resumoOnline();
  }
}

function renderRegistroAba() {
  var corpo = $("#blocoCorpo");
  if (CORPO_MODO !== "registro") {
    corpo.innerHTML = htmlRegistro();
    CORPO_MODO = "registro";
    renderRegistroConteudo();
    var pre = $("#chRegistro");
    if (pre) {
      pre.scrollTop = pre.scrollHeight;
    }
    return;
  }
  renderRegistroConteudo();
}

function onAoLog() {
  if (S.aba === "registro" && !ON.logAgendado) {
    ON.logAgendado = setTimeout(function () {
      ON.logAgendado = 0;
      if (S.aba === "registro") {
        renderRegistroConteudo();
      }
    }, 250);
  }
}

function baixarRegistro() {
  var txt = Online.relatorioTexto();
  var blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "central-registro-" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () {
    URL.revokeObjectURL(a.href);
  }, 2000);
}

/* ===== Guia completo (sheet) ===== */

function onSecao(titulo, html, aberto) {
  return '<details class="ch-guia-sec"' + (aberto ? " open" : "") + "><summary>" + esc(titulo) + "</summary>" + html + "</details>";
}

function htmlGuia() {
  var h = "";
  h += onSecao(
    "Como funciona",
    "<p>O navegador (esta página) fala com um servidor chamado <strong>relay</strong> (no Render, grátis, no mesmo serviço desta página). O app no celular (a chipeira) também fala com o relay. " +
      "O relay só passa as mensagens e o áudio de um lado para o outro. Por isso o celular e o computador <strong>não precisam estar na mesma rede</strong>: cada um só precisa de internet.</p>" +
      "<p>Quando você liga, o app no celular disca pelo chip e liga o áudio da chamada ao seu navegador.</p>",
    true
  );
  h += onSecao(
    "1. Entrar na Central",
    '<ol class="ch-cel-passos"><li>Digite o código de acesso (o valor de <strong>ACCESS_CODE</strong> no Render) e toque em <strong>Entrar</strong>.</li>' +
      "<li>Se aparecer \"Acordando o servidor\", espere até 1 minuto. É o Render grátis saindo do sono.</li>" +
      "<li>A linha <strong>Relay</strong> nas verificações fica verde quando você entra.</li></ol>",
    true
  );
  h += onSecao(
    "2. Preparar o celular (uma vez só)",
    '<ol class="ch-cel-passos"><li>Toque no ícone do celular no topo desta tela (<strong>Conectar celular</strong>).</li>' +
      "<li><strong>Aba 1:</strong> instale o app. Ele é o APK que o GitHub compila para você (Actions, Gerar APK, Artifacts). Passe o arquivo para o celular (cabo, Drive, WhatsApp para você mesmo) e abra para instalar. O Android pede para permitir apps de fontes desconhecidas.</li>" +
      "<li><strong>Aba 2:</strong> abra o app, toque em <strong>Scan QR code</strong>, aponte para o QR e toque em <strong>Import</strong>. O QR leva o endereço do relay e a senha do celular. Não mostre a ninguém.</li>" +
      "<li><strong>Aba 3 (primeira vez):</strong> no celular, Configurações, Opções do desenvolvedor, <strong>Depuração sem fio</strong>, toque nela, <strong>Parear dispositivo com código QR</strong> e aponte para o QR da aba 3. O celular precisa estar no Wi-Fi só nesse momento. O app pareia sozinho.</li>" +
      "<li>No app, ligue <strong>Take over calls</strong>. Pronto: a linha <strong>Celular gateway</strong> aqui fica verde.</li></ol>" +
      "<p>Enquanto você faz isso, o painel <strong>Conectar celular</strong> mostra ao vivo em qual passo o app está.</p>",
    false
  );
  h += onSecao(
    "3. Ligar e atender",
    '<ol class="ch-cel-passos"><li>Para ligar: digite DDD + número e toque em <strong>Ligar</strong>. O navegador pede o microfone na primeira vez.</li>' +
      "<li>Para atender: quando alguém ligar no chip, esta tela toca e mostra <strong>Atender</strong>. A aba precisa estar aberta.</li>" +
      "<li>Use fone de ouvido. Com alto-falante o microfone capta o som e dá eco.</li>" +
      "<li>Durante a chamada, as teclas do discador enviam tons (DTMF).</li></ol>",
    false
  );
  h += onSecao(
    "4. Se algo não funcionar",
    '<p>Abra a aba <strong>Registro</strong>, toque em <strong>Copiar tudo</strong> e cole na conversa. O registro junta o que o site, o relay e o app contam.</p>' +
      '<ul class="ch-guia-lista">' +
      "<li><strong>Relay nunca acorda:</strong> confira a URL (termina em onrender.com) e se o serviço está Live no Render.</li>" +
      "<li><strong>Código recusado:</strong> é o valor de ACCESS_CODE no Render. Se você trocou lá, espere o redeploy.</li>" +
      "<li><strong>Celular fica offline:</strong> veja as verificações: elas dizem o passo em que o app parou (config, pareamento, helper, acesso às chamadas, áudio).</li>" +
      "<li><strong>Liga mas sem som:</strong> veja a linha Áudio durante a chamada e o registro (quadros enviados e recebidos).</li>" +
      "<li><strong>Caiu depois de um tempo:</strong> o Render pode reiniciar o servidor. A tela reconecta sozinha em segundos.</li></ul>",
    false
  );
  h += onSecao("5. Limites do modo grátis", onLimitesLista(), false);
  return h;
}

function abrirGuia() {
  pararCelular();
  abrirSheet("Guia: como conectar", '<div class="ch-guia-corpo">' + htmlGuia() + "</div>");
}

/* ===== Conectar celular (QR) no modo online ===== */

function jsonCelularOnline() {
  var e = Online.estado();
  var c = S.celular;
  if (!c || !e.tokenCelular || !e.http) {
    return "";
  }
  var m = /^(https?):\/\/([^/:]+)(?::(\d+))?/i.exec(e.http);
  if (!m) {
    return "";
  }
  var seguro = m[1].toLowerCase() === "https";
  var cfg = {
    format: "voice-sip-agent-config",
    version: 1,
    sip: {
      stack: "online",
      server: m[2],
      port: m[3] ? Number(m[3]) : seguro ? 443 : 80,
      transport: seguro ? "tls" : "tcp",
      srtp: "off",
      domain: "",
      user: e.sala,
      password: e.tokenCelular
    },
    routing: { target: e.sala }
  };
  if (c.par) {
    cfg.adbPairing = { name: c.par.nome, password: c.par.senha };
    cfg.central = { url: e.http };
  }
  return JSON.stringify(cfg);
}

function abrirCelularOnline() {
  pararCelular();
  var e = Online.estado();
  var meu = {
    aba: e.telefone ? "config" : "apk",
    carregando: false,
    erro: null,
    dados: {},
    apk: null,
    apkErro: null,
    ips: [],
    ip: "online",
    outro: false,
    par: novoPareamento(),
    relato: e.relato ? onRelatoComIdade(e) : null,
    qrVisivel: true,
    viuOffline: !e.telefone,
    online: true
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
  agendarQr();
  // O link do APK pode ter aparecido depois que a pagina carregou (o workflow acabou de terminar): pergunta de novo.
  if (!(S.config && S.config.online && S.config.online.apk)) {
    api("/api/config").then(
      function (c) {
        if (c && c.online && c.online.apk && S.config && S.config.online) {
          S.config.online.apk = c.online.apk;
          renderCelApk();
        }
      },
      function () {}
    );
  }
}

function htmlApkOnline() {
  var url = (S.config && S.config.online && S.config.online.apk) || "";
  var passos = '<ol class="ch-cel-passos">';
  passos += "<li>No GitHub do projeto: aba <strong>Actions</strong>, <strong>Gerar APK do celular gateway</strong>, <strong>Run workflow</strong>. Leva de 15 a 40 minutos na primeira vez.</li>";
  passos += "<li>Quando terminar, o APK fica na release <strong>apk-latest</strong> (aba <strong>Releases</strong>, arquivo <strong>central-gateway.apk</strong>) e também no artefato <strong>voice-sip-agent-apk</strong> da execução (um .zip: extraia o .apk).</li>";
  passos += "<li>Passe o .apk para o celular (cabo, Google Drive, e-mail para você mesmo) e abra para instalar. O Android pede para permitir apps de fontes desconhecidas.</li>";
  passos += "<li>Depois volte aqui e abra a aba <strong>2. Configurar</strong>.</li></ol>";
  var h = "";
  if (url) {
    h += "<p><strong>O APK mais novo está sempre neste link.</strong> Aponte a câmera do celular para o QR, baixe e instale. Quando você gerar um APK novo no GitHub, o link continua o mesmo e já entrega o novo.</p>";
    h +=
      '<div class="ch-qr-caixa">' + htmlQr(url) + '<p class="ch-cel-url">' + esc(url) + "</p>" +
      '<div class="ch-cel-botoes"><button class="btn btn-suave" data-acao="copiar-texto" data-texto="' + esc(url) + '" data-aviso="Link copiado">Copiar link</button></div></div>';
    h += '<p class="ch-dica"><strong>Sem câmera ou sem o link?</strong> Faça pelos passos abaixo.</p>' + passos;
  } else {
    h += passos;
    h += '<p class="ch-dica">Quando o workflow terminar, o QR para baixar o APK aparece aqui sozinho (feche e abra esta janela). Isso só funciona com repositório <strong>público</strong>. Se o seu for privado, o link da release pede login no GitHub: passe o .apk por cabo ou Drive, ou coloque um link direto na variável APK_URL (no Render, em Environment).</p>';
  }
  h += '<p class="ch-dica"><strong>Atualizando o app?</strong> Se o Android recusar instalar por cima do app antigo ("conflito de assinatura"), desinstale o antigo, instale o novo e escaneie o QR da aba 2 de novo. Para as próximas atualizações entrarem por cima, veja "Chave de assinatura fixa" no MANUAL.md.</p>';
  return h;
}

/* ===== Acoes ===== */

function entrarOnline() {
  var campoRelay = $("#campoRelay");
  var campoCodigo = $("#campoCodigo");
  var lembrar = $("#campoLembrar");
  var relay = campoRelay ? campoRelay.value : ON.relay || relayConfigurado();
  var codigo = campoCodigo ? campoCodigo.value : ON.codigo;
  if (!String(relay).trim()) {
    toast("Digite o endereço do relay");
    return;
  }
  if (!codigo) {
    toast("Digite o código de acesso");
    return;
  }
  ON.relay = Online.normalizarUrl(relay);
  ON.codigo = codigo;
  ON.lembrar = lembrar ? lembrar.checked : true;
  if (ON.lembrar) {
    onGravar(ON_LS_CODIGO, codigo);
    onGravar(ON_LS_RELAY, relayConfigurado() ? "" : ON.relay);
  } else {
    onGravar(ON_LS_CODIGO, "");
    onGravar(ON_LS_RELAY, "");
  }
  ON.assinaturaGuia = "";
  Online.conectar({ http: ON.relay, codigo: codigo, sala: "principal", nome: "navegador" });
}

function sairOnline() {
  onGravar(ON_LS_CODIGO, "");
  ON.codigo = "";
  ON.assinaturaGuia = "";
  Online.parar();
  Online.log("saiu da Central (código esquecido neste navegador)");
}

/** Devolve true se a acao era do modo online. */
function acaoOnline(nome, alvo) {
  if (nome === "guia") {
    if (emOnline()) {
      abrirGuia();
    } else {
      toast("O guia completo está no MANUAL.md do projeto");
    }
    return true;
  }
  if (nome === "entrar-online") {
    entrarOnline();
    return true;
  }
  if (nome === "sair-online") {
    sairOnline();
    return true;
  }
  if (nome === "copiar-log") {
    copiar(Online.relatorioTexto(), "Registro copiado");
    return true;
  }
  if (nome === "baixar-log") {
    baixarRegistro();
    return true;
  }
  if (nome === "limpar-log") {
    Online.limparLog();
    renderRegistroConteudo();
    return true;
  }
  return false;
}

document.addEventListener("input", function (ev) {
  var t = ev.target;
  if (t && t.id === "campoCodigo") {
    ON.codigo = t.value;
  } else if (t && t.id === "campoRelay") {
    ON.relay = t.value;
  } else if (t && t.id === "campoLembrar") {
    ON.lembrar = t.checked;
  }
});

document.addEventListener("keydown", function (ev) {
  if (ev.key === "Enter" && ev.target && (ev.target.id === "campoCodigo" || ev.target.id === "campoRelay")) {
    entrarOnline();
  }
});
