/**
 * log.js - registro em memoria do relay (anel de linhas).
 * Papel: guardar as ultimas linhas para a tela da Central mostrar e copiar.
 * NAO faz: gravar em disco (o disco do Render gratis some a cada reinicio) nem guardar segredos.
 */

export function criarRegistro(limite = 400) {
  const linhas = [];
  return {
    /** fonte: "relay" | "app" | "site". Devolve a linha criada. */
    add(fonte, msg) {
      const l = { t: Date.now(), f: fonte, m: String(msg).slice(0, 300) };
      linhas.push(l);
      if (linhas.length > limite) linhas.splice(0, linhas.length - limite);
      return l;
    },
    ultimas(n = 80) {
      return linhas.slice(-n);
    },
    texto() {
      return linhas.map(formatarLinha).join("\n") + "\n";
    }
  };
}

export function formatarLinha(l) {
  const d = new Date(l.t);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds()) + "." + p(d.getUTCMilliseconds(), 3) + "Z [" + l.f + "] " + l.m;
}
