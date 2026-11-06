#!/usr/bin/env bash
# instalar.sh - instala e configura o Asterisk para a Central de chamadas (v1).
#
# Papel: instalar o Asterisk (apt), gerar senhas fortes, escrever os arquivos de /etc/asterisk a partir
# dos modelos desta pasta, criar o modulos/central/.env e conferir se tudo subiu.
# NAO faz: abrir portas no roteador, configurar o celular (isso e manual, no app) nem mexer em outra
# coisa do sistema alem de /etc/asterisk e do servico "asterisk".
#
# Uso:
#   bash modulos/central/asterisk/instalar.sh              instala (pergunta antes de mexer)
#   bash modulos/central/asterisk/instalar.sh --sim        instala sem perguntar
#   bash modulos/central/asterisk/instalar.sh --so-gerar   so gera os arquivos em asterisk/gerado/ (nao usa sudo)
#
# Pode rodar de novo quantas vezes quiser: as senhas do .env sao reaproveitadas.

set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULO="$(dirname "$AQUI")"
ENV_MODULO="$MODULO/.env"
DESTINO="/etc/asterisk"
GERADO="$AQUI/gerado"
AGORA="$(date +%Y%m%d-%H%M%S)"
BACKUP="$DESTINO/backup-central-$AGORA"
ARQUIVOS=(pjsip.conf extensions.conf http.conf ari.conf rtp.conf modules.conf)

MODO_SIM=0
SO_GERAR=0

# ---------------------------------------------------------------- utilidades

ok() { printf '  [ok] %s\n' "$*"; }
aviso() { printf '  [atencao] %s\n' "$*"; }
passo() { printf '\n== %s\n' "$*"; }
falhar() {
  printf '\n[ERRO] %s\n' "$1" >&2
  if [ -n "${2:-}" ]; then printf '       %s\n' "$2" >&2; fi
  exit 1
}

uso() {
  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

for arg in "$@"; do
  case "$arg" in
    --sim) MODO_SIM=1 ;;
    --so-gerar) SO_GERAR=1 ;;
    -h | --ajuda | --help) uso ;;
    *) falhar "Opção desconhecida: $arg" "Use --ajuda para ver as opções." ;;
  esac
done

# Senha em hexadecimal: sem caractere especial, entao cabe em .conf e em sed sem escape.
gerar_senha() {
  if command -v openssl > /dev/null 2>&1; then
    openssl rand -hex 16
  else
    head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# Le o valor de uma chave do .env (vazio se nao existir). Aspas ao redor sao removidas, como no nucleo.mjs.
ler_env() {
  local chave="$1" linha valor
  [ -f "$ENV_MODULO" ] || return 0
  linha="$(grep -E "^${chave}=" "$ENV_MODULO" | head -n 1 || true)"
  valor="${linha#*=}"
  valor="${valor%\"}"
  valor="${valor#\"}"
  printf '%s' "$valor"
}

# Define a chave trocando a linha existente (o nucleo.mjs usa a PRIMEIRA ocorrencia, entao duplicar quebraria).
definir_env() {
  local chave="$1" valor="$2"
  if grep -qE "^${chave}=" "$ENV_MODULO"; then
    sed -i "s|^${chave}=.*|${chave}=${valor}|" "$ENV_MODULO"
  else
    printf '%s=%s\n' "$chave" "$valor" >> "$ENV_MODULO"
  fi
}

# Descobre o IP do PC na rede local, que e o que o celular precisa digitar no app.
ip_da_rede() {
  local ip=""
  if command -v ip > /dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2> /dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)"
  fi
  if [ -z "$ip" ] && command -v hostname > /dev/null 2>&1; then
    ip="$(hostname -I 2> /dev/null | awk '{print $1}' || true)"
  fi
  printf '%s' "$ip"
}

# ---------------------------------------------------------------- 0. antes de tudo

passo "Conferindo o ambiente"

