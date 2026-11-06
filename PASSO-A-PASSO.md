# Passo a passo da v1

Este guia leva você do zero até a primeira ligação real pelo navegador, em 7 etapas curtas. Cada etapa diz o
comando, o que deve aparecer e o que fazer se não aparecer. **Só siga para a próxima etapa quando a atual deu
certo.** Se travar, pare e me mande o que a etapa pede (está no fim de cada uma).

## 0. Leia antes (limites, custos e o que NÃO foi testado)

**Limites do produto (v1):**

- Uma chamada por vez. O celular tem uma linha só; a segunda chamada que chega leva "ocupado".
- Sem tom de "chamando". O app do celular não repassa esse som. A tela mostra "Chamando..." e o áudio só
  começa quando o outro lado atende.
- O celular precisa estar ligado, na mesma rede Wi-Fi do PC e com a **Depuração sem fio** ligada. O app se
  pareia uma vez e depois se reconecta sozinho, também depois de reiniciar o celular (precisa de Wi-Fi).
- Enquanto "Take over calls" estiver ligado no app, as ligações recebidas no chip tocam no navegador, **não no
  celular**.
- Cada chamada feita gasta minutos do plano do chip. Teste primeiro com o seu próprio número.
- Funciona só no seu PC, por `http://localhost:3333/central/` (o navegador só libera o microfone em
  `localhost` ou HTTPS). Não faça deploy na Vercel.
- Não tem login, e o histórico (números de telefone) fica só na memória do servidor.

**O que eu testei e o que não testei (honestamente):**

| Parte | Situação |
|---|---|
| API do servidor (31 verificações, com Asterisk falso) | testada |
| Tela em modo demonstração e em modo real com o JsSIP de verdade (registro, chamada recebida, ocupado, recusa, desistência, queda) contra um "Asterisk de mentira" | testada (56 e 43 verificações) |
| Instalador (`instalar.sh`) gerando senhas e arquivos | testado só no modo `--so-gerar`, sem Asterisk de verdade |
| Os arquivos `.conf` aceitos por um Asterisk de verdade | **não testado** |
| Workflow do GitHub que gera o APK | **não testado** (não consigo rodar o GitHub daqui) |
| Atender e ouvir áudio, DTMF, ligação de saída até o chip, o app no celular | **não testado** |

Ou seja: as etapas 3 a 7 são onde algo pode precisar de ajuste. Por isso cada uma termina com "o que me
mandar se falhar".

**O que você precisa ter:**

- PC com Pop!_OS (ou Ubuntu), com `node -v` mostrando v20 ou mais novo, e `git`.
- Conta no GitHub (o APK é compilado lá).
- Celular Android 11 ou mais novo, **arm64** (a grande maioria dos celulares atuais), com chip, na mesma
  rede Wi-Fi do PC. Dica: o roteador não pode ter "isolamento de clientes" (AP isolation) ligado.
- Um segundo telefone para testar as ligações.

**Vocabulário rápido:**

| Termo | O que é aqui |
|---|---|
| Asterisk | O programa que faz o papel de central telefônica, no seu PC |
| Ramal | Um "telefone" cadastrado na central. Temos dois: `atendente` (o navegador) e `android-gw` (o celular) |
| Gateway | O celular fazendo a ponte entre a central e a rede do chip |
| SIP | O protocolo que os dois lados usam para combinar a chamada |
| WebRTC / JsSIP | O jeito de o navegador mandar e receber voz; JsSIP é a biblioteca que fala SIP no navegador |
| Depuração sem fio | Opção do Android (Opções do desenvolvedor) pela qual o próprio app pega o poder de controlar as ligações sem root |
| ARI | A porta de leitura do Asterisk que o servidor usa para perguntar "o celular está online?" |
| Dialplan | A regra que diz o que acontece quando alguém disca um número |

---

## Etapa 1. Rodar a tela em modo demonstração

Objetivo: confirmar que o projeto roda no seu PC, sem Asterisk e sem celular.

```bash
unzip central-chamadas-v1.zip
cd central-chamadas
node -v        # precisa ser v20 ou mais novo
npm ci
MOCK=1 npm start
```

Esperado no terminal:

