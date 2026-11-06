# apk/ (alteracoes no app do celular)

O app Voice SIP Agent e de terceiros (https://github.com/sparkcyf/android-voice-sip-agent, GPL-2.0). Este
repositorio nao guarda uma copia dele: o workflow `.github/workflows/gerar-apk.yml` baixa o codigo na versao
fixada e, antes de compilar, aplica o patch desta pasta.

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

## Licenca

O app e GPL-2.0 e o patch e uma obra derivada dele. Se voce passar o APK para outras pessoas, entregue junto
(ou ofereca) o codigo: o link do app na versao fixada e este patch.