[ -d "$AQUI" ] && [ -f "$AQUI/pjsip.conf.modelo" ] || falhar "Não achei os modelos (*.conf.modelo) ao lado deste script." "Rode a partir da pasta do projeto: bash modulos/central/asterisk/instalar.sh"

if [ "$(id -u)" -eq 0 ]; then
  falhar "Não rode como root nem com sudo." "O script chama sudo só onde precisa. Rodando como root, o .env ficaria com dono root e o servidor não conseguiria lê-lo."
fi

if [ "$SO_GERAR" -eq 0 ]; then
  command -v apt-get > /dev/null 2>&1 || falhar "Este instalador usa apt (Pop!_OS, Ubuntu, Debian)." "Em outra distro, rode com --so-gerar e copie os arquivos de asterisk/gerado/ para /etc/asterisk à mão."
  command -v sudo > /dev/null 2>&1 || falhar "O comando sudo não existe neste sistema."
fi

for modelo in "${ARQUIVOS[@]}"; do
  [ -f "$AQUI/$modelo.modelo" ] || falhar "Falta o modelo $modelo.modelo na pasta asterisk/."
done
ok "ambiente e modelos encontrados"

# ---------------------------------------------------------------- 1. o que vai acontecer

if [ "$SO_GERAR" -eq 1 ]; then
  echo
  echo "Modo --so-gerar: nada do sistema será alterado."
  echo "  - cria/completa  $ENV_MODULO"
  echo "  - escreve os arquivos prontos em  $GERADO/"
else
  cat << EOF

Este script vai:
  1. instalar o pacote "asterisk" com apt, se ainda não estiver instalado;
  2. gerar senhas aleatórias e guardá-las em  $ENV_MODULO  (se ainda não existirem);
  3. SUBSTITUIR estes arquivos em $DESTINO:
       ${ARQUIVOS[*]}
     (os atuais vão para $BACKUP antes);
  4. reiniciar o serviço asterisk e conferir se subiu.

Isto transforma este PC em uma central telefônica na rede local. Use num PC de desenvolvimento.
EOF
  if [ "$MODO_SIM" -eq 0 ]; then
    printf '\nContinuar? [s/N] '
    read -r resposta
    case "$resposta" in
      s | S | sim | SIM | y | Y) ;;
      *) echo "Cancelado. Nada foi alterado."; exit 0 ;;
    esac
  fi
  sudo -v || falhar "Preciso do sudo para instalar e configurar o Asterisk."
fi

# ---------------------------------------------------------------- 2. pacote

if [ "$SO_GERAR" -eq 0 ]; then
  passo "Asterisk"
  if command -v asterisk > /dev/null 2>&1; then
    ok "já instalado"
  else
    sudo apt-get update
    sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y asterisk
    ok "instalado"
  fi
  VERSAO_TXT="$(asterisk -V 2> /dev/null || true)"
  VERSAO_MAIOR="${VERSAO_TXT#Asterisk }"
  VERSAO_MAIOR="${VERSAO_MAIOR%%.*}"
  case "$VERSAO_MAIOR" in
    '' | *[!0-9]*) aviso "Não consegui ler a versão do Asterisk (\"$VERSAO_TXT\"). Seguindo assim mesmo." ;;
    *)
      if [ "$VERSAO_MAIOR" -lt 18 ]; then
        falhar "Asterisk $VERSAO_TXT é antigo demais (preciso do 18 ou mais novo para o WebRTC)." "Instale uma versão mais nova e rode de novo."
      fi
      ok "versão: $VERSAO_TXT"
      ;;
  esac
fi

# ---------------------------------------------------------------- 3. senhas e .env

passo "Senhas e .env"

if [ ! -f "$ENV_MODULO" ]; then
  cat > "$ENV_MODULO" << EOF