```text
Host no ar: http://localhost:3333
Central de chamadas: http://localhost:3333/central/
```

Em **outro terminal**:

```bash
curl -s localhost:3333/central/api/health | python3 -m json.tool
```

Esperado:

```json
{
    "ok": true,
    "modulo": "central",
    "versao": "1.0.0",
    "mock": true,
    "somenteLeitura": false
}
```

Abra `http://localhost:3333/central/`. Você deve ver: um aviso "Modo MOCK", um teclado, e "Últimas chamadas" com
3 chamadas de exemplo. Digite `83999998888`, clique em **Ligar** (a chamada é simulada, atende sozinha) e em
**Desligar**. Clique em **Simular chamada recebida** para ver o toque.

Pare o servidor com `Ctrl+C`.

Se falhar: me mande a saída de `node -v` e do `npm ci`.

---

## Etapa 2. Subir o projeto para o GitHub

Objetivo: ter o código num repositório seu, porque é lá que o APK será compilado.

1. No site do GitHub, crie um repositório **vazio** (sem README), por exemplo `central-chamadas`. Pode ser privado.
2. No terminal, dentro da pasta do projeto, primeiro **prepare e confira**:

```bash
git init -b main
git add .
git ls-files | grep -E '(^|/)\.env$|node_modules|/gerado/' || echo "ok: nenhum segredo na lista"
```

Esperado: a linha `ok: nenhum segredo na lista` (o `.gitignore` já protege `.env`, `node_modules` e a pasta
`gerado/`). **Se aparecer qualquer nome de arquivo no lugar dela, pare** e me avise: algo que não devia subir
está na lista.

3. Só depois de ver o "ok", faça o commit e envie (troque `SEU_USUARIO`; se você usa HTTPS em vez de SSH, a URL é
   `https://github.com/SEU_USUARIO/central-chamadas.git`):

```bash
git commit -m "Central de chamadas v1"
git remote add origin git@github.com:SEU_USUARIO/central-chamadas.git
git push -u origin main
```

Esperado: o push termina sem erro e, na página do repositório, existe a pasta `.github/workflows`. O `git init`
é seguro; já o `git remote add` falha se você repetir o comando (o remoto já existe).

Se falhar: me mande a saída do `git push`.

---

## Etapa 3. Gerar o APK do celular (GitHub Actions)

Objetivo: obter o arquivo `.apk` do app **Voice SIP Agent**. O repositório do app não publica APK pronto, então
o workflow `.github/workflows/gerar-apk.yml` baixa o código dele (fixado pelo commit da versão 0.4.1) e compila.
Antes de compilar, ele aplica dois patches (deste repositório): `apk/qr-scan.patch`, que acrescenta ao app o botão
**Scan QR code** (é por ele que a Central configura o celular sem digitar nada, Etapa 6.4), e
`apk/sem-shizuku.patch`, que faz o próprio app se parear com a Depuração sem fio do celular e iniciar o helper
de ligações sozinho (Etapa 6.2). Assim você não instala nem configura o Shizuku.

1. No GitHub, abra o seu repositório, aba **Actions**.
2. Na lista da esquerda, clique em **Gerar APK do celular gateway**.
3. Clique em **Run workflow**, deixe o campo "versao" como está e confirme.
4. Espere de **15 a 40 minutos** (ele compila OpenSSL, Opus e PJSIP para Android do zero). Pode fechar a página.
5. Quando o círculo ficar verde, abra a execução e, no fim da página, em **Artifacts**, baixe
   `voice-sip-agent-apk`.

No PC:

```bash
cd ~/Downloads
unzip voice-sip-agent-apk.zip -d apk-gw
cd apk-gw
sha256sum -c *.sha256
```

Esperado (o trecho do meio é o início do hash do commit):

```text
voice-sip-agent-298d64b89b-gw-debug.apk: OK
```

O hash completo também aparece no resumo da execução no GitHub.

Duas observações: é uma build **debug** (assinada com a chave de depuração; serve para uso próprio) e o app
é GPL-2.0, então não distribua o APK sem seguir a licença.

Se o círculo ficar vermelho: clique no passo que ficou vermelho, copie as últimas 40 linhas do log e me mande.
Os suspeitos mais prováveis são a instalação do NDK, o download de alguma fonte (OpenSSL, Opus, PJSIP) e o
download da plataforma Android pelo Gradle.

