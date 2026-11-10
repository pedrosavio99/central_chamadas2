/**
 * servidor.js - relay WebSocket da Central de chamadas.
 * Papel: aceitar o celular gateway e o navegador (operador) por WebSocket seguro e passar entre os dois
 * os comandos (JSON) e o audio (PCM 16 bits, mono, quadros de 20 ms em mensagens binarias).
 * Roda em plataforma gratis (Render): so precisa de HTTP/WebSocket, nada de UDP.
 * NAO faz: SIP, codec ou mixagem. O audio passa como chegou (celular <-> relay <-> navegador).
 *
 * Variaveis: ACCESS_CODE (obrigatoria), PORT (o Render define), ORIGINS (opcional, lista separada por
 * virgula dos enderecos de site que podem abrir o WebSocket; vazio = qualquer um com o codigo), MAX_SALAS.
 */
import http from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Hub } from "./hub.js";
import { criarFreio, codigoCerto, salaValida, tokenCelular, tokenCerto } from "./auth.js";
import { criarRegistro, formatarLinha } from "./log.js";

const VERSAO = "1.0.0";
const SALA_PADRAO = "principal";
const MAX_QUADRO = 4096; // um quadro de 20 ms a 16 kHz tem 640 bytes; sobra folga
const MAX_BUFFER = 96 * 1024; // se o destino acumular isso, descarta quadros (melhor perder 20 ms que atrasar)
const NUMERO = /^[0-9+*#]{1,32}$/;

function mascara(n) {
  const s = String(n || "");
  return s.length > 4 ? "***" + s.slice(-4) : s;
}

export function criarServidor(opcoes = {}) {
  const codigo = opcoes.codigo !== undefined ? opcoes.codigo : process.env.ACCESS_CODE || "";
  const origens = (opcoes.origens !== undefined ? opcoes.origens : process.env.ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const hub = new Hub(Number(opcoes.maxSalas || process.env.MAX_SALAS || 50));
  const global = criarRegistro(200); // eventos fora de qualquer sala (arranque, tentativas recusadas)
  const freio = criarFreio();
  const inicio = Date.now();
  const conexoes = new Set();

  function logGlobal(m) {
    global.add("relay", m);
    if (!opcoes.silencioso) console.log(formatarLinha({ t: Date.now(), f: "relay", m }));
  }

  /* ===== HTTP ===== */

  function cors(req, res) {
    const o = req.headers.origin;
    if (o) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-sala, x-codigo");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
    }
  }

  function json(res, status, corpo) {
    const txt = JSON.stringify(corpo);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(txt);
  }

  function ip(req) {
    const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    return xf || (req.socket && req.socket.remoteAddress) || "?";
  }

  function lerCorpo(req, limite = 65536) {
    return new Promise((resolve, reject) => {
      const partes = [];
      let total = 0;
      req.on("data", (p) => {
        total += p.length;
        if (total > limite) {
          reject(new Error("corpo grande demais"));
          req.destroy();
          return;
        }
        partes.push(p);
      });
      req.on("end", () => {
        try {
          resolve(partes.length ? JSON.parse(Buffer.concat(partes).toString("utf8")) : {});
        } catch {
          reject(new Error("JSON invalido"));
        }
      });
      req.on("error", reject);
    });
  }

  function bearer(req) {
    const m = /^Bearer (.+)$/i.exec(String(req.headers.authorization || ""));
    return m ? m[1].trim() : "";
  }

  async function http_(req, res) {
    cors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url, "http://x");
    const rota = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && (rota === "/" || rota === "/health")) {
      json(res, 200, {
        ok: true,
        servico: "central-relay",
        versao: VERSAO,
        configurado: !!codigo,
        dica: codigo ? "" : "Falta a variável ACCESS_CODE neste serviço (Render > Environment).",
        ...hub.resumo(),
        ligadoHa: Math.round((Date.now() - inicio) / 1000)
      });
      return;
    }

    if (req.method === "POST" && rota === "/relato") {
      const sala = String(req.headers["x-sala"] || SALA_PADRAO);
      if (!codigo || !salaValida(sala) || !tokenCerto(codigo, sala, bearer(req))) {
        freio.erro(ip(req));
        json(res, 401, { ok: false, erro: "Token do celular inválido para a sala " + sala });
        return;
      }
      if (freio.bloqueado(ip(req))) {
        json(res, 429, { ok: false, erro: "Muitas tentativas" });
        return;
      }
      let corpo;
      try {
        corpo = await lerCorpo(req, 16384);
      } catch (e) {
        json(res, 400, { ok: false, erro: e.message });
        return;
      }
      const s = hub.obter(sala);
      if (!s) {
        json(res, 503, { ok: false, erro: "Servidor cheio" });
        return;
      }
      const antes = s.relato ? chaveRelato(s.relato) : "";
      s.relato = { ...corpo, recebidoEm: Date.now() };
      s.ultimaAtividade = Date.now();
      const agora = chaveRelato(s.relato);
      if (agora !== antes) s.log("relato do app: " + agora);
      enviar(s.operador, { t: "relato", dados: s.relato });
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && (rota === "/relato" || rota === "/log")) {
      const sala = url.searchParams.get("sala") || SALA_PADRAO;
      if (!codigoCerto(codigo, String(req.headers["x-codigo"] || url.searchParams.get("codigo") || "")) || !salaValida(sala)) {
        freio.erro(ip(req));
        json(res, 401, { ok: false, erro: "Código de acesso inválido" });
        return;
      }
      const s = hub.obter(sala, false);
      if (rota === "/relato") {
        json(res, 200, { ok: true, relato: s ? s.relato : null });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(s ? s.registro.texto() : "(sala vazia)\n");
      return;
    }

    json(res, 404, { ok: false, erro: "Rota não encontrada", rotas: "GET /health, POST /relato, GET /relato, GET /log, WebSocket /ws" });
  }

  function chaveRelato(r) {
    return ["config:" + (r.configurado ? "s" : "n"), "pareado:" + (r.pareado ? "s" : "n"), "helper:" + (r.helper || "?"), "acesso:" + (r.acesso ? "s" : "n"), "audio:" + (r.audio ? "s" : "n"), "sip:" + (r.sip ? "s" : "n"), "pronto:" + (r.pronto ? "s" : "n")].join(" ");
  }

  /* ===== WebSocket ===== */

  function enviar(c, obj) {
    if (c && c.ws.readyState === 1) {
      try {
        c.ws.send(JSON.stringify(obj));
      } catch {
        /* socket fechando: o evento close limpa */
      }
    }
  }

  function difundir(s) {
    const p = s.presenca();
    enviar(s.celular, p);
    enviar(s.operador, p);
  }

  function fechar(c, codigoWs, erro, msg) {
    if (erro) enviar(c, { t: "erro", codigo: erro, msg });
    try {
      c.ws.close(codigoWs, erro || "fim");
    } catch {
      /* ja fechado */
    }
  }

  function encerrarChamada(s, causa, por) {
    const c = s.chamada;
    if (!c) return;
    s.chamada = null;
    const dur = c.inicio ? Math.round((Date.now() - c.inicio) / 1000) : 0;
    s.log("chamada encerrada: " + causa + " (por " + por + (dur ? ", " + dur + " s" : "") + "), audio operador->celular " + c.q.op + " quadros, celular->operador " + c.q.cel + ", descartados " + c.q.perdidos);
    const ev = { t: "ended", causa, por };
    enviar(s.operador, ev);
    enviar(s.celular, { t: "hangup" });
    difundir(s);
  }

  function aoEntrar(conn, m, ipCli) {
    if (!codigo) {
      logGlobal("conexao recusada: ACCESS_CODE nao esta definido no servico");
      fechar(conn, 4003, "sem_codigo", "O serviço não tem ACCESS_CODE. Defina em Render > Environment e reinicie.");
      return;
    }
    if (freio.bloqueado(ipCli)) {
      fechar(conn, 4004, "bloqueado", "Muitas tentativas erradas. Espere 10 minutos.");
      return;
    }
    const sala = m.sala === undefined ? SALA_PADRAO : m.sala;
    if (!salaValida(sala)) {
      fechar(conn, 4003, "formato", "Nome de sala inválido (use a-z, 0-9, - e _, até 32).");
      return;
    }
    const papel = m.papel;
    let ok = false;
    if (papel === "celular") ok = tokenCerto(codigo, sala, m.token);
    else if (papel === "operador") ok = codigoCerto(codigo, m.codigo);
    else {
      fechar(conn, 4003, "formato", "papel deve ser celular ou operador");
      return;
    }
    if (!ok) {
      freio.erro(ipCli);
      logGlobal("autenticacao recusada (" + papel + ", sala " + sala + ")");
      fechar(conn, 4001, "auth", papel === "operador" ? "Código de acesso errado." : "Token do celular errado. Escaneie o QR de novo na Central.");
      return;
    }
    freio.ok(ipCli);
    const s = hub.obter(sala);
    if (!s) {
      fechar(conn, 4005, "cheio", "O relay atingiu o limite de salas.");
      return;
    }
    conn.papel = papel;
    conn.sala = s;
    conn.vivo = true;
    const dados = { ws: conn.ws, desde: Date.now(), nome: String(m.nome || "").slice(0, 40) };
    if (papel === "celular") {
      const rate = Number(m.rate);
      dados.rate = rate === 16000 ? 16000 : 8000;
      dados.app = String(m.app || "").slice(0, 40);
      if (s.celular && s.celular.ws !== conn.ws) {
        s.log("celular reconectou: fechando a conexao antiga");
        enviar(s.celular, { t: "erro", codigo: "substituido", msg: "Outro celular entrou com o mesmo token." });
        try {
          s.celular.ws.close(4002, "substituido");
        } catch {
          /* ja fechado */
        }
      }
      s.celular = dados;
      s.log("celular conectado (app " + (dados.app || "?") + ", audio " + dados.rate + " Hz)");
    } else {
      if (s.operador && s.operador.ws !== conn.ws) {
        s.log("outra aba da Central assumiu: fechando a anterior");
        enviar(s.operador, { t: "erro", codigo: "substituido", msg: "Outra aba da Central assumiu esta linha." });
        try {
          s.operador.ws.close(4002, "substituido");
        } catch {
          /* ja fechado */
        }
      }
      s.operador = dados;
      s.log("operador conectado" + (dados.nome ? " (" + dados.nome + ")" : ""));
    }
    s.ultimaAtividade = Date.now();
    const bem = {
      ...s.presenca(),
      t: "welcome",
      papel,
      sala: s.nome,
      versao: VERSAO,
      agora: Date.now(),
      logs: s.registro.ultimas(80)
    };
    if (papel === "operador") {
      bem.tokenCelular = tokenCelular(codigo, s.nome);
      bem.relato = s.relato;
    }
    enviar(conn, bem);
    difundir(s);
  }

  function comando(conn, m) {
    const s = conn.sala;
    const deOperador = conn.papel === "operador";
    s.ultimaAtividade = Date.now();
    switch (m.t) {
      case "ping":
        enviar(conn, { t: "pong", n: m.n, em: m.em, agora: Date.now() });
        return;

      case "dial": {
        if (!deOperador) return;
        const numero = String(m.numero || "");
        if (!NUMERO.test(numero)) {
          enviar(conn, { t: "ended", causa: "numero_invalido", por: "relay" });
          return;
        }
        if (!s.celular) {
          s.log("ligacao recusada: celular offline");
          enviar(conn, { t: "ended", causa: "celular_offline", por: "relay" });
          return;
        }
        if (s.chamada) {
          enviar(conn, { t: "ended", causa: "ocupado", por: "relay" });
          return;
        }
        s.chamada = { estado: "discando", direcao: "saida", numero, inicio: 0, q: { op: 0, cel: 0, perdidos: 0 } };
        s.log("discando " + mascara(numero));
        enviar(s.celular, { t: "dial", numero });
        difundir(s);
        return;
      }

      case "answer":
        if (!deOperador || !s.chamada || s.chamada.estado !== "tocando") return;
        s.chamada.estado = "atendendo";
        s.log("operador atendeu");
        enviar(s.celular, { t: "answer" });
        difundir(s);
        return;

      case "hangup":
      case "reject": {
        if (!deOperador || !s.chamada) return;
        const c = s.chamada;
        s.log("operador pediu para desligar");
        enviar(s.celular, { t: "hangup" });
        // Se o celular nao confirmar em 4 s, o relay encerra por conta propria para a tela nao travar.
        setTimeout(() => {
          if (s.chamada === c) encerrarChamada(s, "sem_resposta_do_celular", "relay");
        }, 4000).unref();
        return;
      }

      case "dtmf":
        if (!deOperador || !s.chamada || !/^[0-9*#]$/.test(String(m.tecla))) return;
        enviar(s.celular, { t: "dtmf", tecla: String(m.tecla) });
        return;

      case "log": {
        const linhas = Array.isArray(m.linhas) ? m.linhas.slice(-40) : [];
        const fonte = deOperador ? "site" : "app";
        for (const l of linhas) {
          const l2 = s.registro.add(fonte, String(l));
          if (deOperador) continue;
          enviar(s.operador, { t: "log", linha: l2 });
        }
        return;
      }

      /* eventos do celular */
      case "incoming": {
        if (deOperador) return;
        const numero = String(m.numero || "").replace(/[^0-9+*#]/g, "").slice(0, 32) || "0";
        if (s.chamada) {
          s.log("chamada recebida enquanto ocupado: " + mascara(numero));
          enviar(s.celular, { t: "hangup" });
          return;
        }
        if (!s.operador) {
          // Sem a Central aberta ninguem atende: recusa na hora em vez de deixar quem ligou esperando no vazio.
          s.log("chamada recebida de " + mascara(numero) + " recusada: ninguem com a Central aberta para atender");
          enviar(s.celular, { t: "hangup" });
          return;
        }
        s.chamada = { estado: "tocando", direcao: "entrada", numero, inicio: 0, q: { op: 0, cel: 0, perdidos: 0 } };
        s.log("chamada recebida de " + mascara(numero));
        enviar(s.operador, { t: "incoming", numero });
        difundir(s);
        return;
      }
      case "ringing":
        if (deOperador || !s.chamada) return;
        s.chamada.estado = "chamando";
        s.log("chamando...");
        enviar(s.operador, { t: "ringing" });
        difundir(s);
        return;
      case "connected":
        if (deOperador || !s.chamada) return;
        s.chamada.estado = "ativa";
        s.chamada.inicio = Date.now();
        s.log("chamada atendida, audio liberado");
        enviar(s.operador, { t: "connected" });
        difundir(s);
        return;
      case "ended":
        if (deOperador) return;
        encerrarChamada(s, String(m.causa || "encerrada").slice(0, 60), String(m.por || "celular").slice(0, 20));
        return;
      default:
        s.log("mensagem ignorada: " + String(m.t).slice(0, 30));
    }
  }

  function audio(conn, dados) {
    const s = conn.sala;
    const c = s.chamada;
    if (!c || dados.length > MAX_QUADRO || dados.length === 0) return;
    const deOperador = conn.papel === "operador";
    const alvo = deOperador ? s.celular : s.operador;
    if (!alvo || alvo.ws.readyState !== 1) return;
    if (alvo.ws.bufferedAmount > MAX_BUFFER) {
      c.q.perdidos++;
      return;
    }
    if (deOperador) c.q.op++;
    else c.q.cel++;
    alvo.ws.send(dados, { binary: true });
  }

  function aoSair(conn) {
    conexoes.delete(conn);
    const s = conn.sala;
    if (!s) return;
    if (conn.papel === "celular" && s.celular && s.celular.ws === conn.ws) {
      s.celular = null;
      s.log("celular desconectou");
      encerrarChamada(s, "celular_caiu", "relay");
      difundir(s);
    } else if (conn.papel === "operador" && s.operador && s.operador.ws === conn.ws) {
      s.operador = null;
      s.log("operador desconectou");
      encerrarChamada(s, "operador_saiu", "relay");
      difundir(s);
    }
  }

  const servidor = http.createServer((req, res) => {
    http_(req, res).catch((e) => {
      logGlobal("erro HTTP: " + e.message);
      if (!res.headersSent) json(res, 500, { ok: false, erro: "Erro interno" });
    });
  });

  // perMessageDeflate desligado: comprimir PCM de 20 ms so adiciona atraso e CPU.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 65536 });

  servidor.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    const o = req.headers.origin ? String(req.headers.origin).replace(/\/+$/, "") : "";
    if (url.pathname !== "/ws" || (origens.length && o && !origens.includes(o))) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      if (o) logGlobal("WebSocket recusado para a origem " + o);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = { ws, papel: null, sala: null, vivo: true };
      conexoes.add(conn);
      const ipCli = ip(req);
      const espera = setTimeout(() => {
        if (!conn.papel) fechar(conn, 4003, "formato", "Faltou a mensagem hello em 5 segundos.");
      }, 5000);
      ws.on("pong", () => (conn.vivo = true));
      ws.on("message", (dados, binario) => {
        conn.vivo = true;
        if (binario) {
          if (conn.papel) audio(conn, dados);
          return;
        }
        let m;
        try {
          m = JSON.parse(dados.toString("utf8"));
        } catch {
          return;
        }
        if (!m || typeof m !== "object" || typeof m.t !== "string") return;
        if (!conn.papel) {
          if (m.t === "hello") {
            clearTimeout(espera);
            aoEntrar(conn, m, ipCli);
          }
          return;
        }
        comando(conn, m);
      });
      ws.on("close", () => {
        clearTimeout(espera);
        aoSair(conn);
      });
      ws.on("error", () => {
        /* o evento close vem logo depois */
      });
    });
  });

  // Detecta conexoes mortas (celular que perdeu o sinal sem fechar o socket) e limpa salas paradas.
  const bateria = setInterval(() => {
    for (const c of conexoes) {
      if (!c.vivo) {
        try {
          c.ws.terminate();
        } catch {
          /* ja morto */
        }
        continue;
      }
      c.vivo = false;
      try {
        c.ws.ping();
      } catch {
        /* fechando */
      }
    }
    hub.limpar();
  }, 25000);
  bateria.unref();

  return {
    http: servidor,
    hub,
    ouvir(porta = 0, endereco = "0.0.0.0") {
      return new Promise((resolve) => {
        servidor.listen(porta, endereco, () => {
          logGlobal("relay " + VERSAO + " no ar na porta " + servidor.address().port + (codigo ? "" : " (SEM ACCESS_CODE: nada vai conectar)"));
          resolve(servidor.address().port);
        });
      });
    },
    parar() {
      clearInterval(bateria);
      for (const c of conexoes) {
        try {
          c.ws.terminate();
        } catch {
          /* ja morto */
        }
      }
      return new Promise((resolve) => servidor.close(() => resolve()));
    }
  };
}

// Execucao direta: node src/servidor.js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = criarServidor();
  r.ouvir(Number(process.env.PORT || 8080));
}
