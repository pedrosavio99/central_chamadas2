# Manual da Central de chamadas (modo online)

Este manual leva você de "nada no ar" até "ligando e atendendo pelo navegador, de qualquer rede, usando o chip de um
celular Android". Tudo em serviços **gratuitos**: Render (o relay), Vercel (a tela) e GitHub (compila o app).

O modo antigo, com Asterisk no seu PC, continua no projeto: veja o Apêndice A e o `PASSO-A-PASSO.md`.

## Como as peças se falam

```
Navegador (a Central)  <--internet-->  Relay (Render)  <--internet-->  Celular com o app "chipeira"  <-->  chip
 página na Vercel                      passa mensagens                  liga e atende pelo chip
                                       e áudio
```

- A **Central** é a página que você abre no navegador (hospedada na Vercel). Liga e atende pelo navegador.
- O **relay** é um servidorzinho (Render) que só repassa mensagens e áudio entre a Central e o celular. Ele não grava
  nada. Por isso o celular e o computador **não precisam estar na mesma rede**: cada um só precisa de internet.
- O **app do celular** (a "chipeira") conecta no relay e faz a ponte: o que você disca na Central, o celular disca pelo
  chip; o que chega no chip, aparece na Central. Não usa Bluetooth.
- Enquanto o app estiver com **Take over calls** ligado, as chamadas recebidas no chip tocam na Central e não no
  celular.

## Leia antes (o que esperar de verdade)

- **Atraso e picotes.** O áudio vai pela internet dentro de uma conexão WebSocket (que não perde pacote, então quando a
  rede oscila ela espera). Conte com **meio segundo de atraso** e, em rede ruim, trechos picotados. É suficiente para
  conversar. Use **fone de ouvido** na Central, senão o microfone capta o alto-falante e dá eco.
- **O servidor grátis dorme.** O plano grátis do Render desliga o serviço depois de 15 minutos sem tráfego e leva cerca
  de 1 minuto para acordar. Mensagens de WebSocket contam como tráfego, então **enquanto o celular estiver conectado o
  relay não dorme**. A primeira entrada do dia, com o celular desligado, pode demorar até 1 minuto: a tela mostra
  "Acordando o servidor". O Render dá 750 horas grátis por mês (um mês tem 744), então um serviço ligado o tempo todo
  cabe.
- **Uma linha, um atendente por vez.** Uma chamada por vez. Abrir a Central em outra aba tira a linha da primeira.
- **Vercel grátis é para uso pessoal.** O plano Hobby da Vercel não permite uso comercial. Para testar, serve. Se isso
  virar operação de uma empresa, use o plano pago da Vercel ou hospede a mesma pasta como segundo serviço no Render
  (comando `npm start`, variável `RELAY_URL`).
- **Cada chamada feita gasta minutos do plano do chip.** Teste primeiro com o seu próprio número.
- **O que eu testei e o que não testei.** Testei o relay (22 verificações), a tela num navegador de verdade falando
  com o relay (áudio nos dois sentidos, chamadas feitas, recebidas, recusadas, DTMF, registro), e o código do app que
  fala com o relay rodando num ambiente Java contra o relay de verdade (13 verificações). **Não testei**: o app dentro
  de um celular, o workflow do GitHub compilando o APK, o Render e a Vercel de verdade, e a chamada até o chip. Esses
  são os pontos onde pode haver um ajuste. Por isso existe a aba **Registro** (Parte 5): ela mostra o que o site, o
  relay e o app contam, e você copia tudo com um toque.

---

## Parte 1. Subir o sistema (uma vez só)

Você vai precisar de contas no **GitHub**, no **Render** e na **Vercel**. Nenhuma pede cartão para o plano grátis (se
alguma pedir, pare e me avise).

### 1.1 Colocar o projeto no GitHub

Na pasta do projeto, no terminal:

```bash
git add -A
git commit -m "central online"
git push
```

Esperado: o `git push` termina sem erro e a pasta `relay/`, o arquivo `render.yaml` e a pasta `apk/` aparecem no
repositório do GitHub.

### 1.2 Criar o relay no Render

