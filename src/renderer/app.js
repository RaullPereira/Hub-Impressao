const API_URL = 'http://localhost:3001/api';

let allPrinters = [];

// Funções auxiliares
function showMessage(message, type = 'info') {
  const statusEl = document.getElementById('settings-status');
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.className = `status-message ${type}`;
    setTimeout(() => {
      statusEl.textContent = '';
      statusEl.className = 'status-message';
    }, 3000);
  }
  addLog(message);
}

function addLog(message) {
  const logs = document.getElementById('logs');
  if (!logs) return;
  
  const entry = document.createElement('p');
  entry.className = 'log-entry';
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logs.insertBefore(entry, logs.firstChild);
  
  while (logs.children.length > 50) {
    logs.removeChild(logs.lastChild);
  }
}

// Carregar impressoras
async function loadPrinters() {
  try {
    const res = await fetch(`${API_URL}/printers`);
    const data = await res.json();
    
      if (data.success) {
        allPrinters = data.printers;
        updatePrinterCount(allPrinters.length);
        displayPrinters(allPrinters);
        populateTestPrinter(allPrinters);
        addLog(`${allPrinters.length} impressora(s) carregada(s)`);
      }
  } catch (error) {
    console.error('Erro ao carregar impressoras:', error);
    showMessage('Erro ao carregar impressoras', 'error');
  }
}

function updatePrinterCount(count) {
  const el = document.getElementById('printer-count');
  if (el) el.textContent = count;
}

function displayPrinters(printers) {
  const list = document.getElementById('printer-list');
  if (!list) return;
  
  if (printers.length === 0) {
    list.innerHTML = '<p class="empty">Nenhuma impressora encontrada</p>';
    return;
  }
  
  list.innerHTML = printers.map(printer => `
    <div class="printer-item">
      <div class="printer-info">
        <div class="printer-name">
          ${printer.name}
          ${printer.windowsMapping ? `<span class="printer-queue">(mapeado: ${printer.windowsMapping})</span>` : ''}
          ${printer.queueName && printer.queueName !== printer.name ? `<span class="printer-queue">(${printer.queueName})</span>` : ''}
          ${printer.isDefault ? '<span class="badge">Padrão Sistema</span>' : ''}
        </div>
        <div class="printer-type">${printer.type}</div>
      </div>
      <div class="printer-actions">
        <button class="btn btn-small btn-success" onclick="testPrinterById('${printer.id}')">
          🧪 Testar
        </button>
        <button class="btn btn-small btn-primary" onclick="openMapDialog('${printer.id}')">
          🔗 Mapear
        </button>
      </div>
    </div>
  `).join('');
}

// Mapping modal
async function openMapDialog(printerId) {
  try {
    // Buscar impressoras do Windows
    const res = await fetch(`${API_URL}/windows-printers`);
    const data = await res.json();
    if (!data.success) {
      showMessage('Erro ao obter filas do Windows', 'error');
      return;
    }
    const printers = data.printers || [];

    // Criar modal simples
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal">
        <h3>Mapear impressora</h3>
        <p>Selecione a fila do Windows para mapear esta impressora USB:</p>
        <select id="_map_select" class="printer-select">
          ${printers.map(p => `<option value="${p}">${p}</option>`).join('')}
        </select>
        <div style="margin-top:12px; text-align:right;">
          <button id="_map_cancel" class="btn">Cancelar</button>
          <button id="_map_save" class="btn btn-primary">Salvar</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('_map_cancel').addEventListener('click', () => { document.body.removeChild(modal); });
    document.getElementById('_map_save').addEventListener('click', async () => {
      const select = document.getElementById('_map_select');
      const target = select.value;
      try {
        const r = await fetch(`${API_URL}/printers/${encodeURIComponent(printerId)}/map`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ windowsPrinter: target })
        });
        const jr = await r.json();
        if (jr.success) {
          showMessage('Mapeamento salvo', 'success');
          document.body.removeChild(modal);
          loadPrinters();
        } else {
          showMessage('Falha ao salvar mapeamento', 'error');
        }
      } catch (e) {
        console.error(e);
        showMessage('Erro ao salvar mapeamento', 'error');
      }
    });
  } catch (e) {
    console.error('Erro ao abrir diálogo de mapeamento:', e);
    showMessage('Erro ao abrir diálogo de mapeamento', 'error');
  }
}

function populateTestPrinter(printers) {
  const select = document.getElementById('test-printer');
  if (!select) return;
  const options = printers.map(p => `<option value="${p.id}">${p.name}${p.queueName && p.queueName !== p.name ? ` (${p.queueName})` : ''}</option>`).join('');
  select.innerHTML = '<option value="">Selecione uma impressora</option>' + options;
}

// Note: Settings management removed — configuration should be done in the main order system.

// Testar impressão
async function testPrint() {
  const select = document.getElementById('test-printer');
  const printerId = select.value;
  
  if (!printerId) {
    showMessage('⚠️ Selecione uma impressora', 'warning');
    return;
  }
  
  await testPrinterById(printerId);
}

async function testPrinterById(printerId) {
  try {
    showMessage('Enviando teste...', 'info');
    
    const res = await fetch(`${API_URL}/printers/${printerId}/test`, {
      method: 'POST'
    });
    
    const data = await res.json();
    
    if (data.success) {
      showMessage('✅ Teste enviado para impressora!', 'success');
    } else {
      showMessage(`❌ Erro: ${data.error}`, 'error');
    }
  } catch (error) {
    console.error('Erro ao testar impressora:', error);
    showMessage('❌ Erro ao testar impressora', 'error');
  }
}

// Tabs
function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  const contents = document.querySelectorAll('.tab-content');
  
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      
      tabs.forEach(t => t.classList.remove('active'));
      contents.forEach(c => c.classList.remove('active'));
      
      tab.classList.add('active');
      const content = document.getElementById(tabName);
      if (content) content.classList.add('active');
      
          if (tabName === 'printers') loadPrinters();
    });
  });
}

// Botões
function setupButtons() {
  const refreshBtn = document.getElementById('refresh-printers');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadPrinters);
  }
}

// Inicialização
window.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupButtons();
  loadPrinters();
  addLog('Sistema iniciado');
});
