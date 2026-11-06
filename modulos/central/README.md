# Módulo `central` (Central de chamadas)

Discador e histórico de chamadas no navegador. O áudio sai do navegador (WebRTC), passa pelo Asterisk
e chega ao celular Android, que faz a ligação pelo chip. Também funciona no sentido contrário: quando o
chip recebe uma ligação, ela toca no navegador.

```text
Navegador (JsSIP, WebSocket + WebRTC) <-> Asterisk <-> UDP na rede local <-> Celular (app Voice SIP Agent) <-> chip
```

## Leia antes (limites da v1)

- **Uma chamada por vez.** O celular tem uma linha só. Uma segunda chamada que chega leva "ocupado".
- **Sem tom de chamada.** O app do celular não repassa o som de "chamando" (sem early media). A tela mostra
  "Chamando..." e o áudio só começa quando o outro lado atende.
- **O celular precisa estar ligado, na mesma rede Wi-Fi do PC, com o Shizuku rodando.** Depois de reiniciar o
  celular, o Shizuku precisa ser iniciado de novo, à mão.
- **Enquanto "Take over calls" estiver ligado no app, as ligações recebidas no chip tocam no navegador e não
  no celular.**
- **Sem login.** O servidor escuta em `0.0.0.0` (contrato do `AGENTS.md`). Quem alcança a porta 3333 pela rede
  consegue ler o histórico e o estado. As credenciais do ramal só saem para o próprio PC (ver Segurança).
- **Só localhost.** O navegador só libera o microfone em `http://localhost` ou HTTPS. Abra sempre por
  `http://localhost:3333/central/`.
- **Não faça deploy na Vercel nesta versão.** O Asterisk fica no PC e a Vercel não alcança o PC.
- **Histórico só na memória do servidor** (últimas 200 chamadas). Reiniciar o servidor apaga.
- **Cada chamada feita gasta minutos do plano do chip.**

## Os dois pontos de contato com o host

O módulo não importa nada do host. Só duas linhas fora de `modulos/central/` conhecem o módulo:

1. `src/app.js`: `app.use("/central", central)`, com `import central from "../modulos/central/servidor/index.js"`.
2. `public/index.html`: `<script src="/central/aba-central.js"></script>`, que acrescenta o chip
   "Central de chamadas" no menu de módulos da página inicial.

## Árvore

```text
projeto/
├── api/index.js
├── src/
│   ├── app.js                      # monta /central (ponto de contato 1)
│   └── server.js
├── public/
│   ├── index.html                  # carrega aba-central.js (ponto de contato 2)
│   ├── estilos.css                 # tokens e componentes compartilhados
│   └── app.js
├── .github/workflows/gerar-apk.yml # compila o app do celular (não faz parte do módulo)
├── apk/qr-scan.patch               # botão Scan QR code do app (o workflow aplica)
├── modulos/central/
│   ├── servidor/
│   │   ├── index.js                # router Express: HTML, estáticos e /api
│   │   ├── rotas.mjs               # roteamento sem framework + guardas
│   │   └── nucleo.mjs              # config, .env, ARI, cache, histórico
│   ├── publico/
│   │   ├── central.html            # casca da tela
│   │   ├── central.css             # prefixo .ch-, só cores por token
│   │   ├── central.js              # estado S, render, cliques, ramal JsSIP
│   │   ├── aba-central.js          # injeta o chip no host
│   │   └── vendor/                 # JsSIP 3.13.9 e qrcode-generator 2.0.4 (ver vendor/LEIAME.md)
│   ├── asterisk/
│   │   ├── instalar.sh             # instala e configura o Asterisk
│   │   └── *.conf.modelo           # modelos de pjsip, extensions, http, ari, rtp, modules
│   ├── env.example
│   └── README.md
├── vercel.json
└── package.json
```

## Rotas

Prefixo `/central`. Respostas em JSON, sempre com `Cache-Control: no-store`.

| Método e caminho | O que faz | Observações |
|---|---|---|
| `GET /central/` | A tela | `no-store` |
| `GET /central/api/health` | `{ok, modulo, versao, mock, somenteLeitura}` | Sem credencial. Serve para saber se o módulo está montado |
| `GET /central/api/config` | Dados do ramal para o JsSIP (`wsUrl`, `ramal`, `senha`...) | Exige senhas no `.env`. Só responde ao próprio PC e a Origin local (ver Segurança) |
| `GET /central/api/celular` | Ingredientes do QR de "Conectar celular": `ips` (IPv4 de rede local do PC), `porta`, `usuario`, `senha` (a `GW_SENHA`) | Exige `GW_SENHA` no `.env` (senão 409 com a dica). Mesmas travas do `/api/config`: só o próprio PC e Origin local |
| `GET /central/api/estado` | Celular e ramal vistos pelo Asterisk (via ARI) | Cache de `CACHE_TTL_MS`. Se o ARI cai, volta `ari.ok:false` com `erro` e `dica`, sem HTTP de erro |
| `GET /central/api/chamadas` | Histórico (até 200, mais novas primeiro) | |
| `POST /central/api/chamadas` | Grava uma chamada no histórico | Passa por `guardaDeEscrita`: bloqueada com `READ_ONLY=1` e com Origin externa |

Rota inexistente devolve 404 com `Rotas válidas: ...` na dica.

