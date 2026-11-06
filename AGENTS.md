# AGENTS.md

## PURPOSE
Operational specification for projects using the Segundo Cérebro / 2brain architecture:
single Express host + embedded no-build frontend + plug-in modules + token-based design system.

READ THIS FILE BEFORE CHANGING CODE.
This describes the existing production architecture, not an idealized target.

---

## 1. INVARIANTS

1. MODULE_ISOLATION:
   `modulos/<name>/` contains all module server, frontend, CSS, env and docs.
   Module must remain independently movable/packable.

2. HOST_COUPLING:
   Module/server integration = `app.use("/<prefix>", router)`.
   Commenting/removing this line disables the module without changing the host.

3. FRONTEND:
   Embedded static HTML/CSS/JS.
   NO bundler, framework, TypeScript, JSX or build step.

4. DESIGN_SYSTEM:
   Module CSS uses `var(--token)` for colors.
   NO literal colors outside host token definitions.
   Exception: external API colors may be sanitized and applied inline.

5. CORE_ISOLATION:
   `servidor/nucleo.mjs` MUST NOT import the host.
   It owns module config, external API calls and normalization.

---

## 2. PROJECT STRUCTURE

```text
projeto/
├── api/
│   └── index.js                  # Vercel serverless entry; exports app
├── src/
│   ├── app.js                    # Express factory/export; NO listen
│   ├── server.js                 # Local entry; imports app + listen
│   ├── routes/                   # Host routes
│   └── db.js                     # Host data access
├── public/
│   ├── index.html
│   ├── estilos.css               # tokens + shared components; sole style source
│   └── app.js
├── modulos/
│   └── <name>/
│       ├── servidor/
│       │   ├── index.js          # Express router; host integration point
│       │   ├── rotas.mjs         # framework-independent routing
│       │   ├── nucleo.mjs        # config/API/normalization
│       │   └── ia.mjs            # optional LLM + local fallback
│       ├── publico/
│       │   ├── <name>.html
│       │   ├── <name>.css
│       │   ├── <name>.js
│       │   └── aba-<name>.js
│       ├── env.example
│       └── README.md
├── vercel.json
└── package.json
```

---

## 3. HOST CONTRACT

### `src/app.js`
- Create/configure Express.
- Load `dotenv/config`.
- Enable CORS and JSON body limit `1mb`.
- Health endpoint: `GET /health` => `{status:"ok"}`; MUST NOT touch DB.
- Serve `public/`.
- Mount modules with `app.use("/<prefix>", router)`.
- Error middleware logs error and returns HTTP 500 `{erro:"Erro interno inesperado."}`.
- Export app.
- MUST NOT call `listen`.

### `src/server.js`
Local entry:
`import app from "./app.js";`
`PORT = Number(process.env.PORT || 3333);`
`app.listen(PORT, "0.0.0.0", ...)`

### `api/index.js`
Vercel entry:
`import app from "../src/app.js";`
`export default app;`

### `vercel.json`
REQUIRED:
- rewrite `/(.*)` => `/api`
- `functions["api/index.js"].maxDuration = 60`
- `functions["api/index.js"].includeFiles = "modulos/**"`

`includeFiles` is mandatory or modules may work locally but disappear from Vercel packaging.

### `package.json`
- `"type": "module"`
- Node engine `>=20`
- npm only
- scripts:
  - `start`: `node src/server.js`
  - `dev`: `node --watch src/server.js`

If `yarn.lock` exists beside `package-lock.json`: STOP and warn before running package commands.

---

## 4. MODULE CONTRACT

### `servidor/index.js`
ONLY host-facing module router.

Must provide under mounted prefix:
- `GET /` => `publico/<name>.html`
- static `/<name>.css`, `/<name>.js`, etc.
- `/aba-<name>.js`
- `/api/*` => `rotas.mjs`

HTML shell response:
`Cache-Control: no-store`.

Static middleware:
`express.static(PUBLICO, {fallthrough:true, maxAge:0})`.

API middleware:
- ignore paths not starting `/api`
- construct URL from request
- `Cache-Control: no-store`
- return `await rotear(req,url)` as JSON
- catch errors:
  - `ErroHttp` => its status
  - otherwise => 500
  - log 5xx
  - response `{erro: err.message, dica: err.dica || ""}`

### `servidor/rotas.mjs`
Framework-independent.

Contract:
`rotear(req, url) -> Promise<object>`

