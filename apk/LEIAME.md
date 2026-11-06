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
- Mexe no modulo `privileged/` (sai `ShizukuConnector`, entram `HelperConnector`, `AdbKeys`, `HelperBinderProvider`,
  `shell/HelperMain`, `shell/ProviderBridge`), em `GatewayRuntime` e telas do app, no manifesto e nos testes.
- Foi escrito para o commit `298d64b...` (v0.4.1), aplicado **depois** do `qr-scan.patch`.

**Limites:** nunca foi compilado nem testado em aparelho antes da primeira execucao do workflow, entao o primeiro
build pode falhar (o log diz onde). O pareamento por QR depende de o celular anunciar o servico de pareamento
com o nome do QR e de o app conseguir descobri-lo em segundo plano (nao testado em Samsung One UI). Se nao
parear, a caixa **First setup** tem a alternativa do codigo de 6 digitos, respondido numa notificacao (nao
precisa trocar de app).

## Licenca

O app e GPL-2.0 e os patches sao obras derivadas dele. A libadb-android e oferecida sob Apache-2.0 ou GPL-3.0+. Se voce passar o APK para outras pessoas, entregue junto
(ou ofereca) o codigo: o link do app na versao fixada e estes patches.