---

## Etapa 4. Instalar e configurar o Asterisk (no PC)

Objetivo: transformar o PC na central telefônica. O script instala o Asterisk, gera senhas aleatórias, grava
os arquivos de configuração e confere se tudo subiu.

**Aviso:** o script **substitui** estes arquivos de `/etc/asterisk`: `pjsip.conf`, `extensions.conf`,
`http.conf`, `ari.conf`, `rtp.conf` e `modules.conf`. Os antigos vão para uma pasta de backup que o script
mostra. Use num PC de desenvolvimento.

Se quiser **estudar antes de instalar**, gere só os arquivos, sem tocar no sistema:

```bash
bash modulos/central/asterisk/instalar.sh --so-gerar
ls modulos/central/asterisk/gerado/
```

Abra os `.conf` gerados e leia os comentários (explicam cada decisão). Depois instale de verdade:

```bash
bash modulos/central/asterisk/instalar.sh
```

O script mostra o que vai fazer e pergunta `Continuar? [s/N]`. Responda `s` e digite a senha do sudo.

Esperado no fim (os números de versão e IP variam):

```text
== Conferindo
  [ok] endpoint atendente carregado
  [ok] endpoint android-gw carregado
  [ok] SIP escutando em UDP 5060
  [ok] WebSocket/ARI escutando só em 127.0.0.1:8088
  [ok] ARI respondeu (o servidor da Central vai enxergar o celular)

== Pronto. Agora configure o app no celular (Voice SIP Agent)

  Servidor (PBX host) : 192.168.0.10
  Porta               : 5060
  ...
  Senha               : (32 caracteres)
```

**Anote esse bloco**: ele traz o que você vai digitar no celular na Etapa 6. A senha também fica em
`modulos/central/.env` (chave `GW_SENHA`).

Se aparecer `[atencao] O firewall ufw está ATIVO`, rode os dois comandos `ufw allow` que o script mostra.

Conferência extra:

```bash
sudo asterisk -rx "pjsip show endpoints" | grep -E "atendente|android-gw"
```

Esperado: duas linhas, uma com `atendente` e outra com `android-gw`. O `android-gw` aparece como `Unavailable`
porque o celular ainda não se conectou. Isso é normal agora.

Agora suba o servidor da Central **sem** `MOCK` e abra a tela:

```bash
npm start
```

Abra `http://localhost:3333/central/`. Na lista "verificações antes de ligar" deve aparecer:

- Navegador: pronto (bolinha verde);
- Ramal no Asterisk: "Ramal atendente registrado" (verde);
- Celular gateway: "Offline..." (vermelho, é esperado: o celular ainda não está configurado).

Se o ramal não registrou: veja a mensagem que a própria tela mostra (ela diz se foi senha recusada ou
Asterisk fora do ar).

Se falhar: me mande a saída completa do `instalar.sh` (ele já mostra a causa) e de
`sudo grep -iE 'error|warning' /var/log/asterisk/messages | tail -n 30`.

Para desfazer: o script imprime no fim o comando `sudo cp -a ...backup-central-.../. /etc/asterisk/` que
restaura os arquivos antigos.

---

## Etapa 5. Teste de eco (navegador e Asterisk, sem o celular)

Objetivo: provar que a voz vai e volta entre o navegador e o Asterisk. É o teste que separa "problema no
navegador/Asterisk" de "problema no celular". **Use fones de ouvido** (senão dá microfonia).

1. Com o servidor rodando, na tela digite `600`.
2. Clique em **Ligar** (o botão fica habilitado mesmo com o celular offline, só para este número).
3. Antes de ligar, no cartão **Áudio** clique em **Testar microfone** e em **Permitir**. Fale: a barra verde
   precisa mexer. Se não mexer, escolha outro microfone na lista. **Gravar 3 s e ouvir** confere também o som que sai.
4. Ligue e fale. O 600 não diz nada sozinho: ele só devolve a sua voz, com um pequeno atraso, depois de 1 segundo
   de silêncio. Na faixa da chamada aparece uma linha "Áudio: ..." que diz se o som está indo e voltando.
