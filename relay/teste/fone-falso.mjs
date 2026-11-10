/**
 * fone-falso.mjs - um "celular" de mentira para testar o site e o relay sem o app Android.
 * Entra no relay como se fosse o app, atende ligacoes e manda um tom de 440 Hz (voce deve ouvir no navegador).
 * Uso:
 *   node teste/fone-falso.mjs --url https://central-relay.onrender.com --codigo SEU_ACCESS_CODE
 *   (opcional) --sala principal   --token TOKEN (em vez de --codigo)   --eco (devolve o que recebe)
 * Pelo teclado (digite e Enter): "ligar 11988887777" simula uma chamada recebida; "fim" encerra a chamada.
 */
import readline from "node:readline";
import { WebSocket } from "ws";
import { tokenCelular } from "../src/auth.js";

const arg = (nome, padrao = "") => {
  const i = process.argv.indexOf("--" + nome);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : padrao;
};
const url = arg("url", "http://127.0.0.1:8080").replace(/\/+$/, "").replace(/^http/, "ws").replace(/\/ws$/, "") + "/ws";
const sala = arg("sala", "principal");
const token = arg("token") || (arg("codigo") ? tokenCelular(arg("codigo"), sala) : "");
const eco = process.argv.includes("--eco");
if (!token) {
  console.error("Faltou --codigo (o ACCESS_CODE do relay) ou --token.");
  process.exit(2);
}

const RATE = 8000;
const QUADRO = 160; // 20 ms
let ws;
let tom = null;
let fase = 0;
let rx = 0;
let ativo = false;
let chamada = null; // "saida" | "entrada"

function dizer(m) {
  console.log(new Date().toISOString().slice(11, 23) + " [fone-falso] " + m);
}
function enviar(o) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
}

function comecarTom() {
  pararTom();
  ativo = true;
  tom = setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    const b = Buffer.alloc(QUADRO * 2);
    for (let i = 0; i < QUADRO; i++) {
      b.writeInt16LE(Math.round(Math.sin(fase) * 6000), i * 2);
      fase += (2 * Math.PI * 440) / RATE;
    }
    ws.send(b);
  }, 20);
}
function pararTom() {
  clearInterval(tom);
  tom = null;
  ativo = false;
}

function conectar() {
  ws = new WebSocket(url);
  ws.on("open", () => {
    dizer("conectado, entrando na sala " + sala);
    ws.send(JSON.stringify({ t: "hello", papel: "celular", sala, token, rate: RATE, app: "fone-falso" }));
  });
  ws.on("message", (d, bin) => {
    if (bin) {
      rx++;
      if (eco && ativo) ws.send(d);
      if (rx % 50 === 0) dizer("recebi " + rx + " quadros de audio do navegador");
      return;
    }
    const m = JSON.parse(d.toString());
    if (m.t === "welcome") dizer("no ar. Aguardando ligacoes (digite: ligar NUMERO).");
    else if (m.t === "erro") dizer("RECUSADO: " + m.msg);
    else if (m.t === "dial") {
      dizer("ligacao de saida para " + m.numero);
      chamada = "saida";
      enviar({ t: "ringing" });
      setTimeout(() => {
        enviar({ t: "connected" });
        comecarTom();
      }, 800);
    } else if (m.t === "answer") {
      dizer("atendida pelo operador");
      enviar({ t: "connected" });
      comecarTom();
    } else if (m.t === "hangup") {
      dizer("operador desligou");
      pararTom();
      chamada = null;
      enviar({ t: "ended", causa: "normal", por: "operador" });
    } else if (m.t === "dtmf") dizer("DTMF " + m.tecla);
  });
  ws.on("close", (c) => {
    dizer("desconectado (" + c + "), tentando de novo em 3 s");
    pararTom();
    if (c !== 4001 && c !== 4002) setTimeout(conectar, 3000);
  });
  ws.on("error", () => {});
}

setInterval(() => enviar({ t: "ping", n: 1, em: Date.now() }), 20000).unref();
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const [cmd, arg1] = l.trim().split(/\s+/);
  if (cmd === "ligar") {
    chamada = "entrada";
    enviar({ t: "incoming", numero: arg1 || "11988887777" });
    dizer("simulando chamada recebida de " + (arg1 || "11988887777"));
  } else if (cmd === "fim") {
    pararTom();
    enviar({ t: "ended", causa: "normal", por: "remoto" });
    dizer("encerrei a chamada pelo lado do celular");
  } else if (cmd === "log") {
    enviar({ t: "log", linhas: ["app: linha de teste do fone-falso"] });
  }
});
conectar();
