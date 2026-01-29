const API_URL = 'http://127.0.0.1:3001/api';

let allPrinters = [];

// --- UI Helpers ---

function showStatus(message, type = 'info') {
    const statusEl = document.getElementById('settings-status');
    if (statusEl) {
        statusEl.textContent = message;
        statusEl.className = `status-message ${type}`;
        // Auto-clear success messages after 3s
        if (type === 'success') {
            setTimeout(() => {
                statusEl.textContent = '';
                statusEl.className = 'status-message';
            }, 3000);
        }
    }
    addLog(message, type);
}

function addLog(message, type = 'info') {
    const logsContainer = document.getElementById('dashboard-logs');
    const fullLogsContainer = document.getElementById('full-logs');
    const time = new Date().toLocaleTimeString();

    const logHTML = `
    <div class="log-item ${type}">
      <span class="time">[${time}]</span>
      <span class="message">${message}</span>
    </div>
  `;

    if (logsContainer) {
        // Remove empty state if present
        const emptyState = logsContainer.querySelector('.empty-state');
        if (emptyState) emptyState.remove();

        logsContainer.insertAdjacentHTML('afterbegin', logHTML);
        // Keep only last 10 logs on dashboard
        if (logsContainer.children.length > 10) logsContainer.lastElementChild.remove();
    }

    if (fullLogsContainer) {
        fullLogsContainer.insertAdjacentHTML('beforeend', logHTML);
        fullLogsContainer.scrollTop = fullLogsContainer.scrollHeight;
    }
}

// --- Printer Management ---

async function loadPrinters() {
    const list = document.getElementById('printer-list');
    if (list) list.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Atualizando impressoras...</p>
    </div>
  `;

    try {
        const res = await fetch(`${API_URL}/printers`);

        // Check for HTTP errors
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Servidor respondeu com ${res.status}: ${text.substring(0, 100)}...`);
        }

        const data = await res.json();

        if (data.success) {
            allPrinters = data.printers;
            updatePrinterCount(allPrinters.length);
            renderPrinters(allPrinters);
            populateTestSelect(allPrinters);
            addLog(`${allPrinters.length} impressora(s) detectada(s)`, 'success');
        } else {
            throw new Error('Falha na resposta da API');
        }
    } catch (error) {
        console.error('Erro ao carregar impressoras:', error);
        showStatus(`Erro: ${error.message}`, 'error');
        if (list) list.innerHTML = `<div class="empty-state">Erro: ${error.message}</div>`;
    }
}

function updatePrinterCount(count) {
    const el = document.getElementById('printer-count');
    if (el) {
        el.textContent = count;
        // Animate the number change
        el.classList.add('updated');
        setTimeout(() => el.classList.remove('updated'), 300);
    }
}

function renderPrinters(printers) {
    const list = document.getElementById('printer-list');
    if (!list) return;

    if (printers.length === 0) {
        list.innerHTML = '<div class="empty-state">Nenhuma impressora encontrada</div>';
        return;
    }

    list.innerHTML = printers.map(p => `
    <div class="printer-card">
      <div class="printer-icon">🖨️</div>
      <div class="printer-info">
        <div class="printer-name">${p.name}</div>
        <div class="printer-meta">
          <span class="printer-type">${p.type || 'RAW'}</span>
          ${p.isDefault ? '<span class="badge">Padrão</span>' : ''}
        </div>
      </div>
      <div class="printer-actions" style="margin-top: 1rem;">
        <button class="btn-secondary" style="width: 100%; justify-content: center;" onclick="testPrinterById('${p.id.replace(/'/g, "\\'")}')">
          🧪 Testar
        </button>
      </div>
    </div>
  `).join('');
}

function populateTestSelect(printers) {
    const select = document.getElementById('test-printer');
    if (!select) return;

    const options = printers.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    select.innerHTML = '<option value="">Selecione uma impressora...</option>' + options;
}

// --- Actions ---

async function testPrint() {
    const select = document.getElementById('test-printer');
    const printerId = select.value;

    if (!printerId) {
        showStatus('Selecione uma impressora para testar', 'warning');
        return;
    }

    await testPrinterById(printerId);
}

async function testPrinterById(printerId) {
    try {
        showStatus(`Enviando teste para impressora...`, 'info');

        const res = await fetch(`${API_URL}/printers/${printerId}/test`, {
            method: 'POST'
        });

        const data = await res.json();

        if (data.success) {
            showStatus('Teste enviado com sucesso!', 'success');
        } else {
            showStatus(`Erro: ${data.error}`, 'error');
        }
    } catch (error) {
        console.error('Erro no teste:', error);
        showStatus('Erro de comunicação com o servidor', 'error');
    }
}

// --- Navigation ---

function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    const views = document.querySelectorAll('.view');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const targetId = item.dataset.tab;

            // Update nav state
            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');

            // Update view state
            views.forEach(view => view.classList.remove('active'));
            const targetView = document.getElementById(targetId);
            if (targetView) targetView.classList.add('active');

            // Refresh data if switching to printers tab
            if (targetId === 'printers') loadPrinters();
        });
    });
}

// --- Initialization ---

async function checkServerStatus() {
    try {
        await fetch(API_URL.replace('/api', '')); // Ping root
        document.querySelector('.status-badge').className = 'status-badge online';
        document.querySelector('.status-badge').innerHTML = '<span class="pulse"></span> Sistema Online';
    } catch (e) {
        document.querySelector('.status-badge').className = 'status-badge offline';
        document.querySelector('.status-badge').innerHTML = '<span class="dot" style="background:red"></span> Offline';
        addLog('Servidor desconectado', 'error');
    }
}

window.addEventListener('DOMContentLoaded', () => {
    setupNavigation();

    document.getElementById('refresh-printers')?.addEventListener('click', loadPrinters);

    // Initial load
    loadPrinters();
    checkServerStatus();

    // Polling for status check (every 30s)
    setInterval(checkServerStatus, 30000);
});
