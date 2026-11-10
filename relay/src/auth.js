/**
 * auth.js - codigo de acesso, token do celular e freio de tentativas.
 * Papel: decidir quem pode entrar. Sem estado de sessao: o token do celular e derivado do codigo,
 * entao reiniciar o relay (o Render gratis faz isso quando quer) nao desloga ninguem.
 * NAO faz: falar WebSocket nem guardar nada alem do contador de erros por IP.
 */
import crypto from "node:crypto";

const NOME_SALA = /^[a-z0-9_-]{1,32}$/;

export function salaValida(s) {
  return typeof s === "string" && NOME_SALA.test(s);
}

function hmac(codigo, texto) {
  return crypto.createHmac("sha256", codigo).update(texto).digest("hex").slice(0, 32);
}

/** Token que o app do celular usa nesta sala. Quem tem o codigo de acesso consegue calcula-lo. */
export function tokenCelular(codigo, sala) {
  return hmac(codigo, "celular|" + sala);
}

function igual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) {
    // Compara mesmo assim para o tempo nao revelar o tamanho certo.
    crypto.timingSafeEqual(x, x);
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

export function codigoCerto(codigo, informado) {
  return !!codigo && typeof informado === "string" && igual(codigo, informado);
}

export function tokenCerto(codigo, sala, informado) {
  return !!codigo && typeof informado === "string" && igual(tokenCelular(codigo, sala), informado);
}

/** Freio simples: 10 erros em 10 minutos bloqueiam o IP por 10 minutos. */
export function criarFreio(max = 10, janelaMs = 600000) {
  const mapa = new Map();
  function limpar(agora) {
    for (const [ip, r] of mapa) if (r.ate < agora) mapa.delete(ip);
  }
  return {
    bloqueado(ip) {
      const r = mapa.get(ip);
      return !!r && r.n >= max && r.ate > Date.now();
    },
    erro(ip) {
      const agora = Date.now();
      if (mapa.size > 5000) limpar(agora);
      const r = mapa.get(ip);
      if (!r || r.ate < agora) mapa.set(ip, { n: 1, ate: agora + janelaMs });
      else r.n++;
    },
    ok(ip) {
      mapa.delete(ip);
    }
  };
}