5. Clique em **Desligar**. A chamada aparece no histórico como "Atendida".

Se você não ouvir nada: confirme que o PC está conectado a alguma rede (Wi-Fi ou cabo; o WebRTC precisa de um
endereço de rede para negociar o áudio, mesmo falando com o próprio PC) e abra o console do navegador (F12)
para ver mensagens de erro.

Se falhar: me mande o que aparece no console (F12) e a saída de `sudo tail -n 40 /var/log/asterisk/messages`.

---

## Etapa 6. Preparar o celular

Objetivo: o celular entrar na central como `android-gw`.

**6.1 Instalar o APK.** *Pela Central (sem cabo nem Drive).* No PC, na pasta do projeto, coloque o APK onde a
Central procura (troque o nome do `.zip` se o seu for outro):

```bash
python3 -m zipfile -e ~/Downloads/voice-sip-agent-apk.zip modulos/central/apk-celular
```

Abra a Central, toque no ícone de celular do topo e, na aba **1. Baixar o app**, aponte a câmera do celular para o
QR (celular e PC na mesma rede Wi-Fi). Toque no link e baixe o arquivo. Se o Chrome avisar que o download é
inseguro, escolha baixar mesmo assim: é o seu próprio APK, servido pelo seu PC. *Ou, se preferir:* passe o arquivo
`.apk` da Etapa 3 para o celular (cabo, Drive, e-mail). Nos dois casos, abra o arquivo no celular. O
Android vai pedir para permitir "instalar apps desconhecidos" para o app que você usou para abrir o arquivo.
Se o celular for Xiaomi, POCO, Redmi ou Infinix e não deixar instalar, copie o arquivo e instale pelo
gerenciador de arquivos; em Samsung, desligue o **Auto Blocker**.

**6.2 Configurar e parear o celular (uma vez só).** O app precisa de uma permissão que o Android só dá pela
Depuração sem fio, e ele mesmo pede. Você não digita código nenhum: a Central mostra dois QR codes e o app faz o
resto. Com o celular no mesmo Wi-Fi do PC:

1. Ative as **Opções do desenvolvedor**: Configurações, Sobre o telefone, toque 7 vezes em **Número da versão**
   (pule se já existirem; em Samsung ela fica em **Informações do software**).
2. Opções do desenvolvedor, ligue a **Depuração sem fio** (e confirme "Permitir" para a rede, se perguntar).
3. No PC, abra a Central, toque no ícone de celular do topo e entre na aba **2. Configurar**. No app, toque em
   **Scan QR code** (fica na caixa **First setup**, no topo), aponte para o QR e confirme em **Import**. Esse QR
   leva as configurações do servidor e também a senha do pareamento.
4. No celular, entre em **Depuração sem fio** e toque em **Parear dispositivo com código QR** (Pair device with
   QR code). A câmera abre.
5. Na Central, abra a aba **3. Parear** e aponte a câmera do celular para esse QR.

Esperado: em poucos segundos aparece a notificação "Phone paired" e a caixa **First setup** some. Ligue **Take
over calls** (6.4): na aba **Health** do app, **Privileged helper** fica verde ("CONNECTED") em alguns segundos.

Se não parear: depois do passo 3 o app só fica ouvindo por 10 minutos, e os QRs mudam sempre que você fecha e
abre o painel da Central (refaça o passo 3). Alguns aparelhos podem não anunciar o pareamento por QR; nesse caso
use o código: na caixa **First setup**, toque em **QR not working? Pair with the 6-digit code**, entre em
**Parear dispositivo com código de pareamento** e digite os 6 dígitos na notificação que o app mostra, sem trocar
de app (o código só vale enquanto a janela do Android está aberta).

**6.3 O que acontece depois.** Nas próximas vezes (inclusive depois de reiniciar o celular) o app liga a Depuração
sem fio sozinho e reinicia o helper, sem você fazer nada, desde que o celular esteja no Wi-Fi e o **Take over
calls** esteja ligado. Se a aba **Health** mostrar "Helper not connected", toque em **Reconnect helper**.

**6.4 Configurar o servidor.**

