# apk/ (alteracoes no app do celular)

O app Voice SIP Agent e de terceiros (https://github.com/sparkcyf/android-voice-sip-agent, GPL-2.0). Este
repositorio nao guarda uma copia dele: o workflow `.github/workflows/gerar-apk.yml` baixa o codigo na versao
fixada e, antes de compilar, aplica os patches desta pasta (nesta ordem: `qr-scan`, `sem-shizuku`).

## qr-scan.patch

Acrescenta ao app o botao **Scan QR code** (na secao "Configuration file", ao lado de "Import from file").

- Le o QR que a Central mostra em **Conectar celular**, mostra a lista de mudancas e so aplica depois que voce
  toca em **Import**. Reaproveita o mesmo importador de arquivo JSON que o app ja tem (`ConfigFile`).
- Usa o leitor de codigos do Google Play Services (`play-services-code-scanner`): nao pede permissao de
  camera e nao guarda imagem. Precisa de Google Play Services no celular. O modulo do leitor e baixado
  na hora da primeira leitura, ou antes, na instalacao (meta-data `barcode_ui`).
- Mexe em 4 arquivos (31 linhas): `gradle/libs.versions.toml`, `app/build.gradle.kts`,
  `app/src/main/AndroidManifest.xml` e `MainActivity.kt`.
- Foi escrito para o commit `298d64b89b13e7737708972947390d2d84450200` (v0.4.1). Em outra versao do app o
  workflow para com uma mensagem clara se o patch nao encaixar.

## sem-shizuku.patch

Tira a dependencia do app **Shizuku**. O Voice SIP Agent precisa rodar um pedaco de codigo como usuario `shell`
(uid 2000) para capturar e injetar o audio da chamada; o upstream pedia o Shizuku para isso. Com este patch o
proprio app faz o que o Shizuku fazia:

- **Pareamento unico, sem digitar.** O app e cliente ADB (biblioteca libadb-android 3.1.1, do JitPack). O QR de
  configuracao da Central ganha a chave extra `adbPairing` (nome e senha sorteados a cada abertura do painel); o
  app a separa antes de ler o arquivo, guarda os dois e passa a procurar o servico mDNS `_adb-tls-pairing._tcp`
  com aquele nome. Em Depuracao sem fio, **Parear dispositivo com codigo QR**, o celular le o segundo QR da
  Central (`WIFI:T:ADB;S:nome;P:senha;;`) e anuncia o servico; o app, que ja sabe a senha, pareia sozinho (tenta
  127.0.0.1 e depois o endereco anunciado). Digitar o codigo de 6 digitos continua como alternativa. A chave RSA
  do app fica em `files/` (so o app le).
- **Helper como shell.** A cada partida o app conecta no `adbd` do proprio celular (127.0.0.1, porta TLS), roda um
  comando de shell que inicia `HelperMain` (`app_process` como uid 2000, `CLASSPATH` = o APK do app) e fecha a
  conexao ADB. O helper entrega o `Binder` ao app por um `ContentProvider` protegido por
  `INTERACT_ACROSS_USERS_FULL`, so aceita o uid 2000/0 e um nonce de uso unico, e morre quando o app morre.
- **Volta sozinho.** O app concede a si mesmo `WRITE_SECURE_SETTINGS` (por ADB, no primeiro pareamento) e usa
  isso para religar a Depuracao sem fio apos reiniciar. Tentativas com espera crescente (4 s a 30 s); abrir o app
  tenta na hora. Precisa de Wi-Fi.
- **Telas.** Caixa **First setup** no topo com o passo a passo, estado **Privileged helper** na aba Health e botao
  **Reconnect helper**. Sai o botao "Grant Shizuku".
- **Relato ao vivo.** O QR de configuracao da Central tem ainda a chave `central` (`{"url": "http://IP:3333/central"}`). O
  app a separa antes de ler o arquivo e, a cada 3 segundos, por 45 minutos, manda `POST /api/celular/relato` com o
  progresso (configurado, pareado, estado do helper, acesso as chamadas, audio, registro SIP e as ultimas 30 linhas
  do log, com a senha do SIP trocada por `***`). A Central mostra isso como lista ao vivo. Nao manda senha nem
  numeros de telefone. Por usar HTTP simples na rede local, o manifesto ganha `usesCleartextTraffic="true"`. Codigo em
  `StatusBeacon.kt`.
- Mexe no modulo `privileged/` (sai `ShizukuConnector`, entram `HelperConnector`, `AdbKeys`, `HelperBinderProvider`,
  `shell/HelperMain`, `shell/ProviderBridge`), em `GatewayRuntime` e telas do app, no manifesto e nos testes.
- Foi escrito para o commit `298d64b...` (v0.4.1), aplicado **depois** do `qr-scan.patch`.

### Modo online (relay)

O mesmo patch acrescenta uma terceira **SIP stack**, `online`, que troca o servidor SIP por **uma conexao WebSocket** com o
relay da Central (pasta `relay/` deste repositorio). Nao usa UDP nem porta aberta: funciona em 4G e em qualquer Wi-Fi.

- **`OnlineEndpoint.kt`** e um `CallEndpoint` como os outros: o resto do app (a ponte `CallBridge`, as regras de
  chamada de emergencia e de prefixos, o audio do celular) nao muda. Uma chamada da Central chega como chamada de
  entrada (a ponte disca no chip); uma chamada do chip vira chamada de saida (a Central toca). Uma chamada por vez.
- **Audio:** PCM 16 bits mono a 8 kHz em mensagens binarias de 20 ms, com buffer de jitter de 3 quadros e descarte
  quando o enlace fica lento (perder 20 ms em vez de atrasar). Mensagens de controle em JSON (protocolo em
  `relay/README.md`).
- **Reuso dos campos de configuracao:** servidor = endereco do relay, porta (443 em `tls`, que vira `wss`; 80 em `tcp`,
  que vira `ws`), usuario = nome da linha, senha = token do celular. O QR da Central ja preenche tudo.
- **Reconexao:** tentativas de 1, 2, 4, 8, 15 e 30 s; reconecta na hora quando a rede muda; para sem insistir se o relay
  recusa o token (`4001`) ou se outro celular assume a linha (`4002`).
- **Sem espera pelo Asterisk:** neste modo o app nao "desregistra" enquanto o celular nao esta pronto (nao ha PBX para
  fazer failover): fica conectado e conta os problemas no log.
- **Log:** o cartao **Log** da tela principal ganha o botao **Copy log** (versao do Android, configuracao sem senha e as
  ultimas 200 linhas). Conectado, o app tambem envia as linhas novas do log ao relay a cada 3 s, com o token trocado por
  `***`; a Central mostra tudo na aba **Registro**. O relato de progresso (`StatusBeacon`) passa a ir ao `/relato` do
  relay quando o QR e do modo online.
- Dependencia nova: **OkHttp 4.12.0** (Maven Central).
- Verificado assim: o `OnlineEndpoint` foi compilado e rodou num ambiente Java contra o relay de verdade, ligado a uma
  `CallBridge` real e a um "celular" simulado (13 verificacoes: chamada feita, recebida, recusada, ocupado, cancelada,
  DTMF, audio nos dois sentidos com tom de 300 e 440 Hz, troca de rede, linha tomada por outro, token errado). Isso foi
  feito com OkHttp 3.13, nao 4.12, e **o app inteiro nao foi compilado** (o Gradle/Android nao roda aqui): as telas e a
  ligacao no `GatewayRuntime` so serao compiladas pelo workflow.

**Limites:** nunca foi compilado nem testado em aparelho antes da primeira execucao do workflow, entao o primeiro
build pode falhar (o log diz onde). O pareamento por QR depende de o celular anunciar o servico de pareamento
com o nome do QR e de o app conseguir descobri-lo em segundo plano (nao testado em Samsung One UI). Se nao
parear, a caixa **First setup** tem a alternativa do codigo de 6 digitos, respondido numa notificacao (nao
precisa trocar de app).

## Licenca

O app e GPL-2.0 e os patches sao obras derivadas dele. A libadb-android e oferecida sob Apache-2.0 ou GPL-3.0+. Se voce passar o APK para outras pessoas, entregue junto
(ou ofereca) o codigo: o link do app na versao fixada e estes patches.