Rules:
- Normalize path by removing trailing `/`; empty => `/`.
- Use `req.method`.
- `GET /api/health` MUST exist and come first.
- Protected reads call `exigirToken()`.
- Writes call `exigirToken()`, `guardaDeEscrita(req)` and `lerCorpo(req)`.
- Unknown route => `ErroHttp(404, ..., ...)`.
- 404 MUST list valid routes.
- Paths are relative to module mount:
  `/api/tasks` becomes `/<prefix>/api/tasks`.

### `servidor/nucleo.mjs`
Contains:
- `ErroHttp`
- config
- module env loading
- external API calls
- normalization
- cache

MUST NOT import the host.

#### `ErroHttp`
Fields:
- `status`
- `message`
- `dica`

Expected frontend error contract:
`{erro, dica}`.

#### Environment loading
Host loads root `.env` first.
Module may load `<module>/.env`.
Module env MUST NEVER overwrite an existing `process.env` value.
Parsing:
- ignore blank/comment lines
- split first `=`
- trim key/value
- remove matching surrounding `'` or `"` from value

Module root resolution:
prefer directory of `import.meta.url`; fallback to `process.cwd()` if resolution fails.

---

## 5. CACHE

External API listing calls MUST use cache.

Default cache:
- `Map`
- entry = `{em, valor}`
- valid when `Date.now() - em < cfg.cacheMs`
- cache hit returns `{...valor, cache:true}`
- miss executes producer, stores result, returns `{...valor, cache:false}`

Expensive operations may use independent larger TTL:
`comCacheTtl(chave, ttl, produzir)`.

Every relevant response MUST expose:
- `cache: true|false`
- `carregadoEm`

UI MUST show cache/data freshness in the top summary.

Reopening a modal MUST NOT repeat an expensive full scan if its TTL is valid.

---

## 6. WRITE SECURITY

All writes MUST pass `guardaDeEscrita(req)`.

`READ_ONLY=1` => all UI writes disabled; write guard returns HTTP 403.
`READ_ONLY=0` => writes allowed subject to origin guard.

Origin rules:
- `Origin` absent => allow (non-browser/app call).
- localhost / 127.0.0.1 => allow.
- same `Origin` host as request `Host` => allow.
- otherwise => HTTP 403.

Purpose: prevent another page from using the user's token without consent.

Required module env variables:
- `READ_ONLY=1` => disable all UI writes
- `MOCK=1` => example data; no token required
- `CACHE_TTL_MS` => listing cache window

---

## 7. OPTIONAL LLM

LLM MUST NEVER be a single point of failure.

Every LLM feature requires:
1. LLM path.
2. Local heuristic fallback.
3. Response source metadata.

Example contract:
- LLM: `{fonte:"groq", modelo, ordem}`
- fallback: `{fonte:"local", modelo:"", ordem:heuristica(itens)}`

Frontend MUST show source:
- LLM => provider + model
- fallback => local/no AI

---

## 8. FRONTEND RULES

### Hard constraints
- NO build.
- NO bundler.
- NO framework.
- NO TypeScript.
- NO JSX.
- NO ES module scripts.
- Classic `<script src="...">`.
- Screen JS uses `var` and `function`, not `const`/arrow functions.
- Modern browser APIs allowed: `Map`, `Set`, `Promise`, `fetch`.
- `node --check arquivo.js` MUST pass.

### HTML shell
Required order:
1. `<!doctype html>`
2. `<html lang="pt-BR" data-tema="sistema">`
3. charset + viewport
4. light/dark `theme-color`
5. host `/estilos.css`
6. module CSS
7. title
8. anti-flash theme script
9. body
10. module JS

Anti-flash:
`data-tema = localStorage.getItem("2brain-tema") || "sistema"` before CSS paint.

Required screen structure:
- `.barra#barra`
- `.envolucro`
- `.titulao`
- `.subtitulao#resumoTopo`
- `.busca#caixaBusca`
- `.segmentado#abasGrupo`
- `#filtros`
- `#conteudo`
- `.cortina#cortina`
- `.sheet#sheet` with `.puxador`, `.sheet-cab`, `#sheetTitulo`, `#btnFechaSheet`, `.sheet-corpo#sheetCorpo`
- `.toast#toast`
- module `<script>`

---

## 9. FRONTEND JS GRAMMAR

Required conceptual order:
1. vocabulary/constants
2. network `api()`
3. utilities
4. filters
5. list/render
6. selection
7. detail sheet
8. loading
9. events

