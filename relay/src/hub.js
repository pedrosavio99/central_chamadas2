/**
 * hub.js - salas do relay.
 * Papel: cada sala liga UM celular a UM operador (navegador), guarda o estado da chamada e o registro.
 * E aqui que a escala mora: uma sala e uma "linha". Para varias empresas/celulares, basta usar nomes de
 * sala diferentes. Para varias instancias do relay, este arquivo e o unico a trocar (por Redis pub/sub).
 * NAO faz: autenticar (auth.js) nem abrir portas (servidor.js).
 */
import { criarRegistro } from "./log.js";

export class Sala {
  constructor(nome) {
    this.nome = nome;
    this.celular = null; // { ws, rate, app, desde }
    this.operador = null; // { ws, nome, desde }
    this.chamada = null; // { estado, direcao, numero, inicio }
    this.relato = null; // ultimo relato HTTP do app (passo a passo da configuracao)
    this.registro = criarRegistro(400);
    this.ultimaAtividade = Date.now();
  }

  log(msg) {
    this.registro.add("relay", msg);
    this.ultimaAtividade = Date.now();
  }

  presenca() {
    return {
      t: "presenca",
      telefone: !!this.celular,
      operador: !!this.operador,
      rate: this.celular ? this.celular.rate : 8000,
      app: this.celular ? this.celular.app : "",
      chamada: this.chamada
    };
  }
}

export class Hub {
  constructor(max = 50) {
    this.max = max;
    this.salas = new Map();
  }

  /** Devolve a sala, criando se couber. null = cheio. */
  obter(nome, criar = true) {
    let s = this.salas.get(nome);
    if (!s && criar) {
      if (this.salas.size >= this.max) return null;
      s = new Sala(nome);
      this.salas.set(nome, s);
    }
    return s || null;
  }

  /** Remove salas vazias e paradas ha mais de 10 minutos. */
  limpar(agora = Date.now()) {
    for (const [nome, s] of this.salas) {
      if (!s.celular && !s.operador && agora - s.ultimaAtividade > 600000) this.salas.delete(nome);
    }
  }

  resumo() {
    const lista = [];
    for (const s of this.salas.values()) lista.push({ celular: !!s.celular, operador: !!s.operador, chamada: s.chamada ? s.chamada.estado : null });
    return { salas: lista.length, celulares: lista.filter((x) => x.celular).length, operadores: lista.filter((x) => x.operador).length };
  }
}
