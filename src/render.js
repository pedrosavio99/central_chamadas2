/**
 * render.js - entrada unica do Render: o site (Express) e o relay (WebSocket) no MESMO servidor e na mesma porta.
 * Papel: subir os dois juntos. O site fala com o relay no proprio endereco: sem CORS, sem RELAY_URL, um servico so.
 * NAO faz: regra do site (src/app.js) nem do relay (relay/src/). Tambem roda no PC: node src/render.js
 */

// O nucleo do modulo le o ambiente assim que carrega: por isso o ambiente fica pronto antes e os imports sao dinamicos.
process.env.MODO = process.env.MODO || "online";
process.env.RELAY_EMBUTIDO = "1";

const { criarServidor } = await import("../relay/src/servidor.js");
const { default: app } = await import("./app.js");

// Estes tres caminhos sao do relay (o app do celular e a tela chamam /relato e /log; o Render confere o /health).
// O WebSocket (/ws) o proprio relay atende. Todo o resto e o site.
const CAMINHOS_DO_RELAY = new Set(["/health", "/relato", "/log"]);

const relay = criarServidor();
const servidor = relay.http;
const tratadorDoRelay = servidor.listeners("request")[0];
servidor.removeAllListeners("request");
servidor.on("request", (req, res) => {
  const caminho = String(req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
  if (CAMINHOS_DO_RELAY.has(caminho)) return tratadorDoRelay.call(servidor, req, res);
  return app(req, res);
});

const porta = Number(process.env.PORT || 3333);
await relay.ouvir(porta);
console.log("Central de chamadas: http://localhost:" + porta + "/central/");

// O Render manda SIGTERM ao publicar uma versao nova: fecha as conexoes direito para o app reconectar logo.
process.on("SIGTERM", async () => {
  await relay.parar();
  process.exit(0);
});
