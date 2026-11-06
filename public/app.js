/**
 * app.js - script do host (pagina inicial).
 * Papel: alternar o tema e esconder o aviso "nenhum modulo" quando algum modulo injetou o seu link.
 * NAO faz: carregar modulos (cada um injeta o proprio link, ver aba-<nome>.js) nem guardar dados;
 * o localStorage guarda so a preferencia de tema.
 */
var TEMAS = ["sistema", "claro", "escuro"];
var TIMER_TOAST = 0;

function $(s) {
  return document.querySelector(s);
}

function toast(msg) {
  var t = $("#toast");
  t.textContent = msg;
  t.classList.add("visivel");
  clearTimeout(TIMER_TOAST);
  TIMER_TOAST = setTimeout(function () {
    t.classList.remove("visivel");
  }, 2600);
}

function alternarTema() {
  var atual = document.documentElement.getAttribute("data-tema") || "sistema";
  var prox = TEMAS[(TEMAS.indexOf(atual) + 1) % TEMAS.length];
  document.documentElement.setAttribute("data-tema", prox);
  try {
    localStorage.setItem("2brain-tema", prox);
  } catch (e) {}
  toast("Tema: " + prox);
}

function atualizarVazio() {
  var menu = $("#menuModulos");
  var vazio = $("#semModulos");
  if (menu && vazio) {
    vazio.hidden = menu.children.length > 0;
  }
}

document.addEventListener("click", function (ev) {
  if (ev.target.closest("#btnTema")) {
    alternarTema();
  }
});

// Os scripts dos modulos rodam depois deste; o "load" espera todos terminarem.
window.addEventListener("load", atualizarVazio);
