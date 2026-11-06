/**
 * index.js - entrada serverless da Vercel.
 * Papel: exportar o app do Express para a Vercel chamar como funcao.
 * NAO faz: listen nem configuracao (tudo isso vive em src/app.js).
 */
import app from "../src/app.js";

export default app;