1. Em render.com, entre com o GitHub. Toque em **New +** e depois em **Blueprint**.
2. Escolha o repositório do projeto. O Render lê o arquivo `render.yaml` e mostra um serviço chamado
   **central-relay** (plano Free).
3. Ele pede o valor de **ACCESS_CODE**. É a "senha da Central": invente um código **com 12 ou mais caracteres**
   (letras e números). Anote: você vai digitá-lo na tela da Central. Ele não fica no GitHub.
4. Toque em **Apply** (ou **Deploy Blueprint**) e espere o serviço ficar **Live** (uns 2 a 3 minutos).
5. Copie o endereço do serviço, algo como `https://central-relay.onrender.com`.

Confira: abra `https://SEU-RELAY.onrender.com/health` no navegador. Esperado: um texto com
`"servico":"central-relay"` e `"configurado":true`. Se aparecer `"configurado":false`, faltou o ACCESS_CODE: no Render,
abra o serviço, **Environment**, preencha e salve.

> Se você mudar o ACCESS_CODE depois, o app do celular deixa de entrar (o token dele nasce do código). Escaneie o QR
> de novo (Parte 3).

### 1.3 Publicar a Central na Vercel

1. Em vercel.com, entre com o GitHub e toque em **Add New**, **Project**. Escolha o mesmo repositório.
2. Em **Framework Preset** deixe **Other**. Não precisa de comando de build.
3. Abra **Environment Variables** e acrescente:

   | Nome | Valor | Obrigatória |
   |---|---|---|
   | `RELAY_URL` | o endereço do Render, sem barra no fim | sim (senão a tela pergunta o endereço no login) |
   | `APK_URL` | link do APK, só se você quiser outro lugar que não a release do GitHub (veja 1.4) | não |

4. Toque em **Deploy**. Quando terminar, abra `https://SEU-PROJETO.vercel.app/central/`.

Esperado: a tela de entrada, com o campo **Código de acesso**.

### 1.4 Gerar o APK do celular

No GitHub, abra o repositório, aba **Actions**, escolha **Gerar APK do celular gateway**, toque em **Run workflow** e
deixe a versão padrão. Leva de 15 a 40 minutos (compila o áudio e o SIP do zero).

No fim, o APK fica em dois lugares:

- **Release `apk-latest`** (aba **Releases** do repositório), arquivo `central-gateway.apk`. O endereço
  `https://github.com/SEU-USUARIO/SEU-REPO/releases/download/apk-latest/central-gateway.apk` **nunca muda**: a cada
  execução do workflow o arquivo que está atrás dele é trocado pelo novo. A Central (na Vercel) descobre esse
  endereço sozinha e mostra um **QR para baixar o APK** na janela **Conectar celular**, aba 1. Você não configura nada e
  não precisa subir o APK para lugar nenhum.
- **Artifacts**, no fim da página da execução, dentro de um `.zip`. Baixe e extraia.

Esperado: na página da execução, no resumo, aparece **Link fixo do APK**. Depois, no site, **Conectar celular** mostra o QR
(se não aparecer, feche e abra a janela; a Central confere a cada 20 segundos enquanto a release não existe).

Importante sobre o link automático:

- Só funciona com repositório **público**. Em repositório privado o link da release pede login no GitHub e o celular não
  baixa sozinho: passe o `.apk` por cabo, Drive ou WhatsApp para você mesmo. O resumo da execução avisa quando isso
  acontece.
- A Central usa as variáveis de sistema da Vercel (`VERCEL_GIT_REPO_OWNER` e `VERCEL_GIT_REPO_SLUG`). Se você desligou
  "Automatically expose System Environment Variables" no projeto da Vercel, ou hospeda a Central em outro lugar, crie
  `APK_URL` com o link acima.
- `APK_URL`, se existir, tem prioridade sobre o link automático.

Se o build falhar, abra a execução, copie as últimas linhas do log do passo que ficou vermelho e me envie.

### 1.5 Chave de assinatura fixa (opcional, recomendado)

