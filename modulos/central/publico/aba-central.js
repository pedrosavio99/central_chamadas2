/**
 * aba-central.js - injeta o link da Central de Chamadas no menu do host.
 * Papel: segundo e ultimo ponto de acoplamento com o host (o primeiro e o app.use no servidor).
 * NAO faz: carregar nada do modulo nem mexer em outro elemento do host alem do #menuModulos.
 */
(function () {
  var menu = document.getElementById("menuModulos");
  if (!menu || menu.querySelector('[data-modulo="central"]')) {
    return;
  }
  var link = document.createElement("a");
  link.className = "chip";
  link.href = "/central/";
  link.setAttribute("data-modulo", "central");
  link.textContent = "Central de chamadas";
  menu.appendChild(link);
})();
