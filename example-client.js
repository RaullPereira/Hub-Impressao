/**
 * Cliente de Exemplo para Impressão via WebSocket Seguro
 * 
 * Para usar no seu sistema de pedidos:
 * 1. Copie este código para um módulo no seu projeto
 * 2. Substitua 'SEU_TOKEN_AQUI' pelo token gerado pelo serviço
 * 3. Chame ThermalPrintClient.print(orderData) ao imprimir pedidos
 */

class ThermalPrintClient {
  constructor() {
    this.ws = null;
    this.token = 'SEU_TOKEN_AQUI'; // Substituir pelo token gerado
    this.reconnectInterval = null;
    this.isConnected = false;
  }

  /**
   * Conecta ao serviço de impressão
   */
  connect() {
    return new Promise((resolve, reject) => {
      try {
        // Conectar ao WebSocket seguro
        this.ws = new WebSocket('wss://localhost:3002');

        this.ws.onopen = () => {
          console.log('✅ Conectado ao serviço de impressão');
          this.isConnected = true;
          this.stopReconnect();
          resolve();
        };

        this.ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          console.log('📨 Mensagem do serviço:', data);
          
          if (data.type === 'connected') {
            console.log(`📡 Serviço versão ${data.version}`);
          }
        };

        this.ws.onerror = (error) => {
          console.error('❌ Erro no WebSocket:', error);
          this.isConnected = false;
        };

        this.ws.onclose = () => {
          console.log('🔌 Desconectado do serviço de impressão');
          this.isConnected = false;
          this.tryReconnect();
        };

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Tenta reconectar automaticamente
   */
  tryReconnect() {
    if (this.reconnectInterval) return;
    
    console.log('🔄 Tentando reconectar em 5 segundos...');
    this.reconnectInterval = setInterval(() => {
      console.log('🔄 Reconectando...');
      this.connect().catch(() => {});
    }, 5000);
  }

  /**
   * Para tentativas de reconexão
   */
  stopReconnect() {
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }
  }

  /**
   * Define o token de segurança
   */
  setToken(token) {
    this.token = token;
  }

  /**
   * Envia comando de impressão
   */
  async print(orderData, printerId = null, printType = 'counter') {
    if (!this.isConnected) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      const message = {
        type: 'print',
        token: this.token,
        orderData,
        printerId,
        printType
      };

      // Aguardar resposta
      const messageHandler = (event) => {
        const response = JSON.parse(event.data);
        if (response.success !== undefined) {
          this.ws.removeEventListener('message', messageHandler);
          if (response.success) {
            resolve(response);
          } else {
            reject(new Error(response.error || 'Erro ao imprimir'));
          }
        }
      };

      this.ws.addEventListener('message', messageHandler);
      
      // Enviar comando
      this.ws.send(JSON.stringify(message));

      // Timeout de 10 segundos
      setTimeout(() => {
        this.ws.removeEventListener('message', messageHandler);
        reject(new Error('Timeout ao imprimir'));
      }, 10000);
    });
  }

  /**
   * Teste de impressão
   */
  async testPrint(printerId) {
    if (!this.isConnected) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      const message = {
        type: 'test',
        token: this.token,
        printerId
      };

      const messageHandler = (event) => {
        const response = JSON.parse(event.data);
        if (response.success !== undefined) {
          this.ws.removeEventListener('message', messageHandler);
          if (response.success) {
            resolve(response);
          } else {
            reject(new Error(response.error || 'Erro no teste'));
          }
        }
      };

      this.ws.addEventListener('message', messageHandler);
      this.ws.send(JSON.stringify(message));

      setTimeout(() => {
        this.ws.removeEventListener('message', messageHandler);
        reject(new Error('Timeout no teste'));
      }, 10000);
    });
  }

  /**
   * Lista impressoras disponíveis
   */
  async listPrinters() {
    if (!this.isConnected) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      const message = {
        type: 'list-printers',
        token: this.token
      };

      const messageHandler = (event) => {
        const response = JSON.parse(event.data);
        if (response.printers !== undefined) {
          this.ws.removeEventListener('message', messageHandler);
          if (response.success) {
            resolve(response.printers);
          } else {
            reject(new Error(response.error || 'Erro ao listar impressoras'));
          }
        }
      };

      this.ws.addEventListener('message', messageHandler);
      this.ws.send(JSON.stringify(message));

      setTimeout(() => {
        this.ws.removeEventListener('message', messageHandler);
        reject(new Error('Timeout ao listar impressoras'));
      }, 10000);
    });
  }

  /**
   * Desconecta do serviço
   */
  disconnect() {
    this.stopReconnect();
    if (this.ws) {
      this.ws.close();
    }
  }
}

// Exportar como módulo (Node.js/CommonJS)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ThermalPrintClient;
}

// Exportar como variável global (navegador)
if (typeof window !== 'undefined') {
  window.ThermalPrintClient = ThermalPrintClient;
}

/**
 * EXEMPLO DE USO NO SEU SISTEMA DE PEDIDOS:
 * 
 * // 1. Criar instância do cliente
 * const printClient = new ThermalPrintClient();
 * 
 * // 2. Definir token (pegar do serviço de impressão)
 * printClient.setToken('TOKEN_GERADO_PELO_SERVICO');
 * 
 * // 3. Conectar
 * await printClient.connect();
 * 
 * // 4. Imprimir pedido
 * const orderData = {
 *   order_number: '001',
 *   customer_name: 'João Silva',
 *   items: [
 *     { quantity: 2, product_name: 'Pizza Margherita', total_price: 70.00 }
 *   ],
 *   total: 70.00
 * };
 * 
 * await printClient.print(orderData);
 * 
 * // 5. Ou usar no seu componente React:
 * const handlePrintViaService = async (e) => {
 *   e.stopPropagation();
 *   try {
 *     await printClient.print(orderData);
 *     toast.success('Pedido enviado para impressão!');
 *   } catch (error) {
 *     toast.error('Erro ao imprimir', { description: error.message });
 *   }
 * };
 */