Architecture:
- ONE state object.
- ONE main render.
- ONE document-level event delegation handler.
- Sheet for details.
- Toast for transient messages.
- Module must not touch host app internals.

State baseline:
```js
var S = {
  itens: [],
  usuario: null,
  filtro: "",
  busca: "",
  agrupar: "prazo",
  selecionadas: new Set(),
  visiveis: [],
  carregando: true,
  carregadoEm: 0,
  doCache: false,
  erro: null
};
```

DOM helper:
`$(s) => document.querySelector(s)`

### Network wrapper
`api(caminho, opcoes)` MUST:
- default options to `{}`
- send JSON content type
- preserve supplied headers
- use `fetch(BASE + caminho, ...)`
- parse JSON; malformed response => `{erro:"Resposta ilegível do servidor"}`
- non-2xx => throw Error with `dica`
- return parsed data on success

### Event delegation
Use ONE `document.addEventListener("click", ...)`.
Use `closest("[data-*]")` to dispatch filters, selections and actions.
Do not rebind handlers after `innerHTML`.

### Sheet
`abrirSheet(titulo, html)`:
- set title
- set body HTML
- add `aberto` to `.sheet`
- add `aberta` to `.cortina`

### Toast
- one timer
- set text
- add `.visivel`
- clear previous timer
- hide after `2600ms`

### Copy
`copiar(texto,aviso)`:
1. Prefer `navigator.clipboard.writeText`.
2. On unavailable/rejected API, fallback to hidden textarea + `document.execCommand("copy")`.
3. Toast success/failure.

Reason: clipboard API may not exist outside secure contexts, e.g. mobile access by machine IP.

### View state
Every screen must handle:
1. loading => skeleton
2. error => `.tr-aviso` + message + dica
3. empty => `.vazio` + emoji + h3 + p
4. content

Animation:
- derive view key from `[S.agrupar,S.busca,S.filtro].join("|")`
- animate only when key changes
- do not reanimate unchanged views during filtering.

---

## 10. RENDER SECURITY

ABSOLUTE RULE:
Every string inserted through `innerHTML` MUST pass `esc()`.

Applies to:
- item names
- list names
- tags
- statuses
- API/error messages
- all other external/user/API strings

If `innerHTML` lacks nearby `esc()`, implementation is invalid.

`esc()` must escape:
`& < > " '`.

URLs:
- open with `target="_blank"`
- MUST use `rel="noopener"`.

External API colors:
- only sanitized 6-digit hex values.
- invalid values use safe fallback.
- may be placed inline as the sole CSS-color exception.

---

## 11. HOST TAB INTEGRATION

`publico/aba-<name>.js` injects the module link/tab into the host menu.

This is the second and final host coupling point.

Host `index.html` MUST load:
```html
<script src="/<prefix>/aba-<name>.js"></script>
```
after `/app.js`.

---

## 12. DESIGN SYSTEM

All shared tokens live in:
`public/estilos.css`

Theme modes:
- `claro`
- `escuro`
- `sistema`

Theme stored in:
`localStorage["2brain-tema"]`

Token system uses iOS-style system colors with indigo accent.
Required token categories:
- background
- surfaces
- elevated surface
- primary/secondary/tertiary text
- separator
- accent
- accent background
- danger
- success
- warning
- shadow
- card/large/pill radii
- touch target
- system font stack

Dark theme MUST redefine the same semantic tokens.
System theme follows `prefers-color-scheme: dark`.

### CSS absolute rule
Module CSS:
- MUST use tokens for colors.
- MUST NOT contain literal `#`, `rgb(` or named colors.
- exception: sanitized external API color inline style.

### Base UI
- border-box globally
- transparent tap highlight
- body uses `var(--fonte)`, `var(--fundo)`, `var(--texto)`
- body font size `17px`
- line-height `1.45`
- safe-area bottom padding
- background/text transition `.25s`
- buttons: pointer cursor, no border/background, touch-action manipulation
- content max width `720px`
- horizontal padding `16px`
- bottom padding `72px`
- target touch size `44px`

Concept:
mobile-first app that also looks good on desktop.

### Existing component inventory
USE these; do not invent equivalents:

