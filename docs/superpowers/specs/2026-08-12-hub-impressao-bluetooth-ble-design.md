# Hub Impressão — Bluetooth BLE persistente

## Contexto

O Hub Impressão já é um aplicativo Electron residente no Windows, com tray, inicialização automática, WebSocket seguro para receber trabalhos do Pedidos Hub, filas de impressão e suporte operacional para impressoras USB/rede. A implementação atual não trata uma impressora Bluetooth BLE como um destino de primeira classe.

O navegador continuará sendo a origem dos trabalhos. O Hub não deverá criar um segundo listener do Supabase nem assumir a responsabilidade de descobrir pedidos por conta própria. O fluxo desejado é:

```text
Pedidos Hub → WebSocket local existente → Hub Impressão → fila BLE → impressora Bluetooth
```

O objetivo é que, depois de uma configuração inicial, a impressora BLE permaneça disponível para impressão automática mesmo com o navegador minimizado, outra aplicação em primeiro plano ou a tela bloqueada. Isso não significa garantir conexão durante desligamento do adaptador, suspensão profunda do Windows ou impressora fora de alcance.

### Estado real antes da implementação

Há dois caminhos diferentes no sistema atual:

1. O Pedidos Hub web já possui um caminho Web Bluetooth. Ele salva a identidade da impressora no `localStorage`, usa `navigator.bluetooth.getDevices()` para tentar reconectar, localiza uma característica de escrita GATT e envia os bytes ESC/POS em chunks de 20 bytes. O auto-print do navegador chama esse caminho quando o método de impressão é `bluetooth` ou `auto`.
2. O Hub Impressão Windows atual lista e imprime pelo Windows Spooler. A descoberta Bluetooth no detector é apenas um placeholder que retorna vazio; não existe bridge BLE no `PrinterManager`.

O cliente da Leninha pode, portanto, ter observado uma impressão automática Bluetooth verdadeira, mas isso não prova que ela saiu pelo Hub Impressão. A reclamação de reconexão ao trocar de aplicação é compatível com o primeiro caminho, que depende do contexto do navegador. A entrega desta especificação move esse transporte para dentro do Hub quando ele for o dono da autoimpressão.

Referências do comportamento atual:

- Web Bluetooth e reconexão: `Pedidos Hub/src/utils/bluetooth-printer.ts`;
- seleção do método Bluetooth e envio ESC/POS: `Pedidos Hub/src/utils/print-manager.ts`;
- montagem dos hooks de auto-print e exclusão quando o Hub é autoritativo: `Pedidos Hub/src/layouts/MainLayout.tsx`;
- spooler Windows e ausência de BLE direto: `Hub Impressão/src/main/printer/windows-manager.js` e `Hub Impressão/src/main/printer/detector.js`.

## Objetivos

- Integrar BLE dentro do Hub Impressão existente, sem criar um agente separado.
- Expor impressoras BLE no mesmo inventário e nas mesmas rotas já usadas pelo Hub.
- Persistir a identidade/configuração do dispositivo no armazenamento de configurações do Hub.
- Manter um runtime Bluetooth vivo quando a janela de configuração estiver oculta.
- Reconectar automaticamente após desconexão, retorno do sistema, desbloqueio ou perda temporária de alcance.
- Serializar os trabalhos por impressora, evitando escritas concorrentes no mesmo GATT characteristic.
- Preservar USB, rede, WebSocket, roteamento por setor, listener pareado e proteção contra duplicidade existentes.
- Gerar uma nova build do Hub após a implementação e as validações locais.
- Permitir que o cliente use o modo `auto`/local sem depender da aba do navegador permanecer em primeiro plano.

## Fora de escopo

- Criar um executável Bluetooth separado ou um serviço Windows adicional.
- Fazer o Hub escutar diretamente o Supabase para autoimpressão.
- Alterar o contrato de origem dos trabalhos ou criar uma segunda fonte de pedidos.
- Suportar Android, iOS ou impressoras Bluetooth Classic nesta entrega.
- Prometer conexão permanente durante suspensão/hibernação, Bluetooth desligado, impressora desligada ou ausência de alcance de rádio.
- Fazer retry cego de um recibo inteiro depois que uma parte dos bytes já tiver sido aceita pela impressora.
- Remover o caminho Bluetooth direto já existente no navegador nesta entrega; ele continuará como fallback para clientes que não usam o Hub.