*Pelo QR code (recomendado, sem digitar nada; se você fez a Etapa 6.2, já está feito: só ligue **Take over calls**).* No PC, abra a Central e toque no ícone de celular, no topo (ou
no botão **Conectar celular** da linha "Celular gateway"). A Central mostra um QR code com o IP do PC, a porta,
o usuário e a senha. No app, role até **Scan QR code**, aponte a câmera para a tela, confira as mudanças e toque
em **Import**. Depois ligue **Take over calls**. Quando o celular registrar, a Central avisa "Celular conectado".
Isso exige o APK gerado pelo workflow depois desta atualização (ele traz o botão de scan) e Google Play Services
no celular. Se o IP que a Central mostrou não for o do PC na sua rede, escolha o outro na lista ou digite o certo.

*Digitando (se o APK for o original, sem o botão de scan).* Na aba **Settings**, preencha com o bloco que o
`instalar.sh` mostrou:

| Campo no app | Valor |
|---|---|
| PBX host | O IP do PC (ex.: `192.168.0.10`) |
| Port | `5060` |
| Transport | `udp` |
| SRTP | `off` |
| SIP domain | deixe em branco |
| User | `android-gw` |
| Password | A senha do bloco (`GW_SENHA`) |

Toque em **Save & apply**. Depois ligue **Take over calls**.

**Celular com dois chips:** o PC não diz ao app qual chip usar. Nas configurações avançadas do app, escolha um
chip em "SIM for PBX calls without X-VSA-SIMSLOT", senão a chamada de saída é recusada.

**6.5 Conferir no PC:**

```bash
sudo asterisk -rx "pjsip show contacts" | grep android-gw
```

Esperado: uma linha com `android-gw` e `Avail`. Na tela da Central (a página atualiza o estado a cada 10
segundos), a linha "Celular gateway" fica verde: "Registrado e pronto".

Se não ficar: confira nesta ordem. (1) Celular e PC na mesma rede e o roteador sem isolamento de clientes. (2) O
IP digitado é o do PC (`hostname -I`). (3) Firewall do PC (`sudo ufw status`). (4) No app, a aba Health sem
itens vermelhos e **Privileged helper** verde (se não, refaça o pareamento da Etapa 6.2). (5) `Take over calls` ligado.

Se falhar: me mande uma foto/texto da aba Health do app e a saída de
`sudo asterisk -rx "pjsip show contacts"`.

---

## Etapa 7. Primeira ligação real

**Antes:** avise a pessoa, e use o seu segundo telefone.

**7.1 Ligar para fora.** Na Central, digite o número do seu segundo telefone com DDD, por exemplo
`83999998888` (também funcionam `(83) 99999-8888` e `+55 83 99999-8888`). Clique em **Ligar**. A tela mostra
"Chamando..." (sem som, é assim mesmo). O segundo telefone toca. Atenda, fale dos dois lados, e desligue
por um deles. A chamada aparece em **Histórico**.

**7.2 Receber.** Do segundo telefone, ligue para o número do chip do celular gateway. A tela da Central toca
um bipe, o título da aba muda para "Chamada recebida" e aparecem os botões **Atender** e **Recusar**.

**7.3 Tons (DTMF).** Durante uma chamada atendida, as teclas da tela enviam tons para o outro lado. Para testar,
ligue para uma atendente eletrônica (URA) sua e aperte teclas na tela.

Se falhar, consulte a tabela abaixo.

### Problemas comuns