- `.barra`, `.barra-int`, `.barra-titulo`, `.barra-acoes`
- `.icone-btn`
- `.titulao`, `.subtitulao`
- `.busca`, `input`, `.limpar`
- `.segmentado`, `.indicador`
- `.faixa-chips`, `.chips`, `.chip`, `.chip.ativo`
- `.chip .n`, `.chip .ponto`
- `.btn`, `.btn-suave`, `.btn-largo`
- `.lista`, `.nota`, `.lista.animar`
- `.selo-tipo`, `.selo-prazo`
- `.tag`
- `.cab-secao`
- `.mini-seg`
- `.vazio`, `.emoji`, `h3`, `p`
- `.esqueleto`, `.linha`
- `.cortina`, `.sheet`, `.puxador`, `.sheet-cab`, `.sheet-corpo`
- `.toast`
- `.cartao-insight`, `.pensando`, `.pontinhos`
- `.insight-fonte`
- `.detalhe-rot`, `.detalhe-txt`

### Module CSS
Module CSS only extends the host design system.
New classes MUST use a short module prefix, e.g. `.tr-`.

Structure long CSS with sections:
```text
Filtros
Lista
Sheet
```

Extending shared components is allowed and expected.

---

## 13. CODE CONVENTIONS

- Identifiers: Portuguese, NO accents.
- Comments explain WHY, not WHAT.
- Counterintuitive decisions MUST have an inline comment explaining why.
- Every file should have a `/** */` header describing its role and what it does NOT do.
- Long files use section dividers.
- NO em dash in comments, UI text or documentation.

---

## 14. NEW MODULE CHECKLIST

Create:
```text
modulos/<name>/
├── servidor/
│   ├── index.js
│   ├── rotas.mjs
│   └── nucleo.mjs
├── publico/
│   ├── <name>.html
│   ├── <name>.css
│   ├── <name>.js
│   └── aba-<name>.js
├── env.example
└── README.md
```

Steps:
1. Create module directories.
2. Implement `nucleo.mjs`: `ErroHttp`, config, env loading, external API, normalization.
3. Implement `rotas.mjs`: health first, auth, cache, body parser, write guard, 404 with valid routes.
4. Implement `index.js` from module router contract.
5. Implement HTML shell.
6. Implement module CSS: prefixed, specific-only, token colors.
7. Implement JS: state/render/delegation/sheet/toast.
8. Implement host tab injector.
9. Document `READ_ONLY`, `MOCK`, `CACHE_TTL_MS`.
10. README MUST document:
    - two host coupling points
    - project/module tree
    - routes
11. Host changes:
    - module import
    - `app.use("/<prefix>", router)`
    - tab script in `index.html`
12. Confirm Vercel `includeFiles: "modulos/**"`.

---

## 15. MINIMUM VERIFICATION

For module `<name>`:
```bash
node --check modulos/<name>/publico/<name>.js
node --check modulos/<name>/servidor/rotas.mjs
curl -s localhost:3333/<prefix>/api/health | python3 -m json.tool
```

Expected:
- syntax commands exit 0
- health returns valid JSON with `ok:true`

Prefer the narrowest verification that proves the changed behavior.

---

## 16. FORBIDDEN

NEVER:
- introduce bundler
- introduce frontend framework
- introduce TypeScript/JSX
- add build step
- import host from module core
- write literal module CSS colors
- use `innerHTML` without `esc()`
- call external API without cache
- allow writes without `guardaDeEscrita`
- ignore `READ_ONLY`
- make LLM mandatory without local fallback
- move module files outside its module directory
- use yarn
- store durable application data in localStorage

`localStorage` is allowed for UI preference such as theme only.

---

## 17. CHANGE DELIVERY PROTOCOL

Before proposing/implementing:
1. STUDY: open relevant files; follow imports; understand end-to-end data flow.
2. ASSESS: state what is reusable, what must be created, risks by file/line, and non-obvious traps.
3. DECIDE: owner-dependent decisions become objective questions with options + recommendation.
4. PLAN: numbered blocks; state count and contents before code.
5. EXECUTE: one block at a time; STOP for confirmation.
6. FORMAT:
   - terminal-ready commands
   - new/rewrite file: `cat > path << 'EOF'`
   - small change in large file: `python3` patch script with `assert`
   - explicitly warn if command is non-idempotent
7. VERIFY: narrowest command proving the change; state expected result.
8. PREFER ADDITIVE CHANGES:
   - new field beside old
   - new route instead of breaking existing contract
   - state behavior changes and non-changes per block
9. ERROR HANDLING:
   - identify block
   - state what was wrong
   - explain why
   - provide correction
   - no excuses
10. HONESTY > PLEASING:
   expose costs/risks before implementation, even under time pressure.