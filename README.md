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
- O celular precisa estar ligado, na mesma rede Wi-Fi do PC, com o Shizuku rodando (depois de reiniciar o
  celular, o Shizuku precisa ser iniciado de novo à mão).
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
| `src/`, `api/`, `public/`, `vercel.json` | O host (Express, página inicial) |

## Créditos e licenças

- App do celular: [sparkcyf/android-voice-sip-agent](https://github.com/sparkcyf/android-voice-sip-agent)
  (GPL-2.0). O workflow só compila o código dele; nada dele é copiado para este repositório.
- JsSIP 3.13.9 (MIT), em `modulos/central/publico/vendor/`.
- Asterisk, Shizuku: instalados a partir das fontes oficiais deles.
