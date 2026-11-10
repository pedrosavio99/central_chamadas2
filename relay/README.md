# relay (o servidor da Central online)

Um servidor Node pequeno (`ws`, sem banco) que liga o **navegador** ao **celular gateway** pela internet. Ele só repassa
mensagens de controle (JSON) e áudio (PCM bruto) de um lado para o outro. Não grava áudio nem números.

```
Navegador (operador) <-- WSS --> relay <-- WSS --> App do celular (celular)
```

Feito para rodar de graça no **Render** (arquivo `render.yaml` na raiz do projeto). Funciona em qualquer lugar que rode
Node 20 ou mais novo.

## Rodar no seu PC

```bash
cd relay
npm install
ACCESS_CODE=um-codigo-bem-longo npm start        # escuta em http://localhost:8080 (PORT muda a porta)
npm test                                         # 22 verificações de ponta a ponta, sem rede
node teste/fone-falso.mjs --url http://127.0.0.1:8080 --codigo um-codigo-bem-longo   # um "celular" de mentira
```

## Variáveis de ambiente

| Nome | Padrão | Para quê |
|---|---|---|
| `ACCESS_CODE` | (obrigatória) | Código de entrada do operador. Dele nasce o token de cada celular. Sem ele o serviço não aceita ninguém |
| `PORT` | `8080` | O Render define sozinho |
| `ORIGINS` | vazio | Endereços de site aceitos no WebSocket (separados por vírgula, sem barra no fim). Vazio = qualquer site que saiba o código |
| `MAX_SALAS` | `50` | Quantas linhas ao mesmo tempo |

## Salas (linhas)

Uma **sala** é uma linha: um celular e um operador. O nome só aceita `a-z`, `0-9`, `-` e `_` (até 32). A tela usa `principal`.
Um segundo celular (ou operador) na mesma sala **substitui** o primeiro, que recebe o código de fechamento `4002`.

Autenticação:
- **Operador:** o próprio `ACCESS_CODE` (comparação em tempo constante).
- **Celular:** `token = HMAC-SHA256(ACCESS_CODE, "celular|" + sala)`, primeiros 32 caracteres em hexadecimal. A Central o
  entrega ao operador (`welcome.tokenCelular`) e o põe no QR. Um token só vale para a sala dele.
- Freio: 10 autenticações erradas em 10 minutos bloqueiam o IP por 10 minutos.

## HTTP

| Rota | Para quê |
|---|---|
| `GET /health` | `{ok, servico:"central-relay", versao, configurado, salas, ...}`. Sem segredo. Acorda o serviço no Render |
| `POST /relato` | O app relata o passo a passo da configuração. Cabeçalhos `X-Sala` e `Authorization: Bearer <token do celular>`. Corpo JSON até 16 KB. O relay repassa ao operador como `relato` |
| `GET /relato?sala=` | O último relato (cabeçalho `X-Codigo` ou `?codigo=`) |
| `GET /log?sala=` | O registro da sala em texto (mesmo código). Não tem segredos nem números inteiros |

CORS liberado (`*`): quem protege é o código, não a origem.

## WebSocket `/ws`

A **primeira mensagem** (JSON, em até 5 s) tem que ser:

```json
{"t":"hello","papel":"operador","sala":"principal","codigo":"..."}
{"t":"hello","papel":"celular","sala":"principal","token":"...","rate":8000,"app":"voice-sip-agent"}
```

Resposta: `welcome` com `telefone`, `operador`, `rate`, `app`, `chamada`, `versao`, `logs` e, para o operador, `tokenCelular`
e `relato`. Depois, o relay manda `presenca` a cada mudança.

Mensagens de controle (JSON, texto):

| Sentido | Mensagem |
|---|---|
| operador para celular | `dial {numero}`, `answer`, `hangup` (ou `reject`), `dtmf {tecla}` |
| celular para operador | `incoming {numero}`, `ringing`, `connected`, `ended {causa, por}` |
| os dois | `log {linhas[]}`, `ping {n, em}` e `pong {n, em, agora}`, `erro {codigo, msg}` |

Causas de `ended`: `normal`, `ocupado`, `sem_resposta`, `recusada`, `indisponivel`, `numero_invalido`, `proibido`, `cancelada`,
`erro_rede`, `falha`, `celular_offline`, `celular_caiu`, `sem_resposta_do_celular` (a tela traduz cada uma).

**Áudio:** mensagens **binárias**, PCM 16 bits little-endian, mono, a 8 kHz (320 bytes por quadro de 20 ms) ou 16 kHz
(640 bytes). O relay repassa de um lado ao outro **só durante uma chamada**. Se o destino acumular mais de 96 KB, o relay
descarta quadros (perder 20 ms é melhor que atrasar a conversa).

Códigos de fechamento: `4001` credencial errada, `4002` substituído por outro, `4003` formato ou serviço sem `ACCESS_CODE`,
`4004` IP bloqueado, `4005` servidor cheio.

Regras da chamada:
- Se o celular cair no meio, o relay encerra a chamada para o operador (`celular_caiu`). Se o operador sair, avisa o celular.
- `incoming` com **nenhum operador conectado** é recusado na hora: o relay manda `hangup` ao celular e não deixa chamada pendurada.
- Pedido de `hangup` sem confirmação do celular em 4 s: o relay encerra por conta própria (`sem_resposta_do_celular`).
- Mensagem inválida antes do `hello`, ou sem `hello` em 5 s, fecha a conexão sem derrubar o servidor.

## Como crescer

Tudo que guarda estado mora em `src/hub.js` (a classe `Sala`). Uma sala é uma linha, então várias empresas ou celulares
são só nomes de sala diferentes. Para **várias instâncias** do relay, `hub.js` é o único arquivo a trocar (estado das salas
e repasse de mensagens por Redis publicar/assinar). Para **menos atraso**, o caminho de áudio pode virar WebRTC ou UDP
mantendo estas mesmas mensagens de controle. `src/auth.js` concentra a autenticação (hoje um código único): é onde entram
usuários e senhas.

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/servidor.js` | HTTP, WebSocket e as regras da chamada |
| `src/hub.js` | As salas e o estado |
| `src/auth.js` | Código, token do celular e o freio de tentativas |
| `src/log.js` | O registro (anel de 400 linhas por sala) |
| `teste/e2e.mjs` | Teste de ponta a ponta (`npm test`) |
| `teste/fone-falso.mjs` | Celular de mentira para testar o site sem o app |
