# Thermal Print Service - WebSocket Seguro (WSS)

## ✅ O que foi implementado

### 1. Servidor WebSocket Seguro (WSS)
- Servidor rodando em `wss://localhost:3002`
- Certificado SSL auto-assinado para localhost
- Comunicação criptografada entre navegador e serviço

### 2. Autenticação por Token
- Token único gerado a cada inicialização
- Validação de todas as requisições
- Proteção contra sites maliciosos

### 3. API WebSocket

#### Comandos disponíveis:

**Imprimir Pedido:**
```json
{
  "type": "print",
  "token": "SEU_TOKEN",
  "orderData": { /* dados do pedido */ },
  "printerId": "cups-NOME_IMPRESSORA" (opcional),
  "printType": "counter|kitchen|both" (opcional)
}
```

**Teste de Impressão:**
```json
{
  "type": "test",
  "token": "SEU_TOKEN",
  "printerId": "cups-NOME_IMPRESSORA"
}
```

**Listar Impressoras:**
```json
{
  "type": "list-printers",
  "token": "SEU_TOKEN"
}
```

## 🚀 Como Usar

### 1. Iniciar o Serviço

```bash
npm start
```

O token de segurança será exibido no console:
```
Token WebSocket: abc123...xyz789
```

### 2. Configurar no Navegador

#### Opção A: Cliente JavaScript (Recomendado)

Copie o arquivo `example-client.js` para o seu projeto e use:

```javascript
import ThermalPrintClient from './thermal-print-client';

const printClient = new ThermalPrintClient();
printClient.setToken('TOKEN_DO_SERVICO');

// Conectar
await printClient.connect();

// Imprimir
await printClient.print(orderData);
```

#### Opção B: WebSocket Nativo

```javascript
const ws = new WebSocket('wss://localhost:3002');

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'print',
    token: 'TOKEN_DO_SERVICO',
    orderData: {
      order_number: '001',
      customer_name: 'João Silva',
      items: [{ quantity: 2, product_name: 'Pizza', total_price: 70 }],
      total: 70
    }
  }));
};

ws.onmessage = (event) => {
  const response = JSON.parse(event.data);
  if (response.success) {
    console.log('Impresso com sucesso!');
  }
};
```

### 3. Integrar no OrderKanbanCard

```tsx
import ThermalPrintClient from '../utils/thermal-print-client';

// Criar instância global ou no contexto
const printClient = new ThermalPrintClient();
printClient.setToken('TOKEN_DO_SERVICO');
printClient.connect();

// No componente
const handlePrintViaWebSocket = async (e: React.MouseEvent) => {
  e.stopPropagation();
  try {
    await printClient.print(orderData);
    toast.success('Pedido enviado para impressão!');
  } catch (error) {
    toast.error('Erro ao imprimir', { description: error.message });
  }
};

// No JSX
<Button onClick={handlePrintViaWebSocket}>
  Imprimir via Serviço
</Button>
```

## 🔐 Certificado SSL

### Por que é necessário?

Sites HTTPS só podem conectar a WebSockets seguros (WSS). O certificado SSL auto-assinado permite essa conexão.

### Como confiar no certificado (Desenvolvimento)

#### macOS:
```bash
# Adicionar certificado ao Keychain
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/Library/Application\ Support/thermal-print-service/certs/server-cert.pem
```

#### Windows:
```powershell
# Adicionar ao Trusted Root
certutil -addstore "Root" %APPDATA%\thermal-print-service\certs\server-cert.pem
```

#### Linux:
```bash
# Copiar certificado
sudo cp ~/.config/thermal-print-service/certs/server-cert.pem /usr/local/share/ca-certificates/thermal-print.crt
sudo update-ca-certificates
```

### Para Produção

Para distribuir o app para clientes, você deve:

1. **Criar instalador que adiciona o certificado automaticamente**
   - Windows: Script PowerShell no instalador NSIS
   - Mac: Script bash no instalador PKG/DMG
   
2. **Ou obter certificado válido para localhost** (não recomendado por custo)

## 📦 Build e Distribuição

### Criar instalador:

```bash
# macOS
npm run build:mac

# Windows (requer Wine no Mac)
npm run build:win
```

### Adicionar scripts de instalação de certificado

Veja a pasta `/installers` para exemplos de scripts que:
- Instalam o certificado no sistema
- Configuram auto-start
- Criam atalhos

## 🔧 Próximos Passos

### Tarefas Pendentes:

1. ✅ Servidor WebSocket Seguro (WSS) - IMPLEMENTADO
2. ✅ Autenticação por Token - IMPLEMENTADO
3. ⏳ UI para exibir/copiar token
4. ⏳ System Tray com menu de contexto
5. ⏳ Auto-start no boot do sistema
6. ⏳ Scripts de instalação de certificado
7. ⏳ Assinatura digital (Code Signing)

## ⚠️ Aviso de Segurança

O certificado SSL auto-assinado é **apenas para desenvolvimento/uso local**.

Para distribuir para clientes:
- Adicione scripts de instalação que registram o certificado como confiável
- Considere usar mDNS (.local) se não puder registrar o certificado
- Ou use electron-builder com código assinado + notarização (macOS)

## 🐛 Troubleshooting

### Erro: "Certificate not trusted"
- Execute o comando de instalação de certificado para o seu OS
- Reinicie o navegador

### Erro: "Connection refused"
- Verifique se o serviço está rodando (`npm start`)
- Confirme a porta (3002 por padrão)

### Erro: "Invalid token"
- Copie o token exibido no console do serviço
- Atualize o token no cliente JavaScript

## 📞 Suporte

Para dúvidas ou problemas, consulte os logs em:
- macOS: `~/Library/Logs/thermal-print-service/`
- Windows: `%APPDATA%\thermal-print-service\logs\`
- Linux: `~/.config/thermal-print-service/logs/`