# Gerado pelo instalar.sh em $(date '+%Y-%m-%d %H:%M'). Contém senhas: NUNCA suba para o GitHub.
ASTERISK_HOST=localhost
ASTERISK_HTTP_PORT=8088
SIP_DOMINIO=localhost
SIP_RAMAL=atendente
SIP_NOME=Atendente
GATEWAY_ENDPOINT=android-gw
ARI_USUARIO=central
EOF
  ok "criado $ENV_MODULO"
else
  ok "reaproveitando $ENV_MODULO"
fi
chmod 600 "$ENV_MODULO"

SIP_SENHA="$(ler_env SIP_SENHA)"
ARI_SENHA="$(ler_env ARI_SENHA)"
GW_SENHA="$(ler_env GW_SENHA)"
[ -n "$SIP_SENHA" ] || { SIP_SENHA="$(gerar_senha)"; definir_env SIP_SENHA "$SIP_SENHA"; ok "senha do ramal do navegador gerada"; }
[ -n "$ARI_SENHA" ] || { ARI_SENHA="$(gerar_senha)"; definir_env ARI_SENHA "$ARI_SENHA"; ok "senha do ARI gerada"; }
if [ -z "$GW_SENHA" ]; then
  GW_SENHA="$(gerar_senha)"
  # Esta chave o servidor Node ignora: ela fica aqui so para voce consultar na hora de configurar o app do celular.
  definir_env GW_SENHA "$GW_SENHA"
  ok "senha do celular gateway gerada"
fi

# ---------------------------------------------------------------- 4. arquivos do Asterisk

passo "Arquivos de configuração"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for nome in "${ARQUIVOS[@]}"; do
  sed \
    -e "s|__SIP_SENHA__|$SIP_SENHA|g" \
    -e "s|__GW_SENHA__|$GW_SENHA|g" \
    -e "s|__ARI_SENHA__|$ARI_SENHA|g" \
    "$AQUI/$nome.modelo" > "$TMP/$nome"
  if grep -q '__[A-Z_]*SENHA__' "$TMP/$nome"; then
    falhar "Sobrou um marcador __..._SENHA__ sem trocar em $nome." "Isso é um defeito do instalador; não instalei nada."
  fi
done
ok "modelos preenchidos"

if [ "$SO_GERAR" -eq 1 ]; then
  mkdir -p "$GERADO"
  chmod 700 "$GERADO"
  for nome in "${ARQUIVOS[@]}"; do
    install -m 600 "$TMP/$nome" "$GERADO/$nome"
  done
  ok "arquivos escritos em $GERADO/ (têm senhas: não suba para o GitHub)"
else
  getent passwd asterisk > /dev/null 2>&1 || falhar "O usuário de sistema \"asterisk\" não existe." "O pacote do Asterisk cria esse usuário. Confira a instalação."
  sudo mkdir -p "$BACKUP"
  TEVE_BACKUP=0
  for nome in "${ARQUIVOS[@]}"; do
    if [ -f "$DESTINO/$nome" ]; then
      sudo cp -a "$DESTINO/$nome" "$BACKUP/$nome"
      TEVE_BACKUP=1
    fi
  done
  if [ "$TEVE_BACKUP" -eq 1 ]; then
    ok "backup dos arquivos antigos em $BACKUP"
  else
    sudo rmdir "$BACKUP" 2> /dev/null || true
  fi
  for nome in "${ARQUIVOS[@]}"; do
    sudo install -o asterisk -g asterisk -m 640 "$TMP/$nome" "$DESTINO/$nome"
  done
  ok "arquivos instalados em $DESTINO"
fi

# ---------------------------------------------------------------- 5. reiniciar e conferir

IP_REDE="$(ip_da_rede)"