O APK é uma build de teste (debug). O runner do GitHub cria uma chave de assinatura nova a cada execução, e o Android
**recusa instalar um APK assinado com outra chave por cima do app antigo** ("conflito de assinatura" ou "app não
instalado"). Sem este passo, a cada APK novo você precisa desinstalar o antigo, instalar o novo e escanear o QR da
aba 2 de novo (o pareamento da Depuração sem fio também se refaz).

Com uma chave fixa, o APK novo entra por cima, sem perder configuração. São 2 minutos, uma vez só, no seu computador:

1. Gere a chave **fora da pasta do projeto** (nunca suba esse arquivo para o GitHub):

   ```
   cd ~
   keytool -genkeypair -v -keystore debug.keystore -storepass android -alias androiddebugkey -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
   ```

   Esperado: a última linha é `[Storing debug.keystore]`. Se der `keytool: command not found`, instale o Java:
   `sudo apt install default-jre-headless`.

2. Gere o texto do segredo e copie a linha inteira que aparecer (é uma linha longa só):

   ```
   base64 -w0 ~/debug.keystore
   ```

3. No GitHub, no repositório: **Settings**, **Secrets and variables**, **Actions**, **New repository secret**. Em **Name**
   escreva `ANDROID_DEBUG_KEYSTORE_B64` e em **Secret** cole a linha. Toque em **Add secret**.
4. Rode o workflow de novo (1.4). No passo **Usar a chave de assinatura fixa** do log deve aparecer "Chave de assinatura
   fixa restaurada".

Guarde uma cópia do `~/debug.keystore` em lugar seguro. Se perder, gere outra e troque o segredo: nesse caso o APK
seguinte volta a exigir desinstalar o antigo uma vez.

O primeiro APK com a chave fixa ainda exige desinstalar o app que você já tem instalado (ele foi assinado com outra
chave). A partir do segundo, entra por cima.

---

## Parte 2. Primeiro teste, sem celular (5 minutos)

Antes de mexer no celular, confirme que o site e o relay se entendem usando um "celular de mentira" que roda no seu PC.

1. No terminal, na pasta do projeto:

   ```bash
   cd relay
   npm install
   node teste/fone-falso.mjs --url https://SEU-RELAY.onrender.com --codigo SEU_ACCESS_CODE
   ```

   Esperado: uma linha `[fone-falso] no ar. Aguardando ligacoes` (pode levar 1 minuto se o relay estava dormindo).
2. Abra a Central, digite o código e toque em **Entrar**. A linha **Celular gateway** fica verde.
3. Digite qualquer número com DDD e toque em **Ligar**. O fone falso atende e você ouve um **tom agudo contínuo**
   (440 Hz) no navegador. Isso prova o caminho de áudio do relay até o seu fone.
4. No terminal, digite `ligar 11988887777` e Enter: a Central toca como chamada recebida, com **Atender** e
   **Recusar**. Digite `fim` para encerrar.

Se isso funciona, o site, o relay e o código de acesso estão certos. Feche o fone falso (Ctrl+C) antes de usar o celular
de verdade: só um celular por linha, e o novo toma a linha do antigo.

---

## Parte 3. Preparar o celular (uma vez só)

Tudo isso também aparece dentro da Central: toque no **?** no topo (guia) e no ícone do celular (**Conectar celular**).

### 3.1 Instalar o app

1. Baixe o APK: no site, **Conectar celular**, aba 1, aponte a câmera para o QR (se ele aparecer; veja 1.4), ou passe o
   `.apk` por cabo/Drive. Abra o `.apk` no celular. O Android pede para permitir "instalar apps desconhecidos": permita.
   Se o Android disser que o app não pode ser instalado por cima do que já existe, desinstale o antigo primeiro (veja 1.5).
2. Samsung: se não deixar instalar, desligue o **Auto Blocker** (Configurações, Segurança e privacidade).

### 3.2 Preparar o Android

1. **Opções do desenvolvedor.** Configurações, Sobre o telefone, Informações do software, toque 7 vezes em **Número da
   versão**. Pule se já existe.
2. Em Opções do desenvolvedor, ligue a **Depuração sem fio**. Confirme "Permitir" para a rede, se perguntar.
   **O celular precisa estar no Wi-Fi só nesta etapa e para o pareamento.** Depois, no dia a dia, ele pode ficar no 4G.

### 3.3 Configurar e parear, sem digitar nada

Com a Central aberta e logada, toque no ícone do celular (**Conectar celular**):

1. **Aba 2, Configurar:** no app, role até **Scan QR code**, aponte para o QR da tela e toque em **Import**. Isso leva ao
   app o endereço do relay, o nome da linha e a senha do celular (um token que só vale para esta linha). **Não mostre
   esse QR a ninguém.**
2. No celular: Configurações, Opções do desenvolvedor, Depuração sem fio, **Parear dispositivo com código QR**. A câmera
   abre.
3. **Aba 3, Parear:** aponte a câmera para o QR dela. O app pareia sozinho e mostra a notificação "Phone paired".
4. No app, ligue **Take over calls**.

Depois do Import, abra no app a seção **Settings** para conferir: com **SIP stack** em **online (relay)** aparecem os
campos Relay host, Relay port, Line (nome da linha) e Phone token. O token só sai pelo QR, então o jeito normal é
escanear; não digite a mão.

**Acompanhe ao vivo.** O painel mostra uma lista que atualiza sozinha:

| Passo | O que significa |
|---|---|
| Servidor configurado no app | O app importou as configurações |
| Pareado com a Depuração sem fio | O pareamento deu certo |
| Acesso privilegiado (helper) | O app abriu o "ajudante" com o poder de controlar as chamadas |
| Acesso às chamadas | O Android liberou o app para atender e discar |
| Áudio das chamadas | O app consegue pegar e injetar o som da chamada |
| Conectado ao relay | O celular entrou no relay: a Central mostra "Celular conectado" |

O primeiro passo que falta mostra o motivo. O app só relata o progresso por 45 minutos depois do scan da aba 2; passando
disso, escaneie o QR de novo. Mesmo sem relatar, o celular conecta no relay assim que as configurações são importadas e o **Take over calls** está ligado.

### 3.4 No dia a dia

- Deixe o celular **ligado, com internet (Wi-Fi ou 4G) e com o app instalado**. Pode ficar com a tela apagada.
- **Take over calls** ligado = o celular é a chipeira. Desligado = volta ao normal.
- Depois de reiniciar o celular: ligue o Wi-Fi e abra o app uma vez. Ele religa a Depuração sem fio e o ajudante sozinho
  (leva alguns segundos). Se a aba **Health** mostrar "Helper not connected", toque em **Reconnect helper**.
- Se desinstalar o app, o pareamento se perde: refaça 3.3.
- **Dois chips:** nas configurações avançadas do app, escolha um chip em "SIM for PBX calls without X-VSA-SIMSLOT",
  senão a chamada de saída é recusada.
- A conexão com o relay volta sozinha quando a rede cai ou muda (tentativas de 1, 2, 4, 8, 15 e 30 segundos).

---

## Parte 4. No site (a Central)

### 4.1 Entrar

Abra `https://SEU-PROJETO.vercel.app/central/`, digite o **código de acesso** (o ACCESS_CODE) e toque em **Entrar**. A
tela lembra o código neste navegador e entra sozinha nas próximas vezes. **Sair** esquece o código.

Se aparecer "Acordando o servidor", espere até 1 minuto: é o Render grátis saindo do sono.

### 4.2 Ler o topo da tela

- **Relay:** verde quando a Central está falando com o relay.
- **Celular gateway:** verde quando o app do celular está conectado ao relay. Vermelho: abra o painel de celular e veja a
  lista ao vivo.
- **Microfone e áudio:** teste o microfone antes da primeira chamada (a barra tem que mexer quando você fala).

### 4.3 Ligar

1. Digite o número com DDD, por exemplo `83999998888` (também vale `(83) 99999-8888`).
2. Toque em **Ligar**. A primeira vez, o navegador pede o microfone: permita.
3. A tela mostra "Chamando..." (sem som de chamando: o app não repassa esse tom). Quando o outro lado atende, o áudio
   começa. As teclas mandam tons (DTMF), úteis em atendimento eletrônico.
4. **Desligar** encerra. A chamada entra no **Histórico**.

Só números brasileiros com DDD. O celular recusa números de emergência.

### 4.4 Receber

Com a Central aberta, quando alguém liga para o chip a tela toca um bipe, o título da aba vira "Chamada recebida" e
aparecem **Atender** e **Recusar**. **Com a Central fechada, a chamada recebida é recusada na hora** (o relay avisa o
celular), em vez de ficar tocando sem ninguém. Se você quer receber, deixe a aba aberta.

### 4.5 Histórico

Fica **só neste navegador** (não vai para o servidor). Limpar os dados do navegador apaga.

---

## Parte 5. O log na tela (site e app)

Para acompanharmos juntos o que acontece, há logs nos dois lados e dá para copiar com um toque.

**No site:** terceira aba, **Registro**.
- Mostra, em ordem de horário, o que o **site**, o **relay** e o **app** contam, cada um com sua marca.
- **Copiar tudo** coloca na área de transferência um relatório completo: o estado do relay e do celular, o relato do
  app e todas as linhas do registro (chamadas e medidas de áudio incluídas). Cole na conversa comigo. **Baixar** salva um arquivo. **Limpar** zera a tela.
- O relatório **não leva** o código de acesso nem o token do celular.

**No app:** no fim da tela principal, o cartão **Log**.
- Toque em **Copiar log** e cole na conversa. Sai a versão do Android, as configurações (sem a senha) e as últimas 200
  linhas.
- Enquanto o celular está conectado, ele manda as linhas novas do log para o relay a cada poucos segundos, e a Central
  mostra no Registro com a marca **app**. Por isso muitas vezes você nem precisa copiar do app.

**Quando algo der errado:** copie o Registro do site e, se o celular estiver envolvido, o log do app, e me mande os dois.

---

## Parte 6. Se algo falhar

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| "Acordando o servidor" por mais de 2 minutos | Endereço errado, ou o serviço não está Live | Abra `https://SEU-RELAY.onrender.com/health`; no Render veja se está **Live** e leia os **Logs** |
| `configurado:false` no `/health` | Faltou o ACCESS_CODE | Render, **Environment**, preencher e salvar |
| "Código recusado" | Código diferente do ACCESS_CODE | Digite o valor que está no Render. Com 10 tentativas erradas em 10 minutos, o relay bloqueia seu IP por 10 minutos |
| A tela pede o endereço do relay | A variável `RELAY_URL` não foi criada na Vercel | Vercel, **Settings**, **Environment Variables**, criar e fazer **Redeploy** (ou digite o endereço na tela) |
| Celular gateway sempre vermelho | O app não conectou ao relay | Veja a lista ao vivo e o Registro: a linha **app** diz o motivo (token recusado, sem rede, helper) |
| App diz "refused the token" | ACCESS_CODE mudou ou o QR é de outra linha | Escaneie de novo o QR da aba 2 |
| App diz "another phone took over this line" | Outro celular (ou o fone falso) entrou na mesma linha | Feche o outro e reabra o app |
| Pareado mas "Acesso privilegiado" não fica verde | O app não conseguiu falar com a Depuração sem fio do próprio celular | Wi-Fi ligado, Depuração sem fio ligada, **Reconnect helper** no app |
| Liga e toca, mas **sem som** | Áudio da chamada no celular | No app, **Cellular audio** = *Direct telephony*; veja no Registro os quadros enviados e recebidos |
| Eco | Alto-falante e microfone juntos | Fone de ouvido |
| Áudio picotado ou com atraso grande | Rede ruim em um dos lados | Teste com Wi-Fi bom nos dois lados; é uma limitação do modo grátis por WebSocket |
| Caiu no meio da chamada | O Render reiniciou o serviço, ou a rede do celular caiu | A tela e o app reconectam sozinhos em segundos; ligue de novo |
| Workflow vermelho no passo "Baixar PJSIP, OpenSSL e Opus", ou "SSL_ERROR_SYSCALL" ao baixar | Queda de rede passageira em um dos sites de download | O passo já tenta 5 vezes em até 3 endereços. Se ainda assim falhar, abra a execução e toque em **Re-run all jobs** |
| Android recusa instalar o APK novo ("app não instalado" ou conflito de assinatura) | O APK novo foi assinado com outra chave que o instalado | Desinstale o app antigo, instale o novo e escaneie o QR da aba 2. Para não repetir, faça o passo 1.5 |
| QR de download do APK não aparece | Repositório privado, workflow ainda não terminou, ou a Vercel não expõe as variáveis de sistema | Veja 1.4: passe o `.apk` por cabo/Drive, espere o workflow, ou crie `APK_URL` na Vercel |
| "Ocupado" ao ligar | Já há uma chamada na linha | Encerre a atual |
| Toda ligação da Central falha | Número fora do padrão ou chip sem crédito | Teste com o seu número e leia a causa no Registro |

Para investigar sem o site: `https://SEU-RELAY.onrender.com/log?sala=principal&codigo=SEU_ACCESS_CODE` mostra o registro
do relay para a linha. Cuidado: esse endereço leva o código, não o compartilhe.

---

## Parte 7. Limites e como crescer

Hoje (grátis, para testar):

| Limite | Por quê | Saída |
|---|---|---|
| Uma linha, um atendente | O relay já separa por **sala** (nome da linha), mas a tela entra sempre na sala `principal` | Escolher a sala no login; um celular por sala |
| Relay dorme sem tráfego | Plano grátis do Render | Plano pago do Render (a partir de 7 dólares por mês) ou qualquer VPS: o mesmo código, sem mudar nada |
| Atraso e picotes | Áudio em WebSocket (TCP) | Trocar o caminho de áudio por WebRTC ou UDP, mantendo as mensagens de controle |
| Um servidor só | O estado das salas fica na memória do relay | Vários relays com Redis (publicar e assinar) para dividir as salas |
| Um código para todos | `ACCESS_CODE` único | Usuários e senhas por pessoa, com o registro de quem ligou |
| Histórico só no navegador | Não há banco de dados | Gravar o histórico num banco (Supabase tem plano grátis) |

A arquitetura já está em camadas separadas justamente para isso: a **Central** (página estática), o **relay**
(protocolo de mensagens documentado em `relay/README.md`) e o **app** (um endpoint a mais, ao lado do SIP). Trocar uma
camada não obriga a mexer nas outras.

---

## Apêndice A. Modo local com Asterisk (continua funcionando)

O modo antigo, em que o Asterisk roda no seu PC e o celular precisa estar no mesmo Wi-Fi, não foi removido. Ele vale
quando o servidor roda no seu PC (`npm start`, sem `RELAY_URL`). Para forçar esse modo mesmo na Vercel, use
`MODO=local`. O guia completo está no `PASSO-A-PASSO.md`. No app, escolha **SIP stack** = *pjsua2* em vez de *online (relay)*.

## Apêndice B. Variáveis de ambiente, resumo

| Onde | Nome | Para quê |
|---|---|---|
| Render (relay) | `ACCESS_CODE` | Obrigatória. Código de entrada; dele nasce o token de cada celular |
| Render (relay) | `ORIGINS` | Opcional. Endereços de site aceitos no WebSocket, separados por vírgula. Depois que tudo funcionar, coloque o da Vercel |
| Render (relay) | `MAX_SALAS` | Opcional. Quantas linhas ao mesmo tempo (padrão 50) |
| Vercel (Central) | `RELAY_URL` | Endereço do relay. Liga o modo online |
| Vercel (Central) | `APK_URL` | Opcional. Link do APK para o QR de download. Sem ele, a Central usa sozinha o link fixo da release `apk-latest` (repositório público) |
| GitHub (Actions secret) | `ANDROID_DEBUG_KEYSTORE_B64` | Opcional. Chave de assinatura fixa, para o APK novo instalar por cima do antigo (veja 1.5) |
| Vercel (Central) | `MODO` | Opcional. `online` ou `local` para forçar um dos modos |
