/**
 * server.js - entrada local do host.
 * Papel: importar o app e abrir a porta.
 * NAO faz: configurar rotas ou middlewares (isso e do app.js).
 */
import app from "./app.js";

const PORT = Number(process.env.PORT || 3333);

app.listen(PORT, "0.0.0.0", () => {
  console.log("Host no ar: http://localhost:" + PORT);
  console.log("Central de chamadas: http://localhost:" + PORT + "/central/");
});