## Alternativas consideradas

### A. Web Bluetooth hospedado dentro do Hub — escolhida

Usar o Web Bluetooth do Electron em um renderer oculto e manter a coordenação de ciclo de vida no processo principal. O processo principal controla o bridge e o `PrinterManager`; o renderer mantém os objetos `BluetoothDevice`/GATT e executa as escritas. A janela visível do Hub fornece a ação explícita de descobrir/parear e testar a impressora.

Vantagens: aproveita o Electron já distribuído, evita adicionar um segundo binário nativo e mantém o transporte BLE encapsulado no Hub. O Electron exige o tratamento do evento de seleção do dispositivo e oferece um handler de pareamento para Windows/Linux, portanto esses pontos farão parte do bootstrap do Hub. [Electron — Web Bluetooth](https://www.electronjs.org/docs/latest/tutorial/devices) [Electron — webContents](https://www.electronjs.org/docs/latest/api/web-contents)

Risco controlado: o runtime oculto precisa ser criado também no modo `--hidden`; a descoberta inicial continua sendo uma operação guiada pelo usuário, enquanto reconexões posteriores usam o dispositivo autorizado/persistido.

### B. Helper nativo WinRT separado

Criar um processo auxiliar usando APIs nativas do Windows e IPC com o Hub. Essa alternativa oferece controle mais direto sobre o ciclo de vida BLE, mas introduz outro executável, protocolo IPC, assinatura/instalação, atualizações e mais superfícies de falha. Não será usada nesta entrega.

### C. Tratar BLE como impressora do spooler/COM

Delegar a impressão ao spooler do Windows ou a uma porta COM. Isso não cobre de forma confiável impressoras BLE que não se apresentam como uma impressora do sistema e não resolve a descoberta, reconexão e escrita GATT. Não será usada.

## Desenho técnico

### 1. Bridge BLE no Hub

Adicionar um módulo dedicado, por exemplo `src/main/bluetooth/ble-bridge.js`, atrás de uma interface pequena e testável. O bridge deverá:

- manter estado por impressora: `disconnected`, `connecting`, `connected`, `printing`, `reconnecting` e `error`;
- armazenar `deviceId`, nome exibido, endereço lógico e metadados do serviço/characteristic selecionados;
- conectar ao GATT e localizar o characteristic de escrita configurado pelo dispositivo;
- preferir `writeWithoutResponse` quando disponível e cair para escrita com resposta quando necessário;
- dividir o buffer ESC/POS em chunks seguros, começando com 20 bytes e permitindo ajuste por configuração quando uma impressora exigir outro limite;
- aplicar uma fila serial por dispositivo e aguardar a conclusão de cada escrita;
- detectar `gattserverdisconnected`, limpar referências GATT obsoletas e iniciar reconexão com backoff limitado;
- cancelar/pausar novas escritas enquanto a conexão estiver indisponível, preservando o trabalho na fila segundo o mesmo contrato de falha do Hub;
- emitir eventos de estado para o processo principal e para a tela de configuração.

O bridge não terá conhecimento de pedidos, Supabase ou regras de setor. Ele receberá somente destino e bytes já resolvidos pelo `PrinterManager`.

#### Adaptador de transporte

O bridge deverá depender de um adaptador injetável, para separar a política do Hub da API Web Bluetooth do Electron:

```ts
interface BleTransport {
  requestDevice(options: BleRequestOptions): Promise<BleDeviceDescriptor>;
  getAuthorizedDevices(): Promise<BleDeviceDescriptor[]>;
  connect(deviceId: string): Promise<BleConnection>;
  disconnect(deviceId: string): Promise<void>;
  onDisconnect(listener: (deviceId: string) => void): () => void;
}

interface BleConnection {
  deviceId: string;
  deviceName?: string;
  serviceUuid: string;
  characteristicUuid: string;
  write(data: Uint8Array, mode: 'with-response' | 'without-response'): Promise<void>;
  close(): Promise<void>;
}
```

O nome dos tipos é ilustrativo; o contrato final deverá ser equivalente e ficar em um módulo comum testável. O adapter real encaminhará chamadas para o runtime Web Bluetooth. O adapter mock permitirá testar filas, reconexão e falhas sem hardware.

### 2. Integração com `PrinterManager`

O `PrinterManager` continuará sendo a única porta de entrada de impressão. Um destino BLE será normalizado como `type: 'bluetooth'`, com um ID estável do Hub e propriedades como nome, `deviceId`, status e capacidades de escrita.

As mudanças previstas são aditivas:

- `getPrinters()` inclui os destinos BLE configurados/descobertos;
- `print()` delega `rawContent` ao bridge BLE sem alterar os caminhos USB e rede;
- `testPrint()` usa um recibo curto e identificável para o dispositivo BLE;
- falhas do bridge retornam erros operacionais claros ao WebSocket e à UI;
- o inventário mantém `type`, `status` e `isManual` suficientes para o renderer e para o mapeamento de rotas.

O WebSocket existente continuará usando os comandos `print`, `print-raw`, `test`, `list-printers` e `sync-printers`. Não será criado um novo protocolo de jobs.

### 3. Runtime oculto e IPC

O processo principal deverá criar um `BrowserWindow`/`WebContents` dedicado ao runtime Bluetooth mesmo quando o Hub iniciar com `--hidden`. Esse runtime não será uma nova janela operacional para o usuário; sua função será manter o contexto Web Bluetooth durante a vida do Hub.

O preload deverá expor apenas uma API mínima para:

- iniciar descoberta explícita;
- selecionar/autorizar um dispositivo;
- conectar, desconectar e testar;
- enviar chunks de bytes solicitados pelo processo principal;
- receber eventos de conexão, erro e conclusão de escrita.

O renderer de configuração exibirá o estado e os controles, mas não terá acesso Node.js. A comunicação entre processo principal, renderer visível e runtime BLE usará IPC validado, sem expor credenciais ou comandos arbitrários.

#### Eventos IPC mínimos

Os nomes podem ser ajustados durante a implementação, mas o contrato deverá cobrir:

```text
bluetooth:list-authorized
bluetooth:request-device
bluetooth:configure
bluetooth:connect
bluetooth:disconnect
bluetooth:test
bluetooth:get-status
bluetooth:status-changed
```

Payloads de entrada deverão ser validados no processo principal. Nenhum IPC deverá aceitar JavaScript, caminho de arquivo arbitrário ou comando de shell. O teste de impressão receberá somente o `printerId` do inventário e será formatado pelo Hub.

### 4. Pareamento e persistência

O Hub deverá tratar a primeira descoberta como ação iniciada pelo usuário na tela de configuração. A seleção do dispositivo será capturada no processo principal conforme o fluxo Web Bluetooth do Electron; no Windows, o handler de pareamento será configurado somente para completar o pareamento solicitado pelo Hub.

Serão persistidos em `settings.json`, sob o `userData` do Hub, somente os metadados necessários para reidentificar o destino e reconstruir a conexão, incluindo:

- `printerId` estável do Hub;
- `deviceId` e nome apresentado;
- serviço/characteristic escolhido, quando conhecido;
- parâmetros de chunk/write e rota atribuída;
- último estado conhecido e timestamp operacional, sem tratar isso como prova de conexão atual.

Formato lógico esperado, preservando compatibilidade com configurações existentes:

```json
{
  "bluetoothPrinters": [
    {
      "id": "bluetooth-<stable-id>",
      "deviceId": "<electron-device-id>",
      "name": "<display-name>",
      "serviceUuid": "<uuid>",
      "characteristicUuid": "<uuid>",
      "writeMode": "without-response",
      "chunkSize": 20,
      "chunkDelayMs": 30,
      "reconnect": {
        "maxAttempts": 5,
        "backoffMs": [1000, 2000, 5000, 10000, 30000]
      },
      "lastKnownState": "disconnected",
      "lastConnectedAt": null,
      "lastErrorAt": null
    }
  ]
}
```

Os valores padrão deverão ser centralizados e normalizados. Não armazenar endereço MAC se a API não o fornecer de forma estável; usar o identificador autorizado retornado pelo runtime. A migração deverá tolerar ausência do campo e configurações antigas sem `bluetoothPrinters`.

Na inicialização, o runtime tentará recuperar os dispositivos autorizados. Se a permissão tiver sido revogada, o dispositivo tiver mudado de identidade ou o sistema não permitir recuperação silenciosa, a UI deverá orientar um novo pareamento. A reconexão normal não deve exigir que o usuário repita o fluxo de descoberta a cada impressão.

### 4.1 Descoberta de GATT

A descoberta automática deverá considerar somente characteristics com `write` ou `writeWithoutResponse`. O fluxo deverá:

1. selecionar o dispositivo autorizado;
2. conectar ao GATT;
3. enumerar os serviços primários;
4. enumerar as characteristics de cada serviço;
5. escolher a característica configurada, quando ela ainda existir;
6. caso não exista, escolher uma única característica de escrita compatível;
7. persistir a escolha e informar o serviço/characteristic na UI.

Se houver mais de uma característica de escrita possível, não escolher silenciosamente uma opção ambígua. A UI deverá permitir selecionar a característica e salvar o resultado. Também deverá existir configuração manual para impressoras que exigem UUIDs específicos.

### 5. Reconexão e ciclo de vida do Windows

O bridge iniciará reconexão com backoff e limite de tentativas, evitando loop agressivo quando a impressora estiver desligada. Ao voltar de `resume`, `unlock-screen` ou `user-did-become-active`, o Hub chamará a mesma rotina de recuperação já usada para as outras impressoras e solicitará reconexão BLE dos destinos configurados.

Quando não houver conexão, trabalhos ainda não iniciados poderão aguardar uma janela curta de reconexão. Ao exceder o limite, o trabalho será marcado como falho e ficará sujeito ao mecanismo operacional existente do Hub, com mensagem indicando que o dispositivo BLE está indisponível.

Não haverá retry automático do buffer inteiro depois de uma escrita parcial cujo resultado físico seja desconhecido. Como ESC/POS não fornece confirmação universal de que o recibo inteiro foi impresso, o bridge deverá distinguir:

- falha antes de aceitar o primeiro chunk: seguro para tentar novamente;
- falha após aceitar qualquer chunk: resultado incerto, sem reenvio automático do recibo completo; registrar o job como incerto/falho e pedir ação operacional.

Essa regra evita transformar uma reconexão em duplicação silenciosa de pedidos.

### 5.1 Máquina de estados

Cada impressora deverá seguir uma máquina de estados explícita:

```text
disconnected
    └─ connect requested → connecting
connecting
    ├─ success → connected
    ├─ temporary failure → reconnecting
    └─ permission/configuration failure → error
connected
    ├─ job accepted → printing
    └─ GATT disconnected → reconnecting
printing
    ├─ all chunks written → connected
    ├─ failure before first chunk → reconnecting
    └─ failure after first chunk → error/uncertain
reconnecting
    ├─ success → connected
    ├─ attempts remaining → reconnecting
    └─ limit exceeded → error
error
    ├─ user retry → connecting
    └─ user reconfigure → disconnected
```

O status mostrado ao operador deverá derivar dessa máquina, e não apenas da existência de configuração persistida.

### 6. Rotas, autoimpressão e duplicidade

O Hub continuará recebendo o trabalho pelo WebSocket local existente. Depois de um BLE ser configurado como uma impressora local do Hub, o `sync-printers` existente poderá mapear o ID/nome para `default`, `counter`, `kitchen`, `delivery`, `bar` ou `autoPrint` sem criar uma nova semântica de rota.

O vínculo pareado/ownership atual continuará decidindo qual runtime imprime. Não será adicionado listener alternativo no Hub nem uma segunda execução automática no navegador. A resposta de sucesso/falha seguirá o caminho existente para manter observabilidade e deduplicação.

O caminho de Bluetooth direto do navegador, quando usado por clientes compatíveis fora do Hub, permanece como fallback independente. A nova capacidade do Hub será selecionada como destino local quando o Hub estiver conectado.

### 6.1 Contrato com o navegador

Quando o Hub estiver pareado, ativo e com `controlsAutoPrint: true`, o navegador deverá continuar obedecendo ao contrato existente: não montar/executar o auto-print duplicado. A configuração de impressora BLE será sincronizada como destino local do Hub, mas os bytes serão enviados pelo WebSocket existente.

Quando o Hub não estiver pareado, inativo ou não for o dono da autoimpressão, o caminho atual do navegador poderá continuar usando Web Bluetooth direto. Essa transição deverá ser observável no status de pairing para que o operador saiba qual processo é o executor.

Não alterar o nome das rotas existentes (`default`, `counter`, `kitchen`, `delivery`, `bar`, `autoPrint`) nem criar uma rota paralela chamada `bluetooth`.

## Contratos de erro e observabilidade

Cada transição BLE deverá registrar, com o `printerId` e sem dados sensíveis:

- tentativa de conexão e motivo da tentativa;
- descoberta/seleção do serviço e characteristic;
- desconexão e número da tentativa de recuperação;
- início, conclusão ou falha de cada job;
- distinção entre falha segura para retry e resultado físico incerto.

A UI deverá mostrar pelo menos nome, tipo BLE, estado atual, última tentativa e instrução de recuperação. O estado “configurado” não poderá ser apresentado como “conectado” sem uma verificação viva.

Logs de uma mesma impressão deverão carregar um identificador de correlação já existente no job, quando disponível, além do `printerId`. O log não deverá registrar o conteúdo completo do pedido nem dados pessoais. Para erro após escrita parcial, usar uma mensagem explícita como “resultado físico incerto; conferir a impressora antes de reimprimir”.

## Segurança e permissões

- A descoberta BLE somente poderá começar por ação explícita na UI do Hub.
- O handler `select-bluetooth-device` deverá restringir a seleção ao dispositivo solicitado pelo fluxo atual; não aceitar automaticamente qualquer dispositivo encontrado.
- O pairing handler deverá responder apenas enquanto houver uma solicitação ativa de pareamento.
- O runtime BLE deverá usar `contextIsolation: true`, `nodeIntegration: false` e preload mínimo.
- IDs de dispositivo, UUIDs e configurações deverão ser validados antes de entrar no `settings.json`.
- A conexão BLE não deverá abrir portas TCP adicionais nem expor o GATT pelo WebSocket público/local.
- Os comandos de impressão continuarão sujeitos à autenticação/token e ownership do WebSocket atual.

## Plano de testes

### Testes automatizados

- normalização e persistência de destinos BLE;
- seleção de service/characteristic e capacidades de escrita;
- chunking de buffers ESC/POS;
- serialização de dois jobs para a mesma impressora;
- backoff, limite de reconexão e transições de estado;
- erro antes do primeiro chunk versus erro após escrita parcial;
- integração do `PrinterManager` e do WebSocket com `type: 'bluetooth'`;
- regressão dos caminhos USB, rede, rotas e `sync-printers`.
- validação do renderer oculto em modo normal e `--hidden`;
- validação de IPC rejeitando payloads inválidos e comandos fora da lista;
- compatibilidade de leitura/escrita das configurações antigas sem `bluetoothPrinters`.

### Validação no Windows

1. Parear uma impressora BLE pela UI do Hub.
2. Fechar/reabrir o Hub e confirmar tentativa de reconexão sem novo pareamento.
3. Iniciar o Hub com `--hidden` e confirmar que o runtime continua ativo.
4. Minimizar/ocultar o Hub, abrir outra aplicação e enviar uma impressão automática.
5. Bloquear e desbloquear a tela e repetir a impressão.
6. Desligar a impressora ou afastá-la, confirmar backoff e mensagem operacional, depois retorná-la ao alcance e confirmar recuperação.
7. Enviar dois trabalhos seguidos e confirmar ordem e uma única cópia física de cada um.
8. Repetir smoke tests com USB e rede para comprovar que os destinos atuais não foram alterados.

### Matriz mínima de cenários

| Cenário | Executor esperado | Resultado |
| --- | --- | --- |
| Hub pareado e dono da autoimpressão | Hub → WebSocket → BLE | Uma impressão |
| Hub indisponível, navegador em `bluetooth` | Navegador → Web Bluetooth | Fallback funcional |
| Hub pareado, navegador aberto em outra aba | Hub → WebSocket → BLE | Não depender da aba |
| Impressora fora de alcance antes do job | Hub com backoff | Falha clara ou recuperação |
| Falha no primeiro chunk | Hub | Retry permitido |
| Falha após chunk aceito | Hub | Resultado incerto, sem retry integral |
| Impressora USB existente | Hub → Spooler | Sem regressão |
| Impressora de rede existente | Hub → TCP/CUPS | Sem regressão |

A build pode ser gerada localmente em macOS, mas a prova de BLE, bloqueio de tela, driver e papel precisa ser executada em uma máquina Windows real com a impressora física. Build verde não será tratado como prova de impressão física.

## Critérios de aceite

- Uma impressora BLE pareada uma vez aparece no Hub após reinício e tenta reconectar automaticamente.
- Com o Hub residente/oculto, o navegador minimizado, outra aplicação aberta ou a tela bloqueada não interrompem, por si só, o recebimento e o envio do job ao BLE.
- A autoimpressão usa o mesmo job, rota e proteção de duplicidade existentes.
- Desconexões são recuperadas com backoff e sem loop agressivo.
- Falha parcial não reenvia cegamente um recibo completo.
- USB e rede continuam funcionando.
- A nova build instalável do Hub é gerada após os gates automatizados; a validação física Windows permanece registrada separadamente.
- O status da instalação identifica a versão da nova build e permite confirmar se o runtime BLE está presente.

## Sequência de implementação

1. Criar o bridge BLE e o adaptador mockável.
2. Criar o runtime oculto, preload/IPC e seleção de dispositivo.
3. Integrar o bridge ao `PrinterManager`, configurações e inventário.
4. Adicionar UI de descoberta, status, configuração de characteristic e teste.
5. Integrar recuperação no ciclo de vida já existente e adicionar testes.
6. Executar gates do Hub, gerar a nova build e preparar o roteiro de validação física Windows.

## Gates de build e entrega

Antes de gerar o instalador:

1. executar os testes focados do bridge, IPC, `PrinterManager` e WebSocket;
2. executar os testes de regressão já existentes do Hub;
3. executar `git diff --check` no conjunto da alteração;
4. executar o build do renderer/main e o empacotamento Windows configurado no `package.json`;
5. inspecionar os artefatos NSIS x64/ia32 e o conteúdo do runtime BLE no pacote;
6. iniciar a aplicação empacotada em modo normal e `--hidden`;
7. registrar separadamente o resultado do teste físico em Windows.

Não publicar, instalar em clientes, substituir artefatos hospedados ou executar uma impressão física em loja sem autorização específica para essa etapa. A build local e a prova física são gates diferentes.

## Riscos conhecidos e decisões de fallback

### Permissão Web Bluetooth não recuperável

O Hub deverá exibir “reautorizar impressora” e abrir o fluxo de descoberta. Não tentar contornar a permissão com varredura indiscriminada.

### Impressora BLE sem característica de escrita detectável

O dispositivo permanece configurado como erro e a UI solicita UUIDs manuais. Não enviar bytes para uma característica somente de leitura/notificação.

### Queda durante o job

Aplicar a regra de incerteza física descrita acima. O operador poderá fazer uma reimpressão manual após conferir a impressora; a ação manual não deve reutilizar automaticamente o ledger como se o primeiro job não tivesse existido.

### Hub iniciado em `--hidden` antes do primeiro pareamento

O Hub inicia o runtime, mas não abre descoberta silenciosa. A configuração inicial exige abrir a janela pelo tray e realizar ação explícita.

### Windows bloqueado

O processo residente deve continuar recebendo e enfileirando jobs. A escrita BLE será tentada conforme o runtime e o driver permitirem; se o Windows interromper o transporte, o Hub deve marcar desconexão e recuperar após o desbloqueio. O teste físico de tela bloqueada é obrigatório e não pode ser substituído por teste unitário.

Esta especificação registra o desenho aprovado. Nenhum código ou build será alterado até a revisão desta especificação pelo usuário.
