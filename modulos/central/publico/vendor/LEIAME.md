# vendor/ (bibliotecas de terceiros)

## jssip.min.js

- Biblioteca: [JsSIP](https://jssip.net) 3.13.9, licença MIT (texto em `JSSIP-LICENSE.md`).
- Papel: faz o navegador falar SIP com o Asterisk por WebSocket e cuida do áudio WebRTC.
- Fica aqui, dentro do módulo, porque o `AGENTS.md` proíbe etapa de build no projeto: a tela carrega o arquivo
  direto com `<script src="vendor/jssip.min.js">` e usa o global `JsSIP`.

### De onde veio

O pacote npm `jssip` não traz um arquivo pronto para navegador (a pasta `dist/` não vem no pacote) e os
downloads oficiais prontos não estavam acessíveis ao montar este projeto. Então o arquivo foi gerado a partir do
pacote npm com o esbuild, uma vez, fora do projeto. Nada disso roda quando você usa a Central.

Para refazer (opcional, só se quiser conferir ou trocar de versão):

```bash
mkdir -p /tmp/jssip-build && cd /tmp/jssip-build
npm init -y > /dev/null
npm install --save-exact jssip@3.13.9 esbuild@0.28.2
npx esbuild node_modules/jssip/lib/JsSIP.js --bundle --minify --format=iife \
  --global-name=JsSIP --platform=browser --target=es2019 \
  --banner:js='/* JsSIP 3.13.9 | MIT | https://jssip.net | bundle do pacote npm "jssip" gerado com esbuild (ver vendor/LEIAME.md) */' \
  --outfile=jssip.min.js
sha256sum jssip.min.js
```

O arquivo que está aqui tem SHA-256
`1cf33e25726cba0227a54fecaaf3b438795b313c68d0dddb535af410f98ffa4e`.
Ao refazer, o hash pode mudar se as dependências internas do JsSIP tiverem outras versões de correção. O que
importa é `JsSIP.version` valer `"3.13.9"` no console do navegador.

### Detalhes do JsSIP que a tela já trata

- `session_timers: false`: o celular gateway só precisa tratar INVITE e BYE.
- DTMF com `transportType: "RFC2833"`, porque o Asterisk está com `dtmf_mode=rfc4733` (o padrão do JsSIP é SIP
  INFO, que o Asterisk ignora neste cenário).
- `unmute({audio: true})`: o padrão do JsSIP religa o vídeo também.
- Sem servidor STUN (`iceServers: []`): na v1 tudo é local.
