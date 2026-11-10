/**
 * online.js - modo online da Central (navegador <-> relay <-> celular), sem Asterisk e sem WebRTC.
 * Papel: abrir o WebSocket do relay, acordar o servidor gratis (Render dorme), manter o registro (log)
 * da tela, e entregar ao central.js um "ramal" com a mesma cara do JsSIP (UA e sessao), para a tela
 * de discar, atender e desligar nao precisar saber de onde vem o audio.
 * Audio: microfone -> PCM 16 bits mono (8 kHz) em quadros de 20 ms -> WebSocket. Volta pelo mesmo caminho,
 * passa por um buffer de jitter e toca num AudioWorklet.
 * NAO faz: desenhar a tela (online-ui.js) nem saber de historico, abas ou QR.
 */
var Online = (function () {
  "use strict";

  var QUADRO_MS = 20;
  var ESPERA_PING_MS = 20000;
  var LIMITE_SEM_PONG_MS = 50000;
  var ATRASOS = [1000, 2000, 4000, 8000, 15000];
  var MAX_LOG = 600;

  /* ===== Registro (log da tela) ===== */

  var LINHAS = [];
  var OUVINTES_LOG = [];
  var OUVINTES = [];
  var SKEW = 0; // relogio do relay menos o relogio deste navegador

  function adicionarLinha(fonte, t, msg) {
    var l = { t: t, f: fonte, m: String(msg) };
    LINHAS.push(l);
    if (LINHAS.length > MAX_LOG) {
      LINHAS.splice(0, LINHAS.length - MAX_LOG);
    }
    for (var i = 0; i < OUVINTES_LOG.length; i++) {
      try {
        OUVINTES_LOG[i](l);
      } catch (e) {}
    }
    return l;
  }

  function log(msg) {
    return adicionarLinha("site", Date.now(), msg);
  }

  function pad(n, w) {
    var s = String(n);
    while (s.length < (w || 2)) {
      s = "0" + s;
    }
    return s;
  }

  function formatarLinha(l) {
    var d = new Date(l.t);
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + "." + pad(d.getMilliseconds(), 3) + " [" + l.f + "] " + l.m;
  }

  function ordenadas() {
    return LINHAS.slice().sort(function (a, b) {
      return a.t - b.t;
    });
  }

  // Erros do proprio navegador tambem entram no registro: ajudam a achar o que deu errado sem abrir o console.
  window.addEventListener("error", function (ev) {
    log("erro no navegador: " + (ev.message || "desconhecido") + (ev.filename ? " (" + String(ev.filename).split("/").pop() + ":" + ev.lineno + ")" : ""));
  });
  window.addEventListener("unhandledrejection", function (ev) {
    var r = ev.reason;
    log("promessa recusada: " + (r && r.message ? r.message : String(r)));
  });

  /* ===== Estado da conexao ===== */

  var E = {
    fase: "parado", // parado | acordando | conectando | online | reconectando | erro
    erro: null, // { codigo, msg, definitivo }
    http: "",
    codigo: "",
    sala: "principal",
    nome: "",
    telefone: false,
    operador: true,
    rate: 8000,
    app: "",
    chamada: null,
    tokenCelular: "",
    relato: null,
    relatoEm: 0,
    rtt: -1,
    versao: "",
    tentativa: 0,
    desde: 0
  };

  var WS = null;
  var GER = 0; // muda a cada conectar()/parar(): descarta respostas de tentativas antigas
  var TIMER_PING = 0;
  var TIMER_RETRY = 0;
  var ULTIMO_PONG = 0;
  var N_PING = 0;
  var SESSAO = null;
  var UA_ATUAL = null;
  var CHAVES_VISTAS = {};

  function notificar() {
    for (var i = 0; i < OUVINTES.length; i++) {
      try {
        OUVINTES[i](E);
      } catch (e) {}
    }
  }

  function normalizarUrl(txt) {
    var u = String(txt || "").trim().replace(/\/+$/, "");
    if (!u) {
      return "";
    }
    if (/^wss:\/\//i.test(u)) {
      u = "https://" + u.slice(6);
    } else if (/^ws:\/\//i.test(u)) {
      u = "http://" + u.slice(5);
    } else if (!/^https?:\/\//i.test(u)) {
      u = "https://" + u;
    }
    return u.replace(/\/ws$/i, "");
  }

  function urlWs() {
    return E.http.replace(/^http/i, "ws") + "/ws";
  }

  function definirErro(codigo, msg, definitivo) {
    E.erro = { codigo: codigo, msg: msg, definitivo: !!definitivo };
    E.fase = definitivo ? "erro" : E.fase;
  }

  /* ===== Conexao com o relay ===== */

  function conectar(op) {
    parar(true);
    E.http = normalizarUrl(op.http);
    E.codigo = String(op.codigo || "");
    E.sala = op.sala || "principal";
    E.nome = op.nome || "";
    E.tentativa = 0;
    E.erro = null;
    E.fase = "acordando";
    E.telefone = false;
    E.tokenCelular = "";
    E.relato = null;
    GER++;
    log("conectando ao relay " + E.http + " (sala " + E.sala + ")");
    notificar();
    acordar(GER);
  }

  function parar(silencioso) {
    GER++;
    clearTimeout(TIMER_RETRY);
    clearInterval(TIMER_PING);
    TIMER_RETRY = 0;
    TIMER_PING = 0;
    if (WS) {
      var w = WS;
      WS = null;
      w.onclose = null;
      w.onmessage = null;
      w.onerror = null;
      try {
        w.close(1000, "fim");
      } catch (e) {}
    }
    if (SESSAO) {
      SESSAO._cair("relay_caiu", "system");
    }
    if (!silencioso) {
      E.fase = "parado";
      E.telefone = false;
      notificar();
    }
  }

  /** Pergunta /health ate o servidor responder (o Render gratis demora cerca de 1 minuto para acordar). */
  function acordar(ger) {
    if (ger !== GER) {
      return;
    }
    E.tentativa++;
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var corte = setTimeout(function () {
      if (ctl) {
        ctl.abort();
      }
    }, 9000);
    fetch(E.http + "/health", { cache: "no-store", signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        return r.json().then(function (d) {
          return { status: r.status, d: d };
        });
      })
      .then(
        function (res) {
          clearTimeout(corte);
          if (ger !== GER) {
            return;
          }
          var d = res.d;
          if (!d || d.servico !== "central-relay") {
            log("o endereço respondeu, mas não é o relay da Central (HTTP " + res.status + ")");
            definirErro("endereco", "Esse endereço respondeu, mas não é o relay da Central. Confira a URL do serviço no Render (termina em onrender.com).", true);
            notificar();
            return;
          }
          E.versao = d.versao || "";
          if (!d.configurado) {
            log("relay no ar, mas sem ACCESS_CODE");
            definirErro("sem_codigo", "O relay está no ar, mas falta a variável ACCESS_CODE no Render (Environment). Defina e aguarde o redeploy.", true);
            notificar();
            return;
          }
          log("relay respondeu (versão " + E.versao + ", " + (d.salas || 0) + " sala(s) ativa(s))");
          abrirWs(ger);
        },
        function (err) {
          clearTimeout(corte);
          if (ger !== GER) {
            return;
          }
          var motivo = err && err.name === "AbortError" ? "sem resposta em 9 s" : err && err.message ? err.message : "falhou";
          if (E.tentativa <= 3 || E.tentativa % 5 === 0) {
            log("relay ainda não respondeu (tentativa " + E.tentativa + ": " + motivo + "). O Render grátis leva até 1 minuto para acordar.");
          }
          E.fase = E.fase === "online" || E.fase === "reconectando" ? "reconectando" : "acordando";
          notificar();
          TIMER_RETRY = setTimeout(function () {
            acordar(ger);
          }, 3000);
        }
      );
  }

  function abrirWs(ger) {
    if (ger !== GER) {
      return;
    }
    E.fase = E.fase === "reconectando" ? "reconectando" : "conectando";
    notificar();
    var ws;
    try {
      ws = new WebSocket(urlWs());
    } catch (e) {
      definirErro("ws", "O navegador recusou abrir o WebSocket: " + e.message, true);
      notificar();
      return;
    }
    ws.binaryType = "arraybuffer";
    WS = ws;
    var recebeuWelcome = false;
    ws.onopen = function () {
      if (ger !== GER) {
        return;
      }
      log("WebSocket aberto, entrando com o código");
      ws.send(JSON.stringify({ t: "hello", papel: "operador", sala: E.sala, codigo: E.codigo, nome: E.nome }));
    };
    ws.onmessage = function (ev) {
      if (ger !== GER) {
        return;
      }
      if (typeof ev.data !== "string") {
        if (SESSAO) {
          SESSAO._audioChegou(ev.data);
        }
        return;
      }
      var m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (m.t === "welcome") {
        recebeuWelcome = true;
      }
      tratar(m, ger);
    };
    ws.onerror = function () {
      // O detalhe vem no onclose; aqui so registramos que algo falhou.
      if (ger === GER && !recebeuWelcome) {
        log("erro no WebSocket (veja a próxima linha)");
      }
    };
    ws.onclose = function (ev) {
      if (ger !== GER) {
        return;
      }
      WS = null;
      clearInterval(TIMER_PING);
      TIMER_PING = 0;
      E.telefone = false;
      var cod = ev.code;
      log("WebSocket fechado (código " + cod + (ev.reason ? ", " + ev.reason : "") + ")");
      if (SESSAO) {
        SESSAO._cair("relay_caiu", "system");
      }
      if (cod === 4001 || cod === 4002 || cod === 4003 || cod === 4004 || cod === 4005) {
        if (!E.erro) {
          definirErro("ws_" + cod, "Conexão recusada pelo relay (código " + cod + ").", true);
        } else {
          E.erro.definitivo = true;
          E.fase = "erro";
        }
        notificar();
        return;
      }
      E.fase = "reconectando";
      var atraso = ATRASOS[Math.min(E.tentativa, ATRASOS.length - 1)];
      E.tentativa++;
      log("reconectando em " + Math.round(atraso / 1000) + " s");
      notificar();
      TIMER_RETRY = setTimeout(function () {
        acordar(ger);
      }, atraso);
    };
  }

  function enviar(obj) {
    if (WS && WS.readyState === 1) {
      WS.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  function batimento(ger) {
    clearInterval(TIMER_PING);
    ULTIMO_PONG = Date.now();
    TIMER_PING = setInterval(function () {
      if (ger !== GER || !WS) {
        return;
      }
      if (Date.now() - ULTIMO_PONG > LIMITE_SEM_PONG_MS) {
        log("o relay parou de responder há " + Math.round((Date.now() - ULTIMO_PONG) / 1000) + " s: reabrindo a conexão");
        try {
          WS.close(4000, "sem pong");
        } catch (e) {}
        return;
      }
      N_PING++;
      enviar({ t: "ping", n: N_PING, em: Date.now() });
    }, ESPERA_PING_MS);
  }

  function juntarLogsDoRelay(lista) {
    for (var i = 0; i < (lista || []).length; i++) {
      var l = lista[i];
      var chave = l.t + "|" + l.f + "|" + l.m;
      if (CHAVES_VISTAS[chave]) {
        continue;
      }
      CHAVES_VISTAS[chave] = true;
      adicionarLinha(l.f, l.t - SKEW, l.m);
    }
  }

  function tratar(m, ger) {
    switch (m.t) {
      case "welcome":
        SKEW = (m.agora || Date.now()) - Date.now();
        E.fase = "online";
        E.erro = null;
        E.tentativa = 0;
        E.desde = Date.now();
        E.versao = m.versao || E.versao;
        E.tokenCelular = m.tokenCelular || "";
        E.telefone = !!m.telefone;
        E.rate = m.rate || 8000;
        E.app = m.app || "";
        E.chamada = m.chamada || null;
        if (m.relato) {
          E.relato = m.relato;
          E.relatoEm = Date.now();
        }
        juntarLogsDoRelay(m.logs);
        log("conectado ao relay " + E.versao + ", sala " + m.sala + "; celular " + (E.telefone ? "ONLINE" : "offline"));
        batimento(ger);
        break;
      case "presenca": {
        var antes = E.telefone;
        E.telefone = !!m.telefone;
        E.rate = m.rate || 8000;
        E.app = m.app || "";
        E.chamada = m.chamada || null;
        if (antes !== E.telefone) {
          log("celular " + (E.telefone ? "entrou no relay" : "saiu do relay") + (E.app ? " (app " + E.app + ")" : ""));
        }
        break;
      }
      case "relato":
        E.relato = m.dados;
        E.relatoEm = Date.now();
        break;
      case "log":
        if (m.linha) {
          var chave = m.linha.t + "|" + m.linha.f + "|" + m.linha.m;
          if (!CHAVES_VISTAS[chave]) {
            CHAVES_VISTAS[chave] = true;
            adicionarLinha(m.linha.f, m.linha.t - SKEW, m.linha.m);
          }
        }
        return;
      case "pong":
        ULTIMO_PONG = Date.now();
        if (m.em) {
          E.rtt = Date.now() - m.em;
        }
        break;
      case "erro":
        log("o relay recusou: " + m.msg);
        definirErro(m.codigo, m.msg, true);
        break;
      case "incoming":
        chegou(m.numero);
        break;
      case "ringing":
        if (SESSAO) {
          SESSAO._tocando();
        }
        break;
      case "connected":
        if (SESSAO) {
          SESSAO._atendida();
        }
        break;
      case "ended":
        if (SESSAO) {
          SESSAO._fim(m.causa, m.por);
        }
        break;
      default:
        break;
    }
    notificar();
  }

  function chegou(numero) {
    if (!UA_ATUAL) {
      return;
    }
    var s = new Sessao("entrada", String(numero || "0"));
    SESSAO = s;
    log("chamada recebida de " + mascara(s.numero));
    UA_ATUAL._emitir("newRTCSession", { originator: "remote", session: s });
  }

  function mascara(n) {
    n = String(n || "");
    return n.length > 4 ? "***" + n.slice(-4) : n;
  }

  /* ===== Audio (microfone -> PCM -> relay, relay -> jitter -> alto-falante) ===== */

  var CODIGO_WORKLET =
    "class Ponte extends AudioWorkletProcessor {\n" +
    "  constructor() {\n" +
    "    super();\n" +
    "    this.fila = []; this.pos = 0; this.cheio = 0; this.tocando = false;\n" +
    "    this.alvo = Math.round(sampleRate * 0.06); this.maximo = Math.round(sampleRate * 0.25);\n" +
    "    this.sub = 0; this.descartes = 0; this.acum = new Float32Array(Math.round(sampleRate * 0.02)); this.n = 0; this.rel = 0;\n" +
    "    this.port.onmessage = (e) => {\n" +
    "      const pcm = e.data;\n" +
    "      if (pcm === 'limpar') { this.fila = []; this.pos = 0; this.cheio = 0; this.tocando = false; return; }\n" +
    "      this.fila.push(pcm); this.cheio += pcm.length;\n" +
    "      while (this.cheio - this.pos > this.maximo && this.fila.length > 1) { const d = this.fila.shift(); this.cheio -= d.length; this.descartes++; this.pos = 0; }\n" +
    "    };\n" +
    "  }\n" +
    "  process(entradas, saidas) {\n" +
    "    const ent = entradas[0] && entradas[0][0];\n" +
    "    if (ent) {\n" +
    "      for (let i = 0; i < ent.length; i++) {\n" +
    "        this.acum[this.n++] = ent[i];\n" +
    "        if (this.n === this.acum.length) { const c = this.acum; const tam = c.length; this.port.postMessage(c, [c.buffer]); this.acum = new Float32Array(tam); this.n = 0; }\n" +
    "      }\n" +
    "    }\n" +
    "    const saida = saidas[0] && saidas[0][0];\n" +
    "    if (saida) {\n" +
    "      if (!this.tocando && this.cheio - this.pos >= this.alvo) this.tocando = true;\n" +
    "      for (let i = 0; i < saida.length; i++) {\n" +
    "        if (!this.tocando) { saida[i] = 0; continue; }\n" +
    "        if (!this.fila.length) { saida[i] = 0; this.tocando = false; this.sub++; continue; }\n" +
    "        const b = this.fila[0];\n" +
    "        saida[i] = b[this.pos++];\n" +
    "        if (this.pos >= b.length) { this.cheio -= b.length; this.fila.shift(); this.pos = 0; }\n" +
    "      }\n" +
    "    }\n" +
    "    this.rel += 128;\n" +
    "    if (this.rel >= sampleRate / 2) { this.rel = 0; this.port.postMessage({ est: { buf: Math.round((this.cheio - this.pos) * 1000 / sampleRate), sub: this.sub, descartes: this.descartes } }); }\n" +
    "    return true;\n" +
    "  }\n" +
    "}\n" +
    "registerProcessor('central-ponte', Ponte);\n";

  /**
   * Motor de audio de UMA chamada. enviar(ArrayBuffer) manda um quadro de PCM ao relay.
   * pedirMic() devolve a promessa do getUserMedia (o central.js escolhe o microfone).
   */
  function MotorAudio(rate, enviarQuadro, pedirMic) {
    this.rate = rate;
    this.enviarQuadro = enviarQuadro;
    this.pedirMic = pedirMic;
    this.ctx = null;
    this.mic = null;
    this.fonte = null;
    this.no = null;
    this.destino = null;
    this.mudo = false;
    this.enviando = false;
    this.parado = false;
    this.estat = { tx: 0, rx: 0, pico: 0, buf: 0, sub: 0, descartes: 0, semEnvio: 0 };
    // reamostragem do microfone (taxa do contexto -> taxa da chamada)
    this.acumSoma = 0;
    this.acumN = 0; // peso acumulado (em amostras do microfone) da janela atual
    this.saidaAtual = [];
    // reamostragem do que chega (taxa da chamada -> taxa do contexto)
    this.ultimoRx = 0;
    this.fase = 0;
  }

  /** Cria o contexto (precisa ser chamado dentro do clique) e abre o microfone. */
  MotorAudio.prototype.preparar = function () {
    var self = this;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      return Promise.reject(Object.assign(new Error("Este navegador não tem Web Audio."), { causa: "WebRTC Error" }));
    }
    this.ctx = new Ctx({ latencyHint: "interactive" });
    if (this.ctx.resume) {
      this.ctx.resume();
    }
    if (!this.ctx.audioWorklet) {
      return Promise.reject(Object.assign(new Error("Este navegador não tem AudioWorklet (use Chrome, Edge, Firefox ou Safari atuais, em HTTPS)."), { causa: "WebRTC Error" }));
    }
    var url = URL.createObjectURL(new Blob([CODIGO_WORKLET], { type: "text/javascript" }));
    return this.pedirMic()
      .then(function (fluxo) {
        if (self.parado) {
          fecharTrilhas(fluxo);
          throw new Error("chamada encerrada antes de abrir o microfone");
        }
        self.mic = fluxo;
        return self.ctx.audioWorklet.addModule(url);
      })
      .then(function () {
        URL.revokeObjectURL(url);
        if (self.parado) {
          throw new Error("chamada encerrada");
        }
        var c = self.ctx;
        self.no = new AudioWorkletNode(c, "central-ponte", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        self.fonte = c.createMediaStreamSource(self.mic);
        self.fonte.connect(self.no);
        self.destino = c.createMediaStreamDestination();
        self.no.connect(self.destino);
        self.no.port.onmessage = function (e) {
          var d = e.data;
          if (d && d.est) {
            self.estat.buf = d.est.buf;
            self.estat.sub = d.est.sub;
            self.estat.descartes = d.est.descartes;
            return;
          }
          self._doMic(d);
        };
        log("áudio pronto: contexto " + c.sampleRate + " Hz, chamada " + self.rate + " Hz");
        return self.destino.stream;
      });
  };

  function fecharTrilhas(fluxo) {
    var t = fluxo && fluxo.getTracks ? fluxo.getTracks() : [];
    for (var i = 0; i < t.length; i++) {
      t[i].stop();
    }
  }

  /** Recebe ~20 ms do microfone na taxa do contexto e devolve quadros de 20 ms na taxa da chamada. */
  MotorAudio.prototype._doMic = function (f32) {
    if (!this.enviando || this.parado) {
      return;
    }
    var razao = this.ctx.sampleRate / this.rate; // amostras do microfone por amostra da chamada (pode ser fracionario)
    var porQuadro = (this.rate * QUADRO_MS) / 1000;
    var pico = 0;
    for (var i = 0; i < f32.length; i++) {
      var v = f32[i];
      var a = v < 0 ? -v : v;
      if (a > pico) {
        pico = a;
      }
      // Media ponderada por janela: tambem funciona quando a razao nao e inteira (44,1 kHz -> 8 kHz) e
      // serve de filtro simples contra serrilhado ao diminuir a taxa.
      var resta = 1;
      while (resta > 1e-9) {
        var falta = razao - this.acumN;
        if (resta >= falta) {
          this.acumSoma += v * falta;
          this.saidaAtual.push(this.acumSoma / razao);
          this.acumSoma = 0;
          this.acumN = 0;
          resta -= falta;
          if (this.saidaAtual.length === porQuadro) {
            this._mandar(this.saidaAtual);
            this.saidaAtual = [];
          }
        } else {
          this.acumSoma += v * resta;
          this.acumN += resta;
          resta = 0;
        }
      }
    }
    if (pico > this.estat.pico) {
      this.estat.pico = pico;
    }
  };

  MotorAudio.prototype._mandar = function (amostras) {
    var buf = new ArrayBuffer(amostras.length * 2);
    var dv = new DataView(buf);
    for (var i = 0; i < amostras.length; i++) {
      var x = this.mudo ? 0 : amostras[i];
      x = x > 1 ? 1 : x < -1 ? -1 : x;
      dv.setInt16(i * 2, x < 0 ? x * 32768 : x * 32767, true);
    }
    if (this.enviarQuadro(buf)) {
      this.estat.tx++;
    }
  };

  /** Liga o envio do microfone (quando a chamada e atendida). */
  MotorAudio.prototype.comecarEnvio = function () {
    this.enviando = true;
    this.acumSoma = 0;
    this.acumN = 0;
    this.saidaAtual = [];
  };

  /** Quadro de PCM 16 bits que chegou do celular: converte para a taxa do contexto e empurra no buffer. */
  MotorAudio.prototype.chegou = function (buf) {
    if (this.parado || !this.no) {
      return;
    }
    var n = buf.byteLength >> 1;
    if (!n) {
      return;
    }
    var dv = new DataView(buf);
    var razao = this.ctx.sampleRate / this.rate;
    var passo = 1 / razao;
    var saida = new Float32Array(Math.ceil(n * razao) + 2);
    var k = 0;
    // Interpolacao linear. Os pontos sao y[0] = ultima amostra do quadro anterior e y[1..n] = amostras deste
    // quadro; assim a emenda entre quadros nao estala. fase e a sobra de posicao que passa para o proximo.
    var pos = this.fase;
    while (pos < n && k < saida.length) {
      var i0 = Math.floor(pos);
      var a = i0 === 0 ? this.ultimoRx : dv.getInt16((i0 - 1) * 2, true) / 32768;
      var b = dv.getInt16(i0 * 2, true) / 32768;
      saida[k++] = a + (b - a) * (pos - i0);
      pos += passo;
    }
    this.fase = pos - n;
    this.ultimoRx = dv.getInt16((n - 1) * 2, true) / 32768;
    this.estat.rx++;
    var out = saida.slice(0, k);
    this.no.port.postMessage(out, [out.buffer]);
  };

  MotorAudio.prototype.parar = function () {
    this.parado = true;
    this.enviando = false;
    try {
      if (this.no) {
        this.no.port.postMessage("limpar");
        this.no.port.onmessage = null;
        this.no.disconnect();
      }
      if (this.fonte) {
        this.fonte.disconnect();
      }
    } catch (e) {}
    fecharTrilhas(this.mic);
    this.mic = null;
    if (this.ctx && this.ctx.state !== "closed") {
      this.ctx.close().catch(function () {});
    }
  };

  /* ===== Sessao (a cara do RTCSession do JsSIP) ===== */

  function Sessao(direcao, numero) {
    this.direcao = direcao;
    this.numero = numero;
    this.estado = direcao === "saida" ? "discando" : "tocando";
    this.connection = null;
    this.remote_identity = { uri: { user: numero } };
    this._h = {};
    this._motor = null;
    this._acabou = false;
    this._atendeu = false;
    this._pediuLocal = false;
    this._mudo = false;
    this._relogio = 0;
  }

  Sessao.prototype.on = function (evento, fn) {
    (this._h[evento] = this._h[evento] || []).push(fn);
    return this;
  };

  Sessao.prototype._emitir = function (evento, dados) {
    var l = this._h[evento] || [];
    for (var i = 0; i < l.length; i++) {
      try {
        l[i](dados || {});
      } catch (e) {
        log("erro na tela ao tratar " + evento + ": " + e.message);
      }
    }
  };

  var CAUSA_FALHA = {
    celular_offline: "celular_offline",
    celular_caiu: "celular_caiu",
    relay_caiu: "relay_caiu",
    ocupado: "Busy",
    recusada: "Rejected",
    indisponivel: "Unavailable",
    sem_resposta: "No Answer",
    cancelada: "Canceled",
    numero_invalido: "numero_invalido",
    sem_resposta_do_celular: "sem_resposta_do_celular",
    operador_saiu: "Terminated",
    erro_audio: "erro_audio"
  };

  function iniciarMotor(sessao) {
    var rate = E.rate === 16000 ? 16000 : 8000;
    sessao._motor = new MotorAudio(
      rate,
      function (buf) {
        if (!WS || WS.readyState !== 1 || WS.bufferedAmount > 65536) {
          sessao._motor.estat.semEnvio++;
          return false;
        }
        WS.send(buf);
        return true;
      },
      function () {
        var restr = typeof restricoesMic === "function" ? restricoesMic() : { audio: true, video: false };
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          return Promise.reject(Object.assign(new Error("Sem acesso ao microfone neste endereço (precisa de HTTPS)."), { name: "NotAllowedError" }));
        }
        return navigator.mediaDevices.getUserMedia(restr);
      }
    );
    return sessao._motor.preparar().then(function (stream) {
      var el = document.getElementById("audioRemoto");
      if (el) {
        el.srcObject = stream;
        var p = el.play();
        if (p && p.catch) {
          p.catch(function () {
            log("o navegador bloqueou tocar o áudio: clique na página");
          });
        }
        if (typeof aplicarSaida === "function") {
          aplicarSaida(el);
        }
      }
    });
  }

  Sessao.prototype._falhaMicrofone = function (e) {
    if (this._acabou) {
      return;
    }
    var negado = e && (e.name === "NotAllowedError" || e.name === "SecurityError" || e.name === "PermissionDeniedError" || e.name === "NotFoundError" || e.name === "NotReadableError");
    log("não abri o microfone/áudio: " + (e && e.message ? e.message : e));
    this._encerrarLocal(negado ? "User Denied Media Access" : (e && e.causa) || "WebRTC Error");
  };

  Sessao.prototype._encerrarLocal = function (causa) {
    if (this._acabou) {
      return;
    }
    this._acabou = true;
    this._pararMotor();
    if (this._relogio) {
      clearInterval(this._relogio);
    }
    if (SESSAO === this) {
      SESSAO = null;
    }
    if (this.direcao === "entrada" || this._atendeu) {
      enviar({ t: "hangup" });
    }
    this._emitir("failed", { originator: "local", cause: causa });
  };

  Sessao.prototype._pararMotor = function () {
    if (this._motor) {
      this._motor.parar();
      this._motor = null;
    }
    var el = document.getElementById("audioRemoto");
    if (el) {
      el.srcObject = null;
    }
  };

  Sessao.prototype._tocando = function () {
    if (!this._acabou && !this._atendeu) {
      this._emitir("progress", { originator: "remote" });
    }
  };

  Sessao.prototype._atendida = function () {
    if (this._acabou || this._atendeu) {
      return;
    }
    this._atendeu = true;
    if (this._motor) {
      this._motor.comecarEnvio();
    }
    var self = this;
    this._relogio = setInterval(function () {
      if (self._motor && !self._acabou) {
        var e = self._motor.estat;
        log("áudio: enviados " + e.tx + " quadros, recebidos " + e.rx + ", buffer " + e.buf + " ms, faltas " + e.sub + ", descartes " + e.descartes + ", pico do mic " + e.pico.toFixed(3));
      }
    }, 5000);
    log("chamada atendida: áudio liberado nos dois sentidos");
    this._emitir("accepted", { originator: "remote" });
    this._emitir("confirmed", { originator: "remote" });
  };

  Sessao.prototype._fim = function (causa, por) {
    if (this._acabou) {
      return;
    }
    this._acabou = true;
    clearInterval(this._relogio);
    if (this._motor) {
      var s = this._motor.estat;
      log("áudio final: enviados " + s.tx + " quadros, recebidos " + s.rx + ", faltas " + s.sub + ", descartes " + s.descartes + ", pico do mic " + s.pico.toFixed(3));
    }
    this._pararMotor();
    if (SESSAO === this) {
      SESSAO = null;
    }
    var quem = this._pediuLocal ? "local" : por === "relay" ? "system" : "remote";
    var cause = CAUSA_FALHA[causa] || causa || "Terminated";
    if (this._pediuLocal && !this._atendeu) {
      // Mesmos nomes do JsSIP: quem desiste de uma chamada feita cancela; quem recusa uma recebida rejeita.
      cause = this.direcao === "entrada" ? "Rejected" : "Canceled";
    }
    log("chamada encerrada: " + causa + " (por " + por + ")");
    this._emitir(this._atendeu ? "ended" : "failed", { originator: quem, cause: cause });
  };

  /** A conexao com o relay caiu no meio: encerra do jeito que a tela entende. */
  Sessao.prototype._cair = function (causa, por) {
    this._fim(causa, por);
  };

  Sessao.prototype._audioChegou = function (buf) {
    if (this._motor) {
      this._motor.chegou(buf);
    }
  };

  Sessao.prototype.answer = function () {
    var self = this;
    if (this._acabou) {
      return;
    }
    var motor = iniciarMotor(this);
    motor.then(
      function () {
        if (!self._acabou) {
          log("atendendo");
          enviar({ t: "answer" });
        }
      },
      function (e) {
        self._falhaMicrofone(e);
      }
    );
  };

  Sessao.prototype.terminate = function () {
    if (this._acabou) {
      return;
    }
    this._pediuLocal = true;
    if (!enviar({ t: this.direcao === "entrada" && !this._atendeu ? "reject" : "hangup" })) {
      this._fim("relay_caiu", "system");
      return;
    }
    // O relay tem um prazo proprio de 4 s; o navegador espera um pouco mais antes de desistir.
    var self = this;
    setTimeout(function () {
      if (!self._acabou) {
        self._fim("sem_resposta_do_celular", "relay");
      }
    }, 6000);
  };

  Sessao.prototype.mute = function () {
    this._mudo = true;
    if (this._motor) {
      this._motor.mudo = true;
    }
  };

  Sessao.prototype.unmute = function () {
    this._mudo = false;
    if (this._motor) {
      this._motor.mudo = false;
    }
  };

  Sessao.prototype.sendDTMF = function (tecla) {
    enviar({ t: "dtmf", tecla: String(tecla) });
  };

  /** Contadores para o diagnostico da tela (a mesma ideia do getStats do WebRTC). */
  Sessao.prototype.estatisticas = function () {
    var e = this._motor ? this._motor.estat : { tx: 0, rx: 0, pico: 0, buf: 0, sub: 0, descartes: 0 };
    return { env: e.tx, rec: e.rx, nivel: e.pico, buffer: e.buf, faltas: e.sub, descartes: e.descartes };
  };

  /* ===== UA (a cara do JsSIP.UA) ===== */

  function criarUA() {
    var ua = {
      _h: {},
      on: function (ev, fn) {
        (this._h[ev] = this._h[ev] || []).push(fn);
        return this;
      },
      _emitir: function (ev, dados) {
        var l = this._h[ev] || [];
        for (var i = 0; i < l.length; i++) {
          try {
            l[i](dados || {});
          } catch (e) {
            log("erro na tela ao tratar " + ev + ": " + e.message);
          }
        }
      },
      start: function () {},
      stop: function () {
        parar(false);
      },
      call: function (uri) {
        var m = /^sip:([^@]+)@/.exec(String(uri));
        var numero = m ? m[1] : String(uri);
        var s = new Sessao("saida", numero);
        SESSAO = s;
        log("discando " + mascara(numero));
        // newRTCSession sai ANTES de qualquer rede: o central.js liga os ouvintes nesse momento.
        ua._emitir("newRTCSession", { originator: "local", session: s });
        iniciarMotor(s).then(
          function () {
            if (s._acabou) {
              return;
            }
            if (!enviar({ t: "dial", numero: numero })) {
              s._fim("relay_caiu", "system");
            }
          },
          function (e) {
            s._falhaMicrofone(e);
          }
        );
        return s;
      }
    };
    UA_ATUAL = ua;
    return ua;
  }

  /* ===== Texto de suporte ===== */

  function relatorioTexto(extra) {
    var cab = [
      "Central de chamadas - registro copiado em " + new Date().toISOString(),
      "Navegador: " + navigator.userAgent,
      "Relay: " + (E.http || "(nenhum)") + " | sala " + E.sala + " | versão " + (E.versao || "?") + " | fase " + E.fase + (E.erro ? " | erro " + E.erro.codigo : ""),
      "Celular no relay: " + (E.telefone ? "sim" + (E.app ? " (app " + E.app + ")" : "") : "não") + " | latência do relay: " + (E.rtt >= 0 ? E.rtt + " ms" : "?")
    ];
    if (E.relato) {
      var r = E.relato;
      cab.push(
        "Relato do app: configurado=" + !!r.configurado + " pareado=" + !!r.pareado + " helper=" + (r.helper || "?") +
          " acesso=" + !!r.acesso + " audio=" + !!r.audio + " sip=" + !!r.sip + " pronto=" + !!r.pronto +
          (r.android ? " | Android " + r.android : "") + (r.detalhe ? " | " + r.detalhe : "")
      );
      if (r.log && r.log.length) {
        cab.push("Últimas linhas do app (relato):");
        for (var i = 0; i < r.log.length; i++) {
          cab.push("  " + r.log[i]);
        }
      }
    }
    if (extra) {
      cab.push(extra);
    }
    cab.push("---");
    var l = ordenadas();
    for (var j = 0; j < l.length; j++) {
      cab.push(formatarLinha(l[j]));
    }
    return cab.join("\n");
  }

  return {
    estado: function () {
      return E;
    },
    conectar: conectar,
    parar: function () {
      parar(false);
    },
    criarUA: criarUA,
    normalizarUrl: normalizarUrl,
    aoMudar: function (fn) {
      OUVINTES.push(fn);
    },
    aoLog: function (fn) {
      OUVINTES_LOG.push(fn);
    },
    log: log,
    linhas: ordenadas,
    formatarLinha: formatarLinha,
    limparLog: function () {
      LINHAS.length = 0;
      CHAVES_VISTAS = {};
      log("registro limpo");
    },
    relatorioTexto: relatorioTexto,
    enviar: enviar
  };
})();
