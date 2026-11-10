# Central de chamadas

Um discador no navegador que liga e recebe chamadas usando o chip de um celular Android como linha telefônica. Há dois
modos, que dividem a mesma tela:

- **Online (o padrão):** a Central roda na **Vercel**, um servidor pequeno (o **relay**) roda no **Render**, e o celular
  conecta nele pela internet. Tudo em plano grátis, de qualquer rede, sem Asterisk nem Wi-Fi em comum.
- **Local:** a Central e um Asterisk rodam no seu PC e o celular fica no mesmo Wi-Fi. Veja o `PASSO-A-PASSO.md`.

```text
Online:  Navegador <--internet--> Relay (Render) <--internet--> Celular (app Voice SIP Agent) <--> chip
Local:   Navegador (JsSIP) <--> Asterisk (no PC) <--Wi-Fi--> Celular (app Voice SIP Agent) <--> chip
```

Arquitetura do projeto: veja o `AGENTS.md` (um servidor Express, frontend sem build, módulos isolados em `modulos/`).
Este projeto tem um módulo, `modulos/central/` (leia o README dele), e um serviço à parte, `relay/` (leia o README dele).

## Leia antes

- Uma chamada por vez, sem tom de chamada (o outro lado só é ouvido depois que atende).
- No modo online o áudio vai por WebSocket: conte com cerca de meio segundo de atraso e picotes em rede ruim. Use fone
  de ouvido na Central.
- O Render grátis dorme após 15 minutos sem tráfego e leva cerca de 1 minuto para acordar. Com o celular conectado ele
  não dorme.
- A Vercel grátis (Hobby) é para uso pessoal e não comercial.
- O celular precisa estar ligado, com internet e com o app. O pareamento com a Depuração sem fio é feito uma vez
  (precisa de Wi-Fi nesse momento); depois o app se reconecta sozinho. Não precisa de Shizuku.
- Cada chamada feita gasta minutos do plano do chip.
- O que **não** foi testado: o app dentro de um celular, o workflow do GitHub compilando o APK, o Render e a Vercel de
  verdade e a chamada até o chip. O que foi testado está listado no `MANUAL.md`.

## Começar

Sem nada instalado, só para ver a tela (modo demonstração, chamadas simuladas):

```bash
npm ci
MOCK=1 MODO=local npm start
```

Abra `http://localhost:3333/central/`.

Para o sistema de verdade (relay no Render, Central na Vercel, app no celular), siga o **`MANUAL.md`**, Parte 1 em diante.

## O que tem aqui

| Caminho | O que é |
|---|---|
| `MANUAL.md` | O manual: subir tudo, usar no celular e no site, logs, problemas, limites e como crescer |
| `PASSO-A-PASSO.md` | O guia do modo local, com Asterisk |
| `AGENTS.md` | O contrato de arquitetura |
| `relay/` | O servidor que liga o navegador ao celular (Render). README, testes e um "celular de mentira" |
| `render.yaml` | Cria o relay no Render com um clique (Blueprint) |
| `modulos/central/` | A Central: servidor, tela, modelos do Asterisk e instalador |
| `.github/workflows/gerar-apk.yml` | Compila o app do celular (Voice SIP Agent) no GitHub Actions |
| `apk/` | `qr-scan.patch` (botão **Scan QR code**) e `sem-shizuku.patch` (o app se pareia sozinho e ganha o modo **online (relay)**, o botão **Copy log** e o envio do log); o workflow aplica os dois antes de compilar |
| `src/`, `api/`, `public/`, `vercel.json` | O host (Express, página inicial, entrada da Vercel) |

## Créditos e licenças

- App do celular: [sparkcyf/android-voice-sip-agent](https://github.com/sparkcyf/android-voice-sip-agent) (GPL-2.0). O
  workflow compila o código dele e aplica `apk/qr-scan.patch` e `apk/sem-shizuku.patch` (obras derivadas, também
  GPL-2.0). O resto do app não é copiado para este repositório.
- JsSIP 3.13.9 (MIT) e qrcode-generator 2.0.4 (MIT), em `modulos/central/publico/vendor/`. No relay: `ws` (MIT). No app:
  OkHttp (Apache-2.0).
- Asterisk (modo local): instalado a partir da fonte oficial. libadb-android (cliente ADB dentro do app, Apache-2.0 ou
  GPL-3.0+), buscado pelo JitPack na hora de compilar.
