# SchoolPass

Controle de acesso escolar para catracas **Henry Lumen**, com modo **online** e **offline**,
horários por turma, aviso aos pais na entrada e saída e relatório de frequência.

- Cartão RFID, digital, QR Code e reconhecimento facial (preparado para quando o terminal facial for instalado)
- Painel web: passagens ao vivo, liberação manual, cadastros, turmas, catracas, relatórios e calendário
- Fila de avisos persistente (WhatsApp Cloud API, webhook ou console), com novas tentativas
- Simulador de catraca Lumen para testar sem o equipamento

## Como funciona

```
 Lumen (TCP 3000) ◄──── SchoolPass (servidor na rede da escola) ────► Painel web
        │                     │   SQLite (data/schoolpass.db)
        │                     └──► WhatsApp / webhook (avisos aos pais)
 Terminal facial ──HTTP──► /api/facial/reconhecimento
```

**Modo online** — a catraca pergunta ao SchoolPass a cada leitura. O SchoolPass confere cadastro,
validade, turma, horário e calendário, responde liberando ou negando e mostra uma mensagem no display
(ex.: `BEM-VINDO ANA`, `PROCURE A SECRETARIA`). Quando a catraca avisa que girou, registra a passagem
e avisa os responsáveis.

**Modo offline** — a catraca decide com a lista gravada na memória dela. O SchoolPass acerta o relógio
da catraca, importa as passagens que ela informa (sem duplicar) e gera a lista de autorizados em CSV.
Avisos de registros com mais de 30 minutos não são enviados, para não disparar uma rajada ao reconectar.

### Regras de acesso
| Quem | Regra |
|---|---|
| Aluno | Só entra/sai dentro das janelas da turma no dia; bloqueado em dias sem aula |
| Funcionário / acesso livre | Passa a qualquer hora enquanto ativo e dentro da validade |
| Visitante | Passa até a data de validade |
| Qualquer um inativo ou vencido | Negado |

Saída fora do horário mostra `PROCURE A SECRETARIA`; a secretaria libera pelo painel informando o motivo,
e os pais recebem o aviso normalmente.

## Interface

O painel segue o design system em [`design-system/schoolpass/`](design-system/schoolpass/MASTER.md),
gerado com o [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill): estilo
minimalista suíço, tema escuro com verde de status (e tema claro), Fira Sans + Fira Code, alta densidade.
Os ajustes específicos do painel estão em [`pages/painel.md`](design-system/schoolpass/pages/painel.md).

## Instalação

Requer Node.js 20 ou mais novo, num computador ligado à mesma rede das catracas.

```bash
git clone https://github.com/Pedronoah21/schoolpass
cd schoolpass
npm install
cp .env.example .env      # troque ADMIN_TOKEN!
npm run build
npm start                 # painel em http://IP-DO-SERVIDOR:8080
```

Para desenvolvimento: `npm run dev`. Testes: `npm test`.

### Primeiros passos no painel
1. **Turmas** → crie as turmas e marque os dias e janelas de entrada/saída.
2. **Pessoas** → cadastre alunos, adicione o número do cartão (e/ou digital, QR) e os responsáveis com WhatsApp.
3. **Catracas** → cadastre cada Lumen com IP e porta (padrão 3000) e escolha o modo.
4. **Calendário** → feriados e recessos.

## Testar sem a catraca

```bash
PORTA_SIM=3001 npm run simulador
```
Cadastre uma catraca com IP `127.0.0.1` e porta `3001` e digite no simulador:
`e 12345` (entrada), `s 12345` (saída), `d` (próxima não gira), `o 12345 e` (registro offline antigo).

## ⚠️ Validação na Lumen real (fazer antes de usar com alunos)

O protocolo TCP da Henry não é público. A implementação segue o formato de quadro usado pela família
Henry 7x/8x (STX, tamanho, corpo, checksum XOR, ETX) e códigos de bibliotecas abertas. Firmwares
diferentes podem usar outros códigos. Na instalação, com uma pessoa de teste:

1. Confira no painel se a catraca aparece **Conectada**.
2. Passe um cartão cadastrado e veja se libera **no sentido certo**. Se girar ao contrário, marque
   *sentido invertido* na catraca. Se não liberar, ajuste `liberarEntrada`/`liberarSaida` em `HENRY_CODIGOS`.
3. Veja se a passagem vira **Passou** na tela *Ao vivo*. Se ficar como *Não girou* mesmo girando, o
   firmware usa outro código de giro (`giroConcluido`) ou não avisa o giro — use `HENRY_CONFIRMA_GIRO=0`.
4. Os códigos ficam todos em [`src/henry/codigos.ts`](src/henry/codigos.ts).

O ideal é pedir ao revendedor Henry o **manual de protocolo de comunicação da Lumen**. Com ele, além
de confirmar os códigos, dá para implementar o **envio da lista de autorizados direto para a memória
da catraca** (`montarComandosCadastro` em [`src/henry/offline.ts`](src/henry/offline.ts)). Até lá, use
o botão *Baixar lista offline (CSV)* e importe pelo software de configuração da Henry.

## Avisos aos pais

| `NOTIFICACAO_CANAL` | Como funciona |
|---|---|
| `console` | Só registra no log (padrão, para testes) |
| `webhook` | `POST` JSON para `NOTIFICACAO_WEBHOOK_URL` (n8n, Zapier, bot próprio) com o campo `texto` pronto |
| `whatsapp` | WhatsApp Cloud API da Meta. Exige um modelo aprovado (padrão `aviso_catraca`) com 3 variáveis: nome do aluno, "entrou na"/"saiu da", horário |

Os avisos ficam numa fila no banco e são reenviados até 5 vezes se o envio falhar.

## Reconhecimento facial (futuro)

Cadastre na pessoa uma credencial do tipo **Facial** com o ID que o terminal usa. Defina `FACIAL_CHAVE`
no `.env` e faça o terminal (ou um pequeno serviço ao lado dele) chamar:

```http
POST /api/facial/reconhecimento
x-chave-facial: <FACIAL_CHAVE>
Content-Type: application/json

{ "catraca_id": 1, "id_facial": "face-123", "sentido": "entrada" }
```
O SchoolPass aplica as mesmas regras de horário e, se permitido, libera a Lumen remotamente.

## API

Todas as rotas `/api/*` exigem `Authorization: Bearer <ADMIN_TOKEN>`.

| Rota | Uso |
|---|---|
| `GET /api/status` | Catracas e conexões |
| `GET/POST/PUT/DELETE /api/turmas`, `PUT /api/turmas/:id/horarios` | Turmas e horários |
| `GET/POST/PUT/DELETE /api/pessoas`, `POST /api/pessoas/:id/credenciais`, `POST /api/pessoas/:id/responsaveis` | Cadastros |
| `GET/POST/PUT/DELETE /api/catracas`, `POST /api/catracas/:id/liberar`, `POST /api/catracas/:id/relogio` | Catracas |
| `GET /api/eventos`, `GET /api/eventos/ao-vivo` (SSE) | Passagens |
| `GET /api/relatorios/dia`, `GET /api/relatorios/periodo` (`&formato=csv`) | Frequência |
| `GET /api/offline/lista.csv` | Lista de autorizados |
| `GET/POST/DELETE /api/dias-sem-aula` | Calendário |

## Estrutura

```
src/
  henry/        protocolo TCP, conexão com reconexão, códigos, modo offline
  acesso/       regras de acesso e central que liga catracas, regras e avisos
  notificacao/  canais (WhatsApp, webhook, console) e fila de envio
  relatorios/   frequência diária e por período
  api/          rotas do painel
  sim/          simulador de catraca Lumen
public/         painel web
design-system/  design system do painel (gerado com ui-ux-pro-max-skill)
test/           testes (protocolo, regras, integração com o simulador)
```
