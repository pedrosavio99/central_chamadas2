/**
 * e2e.mjs - teste de ponta a ponta do relay com um celular e um navegador falsos.
 * Rode: npm test (dentro de relay/). Sobe o relay numa porta livre, nao precisa de rede.
 */
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { criarServidor } from "../src/servidor.js";
import { tokenCelular } from "../src/auth.js";

const CODIGO = "codigo-de-teste-123";
const srv = criarServidor({ codigo: CODIGO, silencioso: true });
const porta = await srv.ouvir(0, "127.0.0.1");
const HTTP = "http://127.0.0.1:" + porta;
const WS = "ws://127.0.0.1:" + porta + "/ws";
let n = 0;
function ok(nome) {
  n++;
  console.log("ok " + n + " - " + nome);
}

function cliente(hello) {
  const ws = new WebSocket(WS);
  const c = { ws, msgs: [], bin: [], fechou: null };
  c.pronto = new Promise((res, rej) => {
    ws.on("open", () => {
      if (hello) ws.send(JSON.stringify(hello));
      res();
    });
    ws.on("error", rej);
  });
  ws.on("message", (d, b) => (b ? c.bin.push(d) : c.msgs.push(JSON.parse(d.toString()))));
  ws.on("close", (cod) => (c.fechou = cod));
  c.espera = async (fn, ms = 2000) => {
    const fim = Date.now() + ms;
    while (Date.now() < fim) {
      const a = c.msgs.find(fn);
      if (a) return a;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timeout esperando mensagem; recebidas: " + JSON.stringify(c.msgs));
  };
  c.esperaBin = async (min = 1, ms = 2000) => {
    const fim = Date.now() + ms;
    while (Date.now() < fim) {
      if (c.bin.length >= min) return c.bin;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timeout esperando audio");
  };
  c.fecha = async (ms = 2000) => {
    const fim = Date.now() + ms;
    while (c.fechou === null && Date.now() < fim) await new Promise((r) => setTimeout(r, 10));
    return c.fechou;
  };
  c.envia = (o) => ws.send(JSON.stringify(o));
  return c;
}

try {
  // 1. health
  let r = await (await fetch(HTTP + "/health")).json();
  assert.equal(r.ok, true);
  assert.equal(r.configurado, true);
  ok("health responde e diz que esta configurado");

  // 2. CORS e OPTIONS
  const op = await fetch(HTTP + "/relato", { method: "OPTIONS", headers: { Origin: "https://x.vercel.app" } });
  assert.equal(op.status, 204);
  assert.equal(op.headers.get("access-control-allow-origin"), "*");
  ok("CORS libera o site em outro dominio");

  // 3. auth errada
  const ruim = cliente({ t: "hello", papel: "operador", sala: "principal", codigo: "errado" });
  await ruim.pronto;
  const e = await ruim.espera((m) => m.t === "erro");
  assert.equal(e.codigo, "auth");
  assert.equal(await ruim.fecha(), 4001);
  ok("codigo errado e recusado com erro auth");

  const ruimCel = cliente({ t: "hello", papel: "celular", sala: "principal", token: "x" });
  await ruimCel.pronto;
  assert.equal((await ruimCel.espera((m) => m.t === "erro")).codigo, "auth");
  ok("token errado do celular e recusado");

  // 4. operador entra e recebe o token do celular
  const oper = cliente({ t: "hello", papel: "operador", sala: "principal", codigo: CODIGO, nome: "teste" });
  await oper.pronto;
  const bem = await oper.espera((m) => m.t === "welcome");
  assert.equal(bem.telefone, false);
  assert.match(bem.tokenCelular, /^[0-9a-f]{32}$/);
  ok("operador entra e recebe tokenCelular");

  // 5. relato HTTP com token
  const cab = { "Content-Type": "application/json", "X-Sala": "principal", Authorization: "Bearer " + bem.tokenCelular };
  let rr = await fetch(HTTP + "/relato", { method: "POST", headers: cab, body: JSON.stringify({ sid: "s1", configurado: true, pareado: false, helper: "CONNECTING", pronto: false, log: ["linha 1"] }) });
  assert.equal(rr.status, 200);
  const rel = await oper.espera((m) => m.t === "relato");
  assert.equal(rel.dados.helper, "CONNECTING");
  ok("relato HTTP do app chega ao operador pelo WebSocket");
  rr = await fetch(HTTP + "/relato", { method: "POST", headers: { ...cab, Authorization: "Bearer zzz" }, body: "{}" });
  assert.equal(rr.status, 401);
  ok("relato com token errado da 401");

  // 6. celular entra; operador ve presenca
  const cel = cliente({ t: "hello", papel: "celular", sala: "principal", token: bem.tokenCelular, rate: 8000, app: "teste" });
  await cel.pronto;
  await cel.espera((m) => m.t === "welcome");
  await oper.espera((m) => m.t === "presenca" && m.telefone === true);
  ok("operador fica sabendo que o celular entrou");

  // 7. ligacao de saida
  oper.envia({ t: "dial", numero: "11999998888" });
  assert.equal((await cel.espera((m) => m.t === "dial")).numero, "11999998888");
  cel.envia({ t: "ringing" });
  await oper.espera((m) => m.t === "ringing");
  cel.envia({ t: "connected" });
  await oper.espera((m) => m.t === "connected");
  ok("ligacao de saida: dial, ringing, connected");

  // 8. audio nos dois sentidos
  const quadro = Buffer.alloc(320, 7);
  for (let i = 0; i < 5; i++) {
    oper.ws.send(quadro);
    cel.ws.send(Buffer.alloc(320, 9));
  }
  const bc = await cel.esperaBin(5);
  const bo = await oper.esperaBin(5);
  assert.equal(bc[0].length, 320);
  assert.equal(bc[0][0], 7);
  assert.equal(bo[0][0], 9);
  ok("audio passa nos dois sentidos sem alterar");

  // 9. dtmf
  oper.envia({ t: "dtmf", tecla: "5" });
  assert.equal((await cel.espera((m) => m.t === "dtmf")).tecla, "5");
  oper.envia({ t: "dtmf", tecla: "x" });
  ok("dtmf valido chega ao celular");

  // 10. desligar
  oper.envia({ t: "hangup" });
  await cel.espera((m) => m.t === "hangup");
  cel.envia({ t: "ended", causa: "normal", por: "local" });
  const fim = await oper.espera((m) => m.t === "ended");
  assert.equal(fim.causa, "normal");
  ok("desligar: hangup ao celular e ended ao operador");

  // 11. audio fora de chamada e descartado
  const antes = cel.bin.length;
  oper.ws.send(quadro);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(cel.bin.length, antes);
  ok("audio fora de chamada nao passa");

  // 12. chamada recebida
  cel.envia({ t: "incoming", numero: "+5511988887777" });
  assert.equal((await oper.espera((m) => m.t === "incoming")).numero, "+5511988887777");
  oper.envia({ t: "answer" });
  await cel.espera((m) => m.t === "answer");
  cel.envia({ t: "connected" });
  await oper.espera((m) => m.t === "connected" && oper.msgs.filter((x) => x.t === "connected").length >= 2);
  oper.envia({ t: "hangup" });
  await cel.espera((m) => m.t === "hangup" && cel.msgs.filter((x) => x.t === "hangup").length >= 2);
  cel.envia({ t: "ended", causa: "normal", por: "local" });
  await oper.espera((m) => m.t === "ended" && oper.msgs.filter((x) => x.t === "ended").length >= 2);
  ok("ligacao recebida: incoming, answer, connected, hangup");

  // 13. celular cai durante a chamada
  oper.envia({ t: "dial", numero: "1199" });
  await cel.espera((m) => m.t === "dial" && cel.msgs.filter((x) => x.t === "dial").length >= 2);
  cel.ws.close();
  const caiu = await oper.espera((m) => m.t === "ended" && m.causa === "celular_caiu");
  assert.equal(caiu.por, "relay");
  ok("celular cair no meio da chamada encerra para o operador");

  // 14. discar sem celular
  oper.envia({ t: "dial", numero: "1199" });
  await oper.espera((m) => m.t === "ended" && m.causa === "celular_offline");
  ok("discar sem celular avisa celular_offline");

  // 15. celular reconecta; segundo operador assume
  const cel2 = cliente({ t: "hello", papel: "celular", sala: "principal", token: bem.tokenCelular, rate: 8000 });
  await cel2.pronto;
  await cel2.espera((m) => m.t === "welcome");
  const oper2 = cliente({ t: "hello", papel: "operador", sala: "principal", codigo: CODIGO });
  await oper2.pronto;
  await oper2.espera((m) => m.t === "welcome");
  assert.equal((await oper.espera((m) => m.t === "erro")).codigo, "substituido");
  assert.equal(await oper.fecha(), 4002);
  ok("segunda aba assume e a primeira recebe substituido");

  // 16. ping/pong e log
  oper2.envia({ t: "ping", n: 5 });
  assert.equal((await oper2.espera((m) => m.t === "pong")).n, 5);
  cel2.envia({ t: "log", linhas: ["app: ola", "app: segunda"] });
  const lg = await oper2.espera((m) => m.t === "log");
  assert.equal(lg.linha.f, "app");
  const txt = await (await fetch(HTTP + "/log?sala=principal", { headers: { "X-Codigo": CODIGO } })).text();
  assert.match(txt, /\[app\] app: ola/);
  assert.match(txt, /\[relay\] celular conectado/);
  assert.ok(!txt.includes(CODIGO) && !txt.includes(bem.tokenCelular), "o log nao pode conter segredos");
  assert.ok(!txt.includes("11999998888"), "o log nao pode conter numero inteiro");
  ok("ping, log do app e GET /log (sem segredos nem numeros inteiros)");
  assert.equal((await fetch(HTTP + "/log", { headers: { "X-Codigo": "x" } })).status, 401);
  ok("GET /log sem codigo da 401");

  // 17. salas separadas
  const outraOp = cliente({ t: "hello", papel: "operador", sala: "empresa-b", codigo: CODIGO });
  await outraOp.pronto;
  const b2 = await outraOp.espera((m) => m.t === "welcome");
  assert.equal(b2.telefone, false);
  assert.notEqual(b2.tokenCelular, bem.tokenCelular);
  ok("salas sao isoladas e tem tokens diferentes");

  // 18. sem hello em 5 s nao testamos (lento); mensagem invalida e ignorada
  const lixo = cliente(null);
  await lixo.pronto;
  lixo.ws.send("nao e json");
  lixo.ws.send(Buffer.alloc(10));
  lixo.ws.close();
  ok("lixo antes do hello nao derruba o servidor");

  // 19. chamada recebida sem a Central aberta: o celular recebe hangup e nenhuma chamada fica pendurada
  const tokSolo = tokenCelular(CODIGO, "so-celular");
  const solo = cliente({ t: "hello", papel: "celular", sala: "so-celular", token: tokSolo });
  await solo.pronto;
  await solo.espera((m) => m.t === "welcome");
  solo.envia({ t: "incoming", numero: "+5511977776666" });
  await solo.espera((m) => m.t === "hangup");
  const opSolo = cliente({ t: "hello", papel: "operador", sala: "so-celular", codigo: CODIGO });
  await opSolo.pronto;
  const wSolo = await opSolo.espera((m) => m.t === "welcome");
  assert.ok(!wSolo.chamada, "nao pode sobrar chamada pendurada");
  ok("chamada recebida sem operador e recusada e nao fica pendurada");

  for (const c of [oper2, cel2, outraOp, solo, opSolo]) c.ws.close();
  console.log("\nTudo certo: " + n + " verificacoes.");
} catch (err) {
  console.error("FALHOU:", err.message);
  process.exitCode = 1;
} finally {
  await srv.parar();
}