if [ "$SO_GERAR" -eq 0 ]; then
  passo "Reiniciando o Asterisk"
  sudo systemctl enable asterisk > /dev/null 2>&1 || aviso "Não consegui habilitar o serviço no boot (segue funcionando agora)."
  sudo systemctl restart asterisk
  PRONTO=0
  for _ in $(seq 1 30); do
    if sudo asterisk -rx "core waitfullybooted" > /dev/null 2>&1; then
      PRONTO=1
      break
    fi
    sleep 1
  done
  [ "$PRONTO" -eq 1 ] || falhar "O Asterisk não ficou pronto em 30 segundos." "Veja: sudo journalctl -u asterisk -n 50 --no-pager"
  ok "Asterisk no ar"

  passo "Conferindo"
  ENDPOINTS="$(sudo asterisk -rx "pjsip show endpoints" 2>&1 || true)"
  PROBLEMA=0
  for ep in atendente android-gw; do
    if printf '%s\n' "$ENDPOINTS" | grep -qE "Endpoint: +${ep}( |/)"; then
      ok "endpoint $ep carregado"
    else
      aviso "endpoint $ep NÃO apareceu no Asterisk"
      PROBLEMA=1
    fi
  done
  if [ "$PROBLEMA" -eq 1 ]; then
    echo
    echo "Saída de 'pjsip show endpoints':"
    printf '%s\n' "$ENDPOINTS" | sed 's/^/    /'
    echo
    echo "Erros de configuração costumam aparecer em:"
    echo "    sudo grep -iE 'error|warning' /var/log/asterisk/messages | tail -n 30"
    echo "Seus arquivos antigos estão em $BACKUP (se existiam)."
    falhar "O Asterisk subiu, mas recusou parte da configuração." "Mande a saída acima para quem estiver te ajudando."
  fi

  if command -v ss > /dev/null 2>&1; then
    if ss -H -lun 'sport = :5060' 2> /dev/null | grep -q .; then ok "SIP escutando em UDP 5060"; else aviso "Nada escutando em UDP 5060 (o celular não vai conseguir registrar)"; fi
    if ss -H -ltn 'sport = :8088' 2> /dev/null | grep -q '127.0.0.1'; then ok "WebSocket/ARI escutando só em 127.0.0.1:8088"; else aviso "Nada escutando em 127.0.0.1:8088 (o navegador não vai conseguir registrar)"; fi
  fi

  if command -v curl > /dev/null 2>&1; then
    CODIGO="$(curl -s -o /dev/null -w '%{http_code}' -u "central:$ARI_SENHA" http://127.0.0.1:8088/ari/endpoints/PJSIP || true)"
    if [ "$CODIGO" = "200" ]; then ok "ARI respondeu (o servidor da Central vai enxergar o celular)"; else aviso "ARI respondeu HTTP $CODIGO em vez de 200"; fi
  fi

  if command -v ufw > /dev/null 2>&1 && sudo ufw status 2> /dev/null | grep -q "Status: active"; then
    REDE="${IP_REDE%.*}.0/24"
    echo
    aviso "O firewall ufw está ATIVO e vai bloquear o celular. Libere só a sua rede local:"
    echo "    sudo ufw allow proto udp from $REDE to any port 5060"
    echo "    sudo ufw allow proto udp from $REDE to any port 10000:10100"
  fi
fi

# ---------------------------------------------------------------- 6. recado final

passo "Pronto. Agora configure o app no celular (Voice SIP Agent)"
cat << EOF

  Servidor (PBX host) : ${IP_REDE:-<o IP deste PC na rede; rode: hostname -I>}
  Porta               : 5060
  Transporte          : udp
  SRTP                : off
  Usuário             : android-gw
  Senha               : $GW_SENHA
  Domínio SIP         : (deixe em branco)

  O celular e este PC precisam estar na MESMA rede Wi-Fi.
  A senha acima também está em $ENV_MODULO (chave GW_SENHA).

  Para abrir a Central:
    npm start
    http://localhost:3333/central/        (use localhost: o navegador só libera o microfone assim)

EOF
if [ "$SO_GERAR" -eq 0 ] && [ -d "$BACKUP" ]; then
  echo "  Para desfazer e voltar aos arquivos antigos do Asterisk:"
  echo "    sudo cp -a $BACKUP/. $DESTINO/ && sudo systemctl restart asterisk"
  echo
fi
