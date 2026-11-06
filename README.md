# Central de chamadas (v1)

Um discador no navegador que liga e recebe chamadas usando o chip de um celular Android como linha
telefônica. O navegador fala com um Asterisk (no seu PC) e o Asterisk fala com o celular, que faz a ligação
pelo chip.

```text
Navegador (JsSIP) <-> Asterisk (no PC) <-> Wi-Fi <-> Celular (app Voice SIP Agent) <-> chip
```

Arquitetura do projeto: veja o `AGENTS.md` (um servidor Express, frontend sem build, módulos isolados em
`modulos/`). Este projeto tem um módulo: `modulos/central/` (leia o README dele).

## Leia antes

- Uma chamada por vez, sem tom de chamada (o outro lado só é ouvido depois que atende).
- O celular precisa estar ligado, na mesma rede Wi-Fi do PC e com a Depuração sem fio ligada. O app faz o
  pareamento uma vez só e depois se reconecta sozinho (inclusive depois de reiniciar o celular). Não precisa
  de Shizuku nem de outro app.
- Cada chamada feita gasta minutos do plano do chip.
- Esta v1 roda só no seu PC, abrindo `http://localhost:3333/central/`. Não faça deploy na Vercel.
- Não tem login. As senhas do ramal saem só para o próprio PC.

## Começar (2 minutos, sem Asterisk nem celular)

```bash
npm ci
MOCK=1 npm start
```

Abra `http://localhost:3333/central/`. No modo `MOCK=1` as chamadas são simuladas e nada sai pelo chip.

## Colocar para funcionar de verdade

Siga o **`PASSO-A-PASSO.md`** (7 etapas: demonstração, GitHub, APK, Asterisk, teste de eco, celular, primeira
ligação).

## O que tem aqui

| Caminho | O que é |
|---|---|
| `AGENTS.md` | O contrato de arquitetura |
| `PASSO-A-PASSO.md` | O guia completo da v1 |
| `modulos/central/` | O módulo (servidor, tela, modelos do Asterisk, instalador) |
| `.github/workflows/gerar-apk.yml` | Compila o app do celular (Voice SIP Agent) no GitHub Actions |
| `apk/` | `qr-scan.patch` (botão **Scan QR code**) e `sem-shizuku.patch` (o app se pareia e se conecta sozinho, sem Shizuku); o workflow aplica os dois antes de compilar |
| `src/`, `api/`, `public/`, `vercel.json` | O host (Express, página inicial) |

## Créditos e licenças

- App do celular: [sparkcyf/android-voice-sip-agent](https://github.com/sparkcyf/android-voice-sip-agent)
  (GPL-2.0). O workflow compila o código dele e aplica `apk/qr-scan.patch` e `apk/sem-shizuku.patch` (obras derivadas,
  também GPL-2.0). O resto do app não é copiado para este repositório.
- JsSIP 3.13.9 (MIT) e qrcode-generator 2.0.4 (MIT), em `modulos/central/publico/vendor/`.
- Asterisk: instalado a partir da fonte oficial. libadb-android (cliente ADB dentro do app, Apache-2.0 ou GPL-3.0+),
  buscado pelo JitPack na hora de compilar.