Corpo do `POST /api/chamadas`: `direcao` (`saida` ou `entrada`), `numero` (dígitos, `+`, `*`, `#`; até 32),
`inicio` (ms), `duracao` (segundos, até 86400), `status` (`atendida`, `perdida` ou `falha`), `causa` (texto
até 120).

## Variáveis de ambiente

Veja o `env.example`. O servidor lê o `.env` da raiz primeiro; o `modulos/central/.env` nunca sobrescreve
o que já está definido. Normalmente quem cria o `modulos/central/.env` é o `asterisk/instalar.sh`.

| Variável | Padrão | Para quê |
|---|---|---|
| `MOCK` | `0` | `1` mostra a tela com chamadas simuladas, sem Asterisk e sem senha. Nada sai pelo chip |
| `READ_ONLY` | `0` | `1` não entrega a senha ao navegador (não dá para ligar) e recusa gravar histórico |
| `CACHE_TTL_MS` | `5000` | Quanto tempo o estado do Asterisk fica em cache |
| `CONFIG_REMOTA` | `0` | `1` entrega as credenciais também a quem não está no PC. Mantenha `0` |
| `ASTERISK_HOST` | `localhost` | Onde o Asterisk está |
| `ASTERISK_HTTP_PORT` | `8088` | Porta do HTTP interno (WebSocket e ARI) |
| `ASTERISK_WS_URL` | `ws://HOST:PORTA/ws` | Endereço do WebSocket que o navegador usa |
| `SIP_DOMINIO`, `SIP_RAMAL`, `SIP_SENHA`, `SIP_NOME` | `HOST`, `atendente`, (obrigatória), `Atendente` | Ramal do navegador |
| `GATEWAY_ENDPOINT` | `android-gw` | Nome do celular no `pjsip.conf` |
| `ARI_USUARIO`, `ARI_SENHA` | `central`, (obrigatória) | Leitura do estado no Asterisk |

Sem `SIP_SENHA` e `ARI_SENHA` (e sem `MOCK=1`), a API responde 401 dizendo o que falta e apontando o
`instalar.sh`.

## Como o Asterisk é configurado

O `asterisk/instalar.sh` preenche os `*.conf.modelo` com senhas aleatórias e grava em `/etc/asterisk`
(guardando cópia dos arquivos antigos). Resumo do que os modelos fazem:

- `[atendente]`: o navegador. WebRTC (`webrtc=yes`), G.711 (`ulaw,alaw`), um registro por vez.
- `[android-gw]`: o celular. UDP, G.711, RFC 4733 para DTMF, `trust_id_inbound` para o número de quem ligou.
- `[de-atendente]`: o que o navegador pode discar. Só `600` (teste de eco) e números brasileiros com DDD
  (10 ou 11 dígitos). Nada de 0800, internacional ou número curto: limita o estrago se alguém usar o ramal.
- `[do-celular]`: o que o celular pode alcançar. Só `android-gw`, que toca o ramal `atendente`. Não tem
  nenhum padrão de discagem, então o celular não consegue ligar para fora por aqui.
- A discagem para o celular manda o número no cabeçalho `X-VSA-Dial`, que é como o app sabe quem ligar.
- `http.conf`: WebSocket e ARI escutam só em `127.0.0.1`. A regra `acl-rede-local` do `pjsip.conf` só aceita
  SIP vindo do próprio PC e de redes privadas.

## Segurança (o que existe e o que não existe)

- `/api/config` entrega a senha do ramal. Ela só sai se a conexão vem do próprio PC (loopback) e a Origin, se
  existir, é local. Quem acessa pelo IP da rede recebe 403. `CONFIG_REMOTA=1` desliga essa trava.
- `/api/celular` entrega a senha do celular gateway (`GW_SENHA`) com as mesmas travas. O navegador monta o JSON
  do QR e desenha o QR sem gravar nada; o QR se esconde sozinho em 2 minutos e some da tela ao fechar o painel.
  Quem fotografa ou filma o QR consegue registrar um celular no seu Asterisk: não mostre a tela a estranhos.
- Com a senha do ramal, qualquer pessoa liga pelo seu chip. Por isso a senha é aleatória (32 caracteres
  hexadecimais), fica só no `.env` (fora do GitHub) e o dialplan limita os destinos.
- Não existe login na tela. Se o PC está numa rede que você não controla, libere a porta 3333 só para você
  no firewall.
- O histórico guarda números de telefone de clientes, em memória, sem criptografia.

## Verificação mínima

```bash
node --check modulos/central/publico/central.js
node --check modulos/central/servidor/rotas.mjs
MOCK=1 npm start   # em outro terminal:
curl -s localhost:3333/central/api/health | python3 -m json.tool
```

Esperado: os dois `node --check` terminam sem saída (código 0) e o health devolve `"ok": true`.

## O que não foi verificado

Foram testados: a API (31 verificações com Asterisk falso), a tela em modo MOCK e em modo real com o
JsSIP de verdade falando com um "Asterisk de mentira" por WebSocket (registro, chamada recebida, ocupado,
recusa, desistência, queda). **Não foram testados**: os `.conf` contra um Asterisk de verdade, atender e ouvir
áudio, DTMF, chamada de saída até o chip, o workflow no GitHub e o app no celular. Esses pontos são a Etapa de
testes do `PASSO-A-PASSO.md`.