| O que você vê | Causa provável | O que fazer |
|---|---|---|
| "O Asterisk recusou a senha do ramal" | `SIP_SENHA` do `.env` diferente da do `pjsip.conf` | Rode o `instalar.sh` de novo (ele refaz os arquivos a partir do `.env`) |
| "Sem conexão com ws://localhost:8088/ws" | Asterisk parado | `sudo systemctl status asterisk` e `sudo systemctl restart asterisk` |
| "Microfone negado no navegador" | Permissão do microfone bloqueada | Cadeado na barra de endereço, permitir o microfone; abra por `localhost` |
| "Celular gateway indisponível" ou 480 | O celular não está pronto (helper desconectado, `Take over calls` desligado) | Aba Health do app; ligue a Depuração sem fio e toque em **Reconnect helper** |
| "Número não aceito pelo Asterisk" | Número fora do padrão (DDD + 8 ou 9 dígitos) | Use só números brasileiros com DDD; 0800 e internacionais são bloqueados de propósito |
| A chamada completa mas não se ouve nada (ou o outro lado não ouve) | Áudio do celular | No app: **Cellular audio** = *Direct telephony* e **Mute call audio on this phone** desligado |
| Chamada recebida não toca no navegador | `Take over calls` desligado, ramal não registrado ou outra aba da Central aberta | Feche as outras abas (um registro por vez) e confira a linha "Ramal" |
| Caiu tudo depois de reiniciar o celular | O app só reconecta com Wi-Fi e Depuração sem fio ligados | Ligue o Wi-Fi, confira a Depuração sem fio e abra o app uma vez |
| Em chip com Wi-Fi calling (ex.: Google Fi), a chamada cai poucos segundos depois de atender | A operadora trata a chamada como VoIP | Desligue o Wi-Fi calling desse chip |

**Comandos úteis para investigar** (e para me mandar):

```bash
sudo asterisk -rx "pjsip show endpoints"
sudo asterisk -rx "pjsip show contacts"
sudo tail -n 40 /var/log/asterisk/messages
curl -s localhost:3333/central/api/estado
```

Para ver o Asterisk "ao vivo" durante uma chamada: `sudo asterisk -rvvv` (sai com `exit`).

---

## Entendendo o código (para desenvolver em cima)

Regra do `AGENTS.md`: nada de bundler, framework ou TypeScript; o módulo não importa o host; toda cor vem de
token CSS; todo `innerHTML` passa por `esc()`.

| Quero mexer em... | Arquivo |
|---|---|
| Regras de discagem (quais números podem ser ligados) | `modulos/central/asterisk/extensions.conf.modelo` **e** `normalizarNumero` em `central.js` (devem andar juntos) |
| Textos e verificações da tela ("Celular gateway: ...") | `saudeLinhas()` em `modulos/central/publico/central.js` |
| Como o ramal do navegador liga e atende | `iniciarRamal()`, `ligar()`, `atender()` em `central.js` |
| O que o servidor sabe do Asterisk | `modulos/central/servidor/nucleo.mjs` (`buscarEstado`) |
| Rotas novas | `modulos/central/servidor/rotas.mjs` (e atualize `ROTAS_VALIDAS`) |
| Aparência | `modulos/central/publico/central.css` (só `.ch-`, só `var(--token)`) e `public/estilos.css` (tokens) |

Teste rápido depois de qualquer mudança:

```bash
node --check modulos/central/publico/central.js
node --check modulos/central/servidor/rotas.mjs
MOCK=1 npm start      # e abra /central/
```

---

## Segurança, em uma página

- Quem tem a senha do ramal liga pelo seu chip. Ela é aleatória, fica só no `.env` (fora do GitHub) e o servidor
  só a entrega ao próprio PC. **Não use `CONFIG_REMOTA=1`** sem saber o que faz.
- O dialplan só deixa o navegador ligar para números brasileiros com DDD. O celular não consegue discar para fora
  pelo Asterisk.
- O Asterisk só escuta WebSocket e ARI em `127.0.0.1` e só aceita SIP de redes privadas.
- Não existe login na tela: quem alcança a porta 3333 pela rede vê o histórico. Em rede que não é sua, libere a
  porta só para você no firewall.
- O app ganha poderes de shell no celular (pela Depuração sem fio). Instale só o APK que você mesmo compilou (e conferiu o hash).
- Este tutorial é a v1 local. **Fora de escopo** (v2): Asterisk na nuvem (Oracle), TLS/SRTP, Flexisip, mais de
  um atendente, login, histórico em disco, gravação de chamadas.

## Como desfazer tudo

```bash
ls -d /etc/asterisk/backup-central-*     # veja qual backup quer restaurar (o mais antigo é o original)
sudo cp -a /etc/asterisk/backup-central-AAAAMMDD-HHMMSS/. /etc/asterisk/   # troque pelo nome que apareceu acima
sudo systemctl restart asterisk
# ou, para desligar a central de vez:
sudo systemctl disable --now asterisk
```

No celular: desligue **Take over calls** (as ligações voltam a tocar nele) e desinstale o app.
