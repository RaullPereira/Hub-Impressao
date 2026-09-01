let refreshInterval = null;
const PRINTER_DISCOVERY_TIMEOUT_MS = 10000;
let lastSettings = null;
let lastPairingStatus = null;
let removeUpdateStatusListener = null;
const AUTO_PRINT_ATTENTION_ERROR_LABELS = {
  spool_uncertain: 'Resultado da impressão incerto',
  network: 'Falha de rede local',
  render: 'Falha ao preparar a via',
  printer_unavailable: 'Sem rota de impressora disponível',
  claim: 'Falha ao reservar a impressão',
  release: 'Falha ao liberar a reserva',
  unknown: 'Ação operacional necessária'
};

document.addEventListener('DOMContentLoaded', () => {
  const textarea = document.getElementById('manual-text');
  if (textarea) {
    textarea.removeAttribute('readonly');
    textarea.removeAttribute('disabled');
  }

  const btnPaste = document.getElementById('btn-paste-clipboard');
  if (btnPaste && textarea && window.api && window.api.readClipboard) {
    btnPaste.addEventListener('click', () => {
      const text = window.api.readClipboard();
      if (text) textarea.value = text;
    });
  }

  const navItems = document.querySelectorAll('.nav-item');
  const views = document.querySelectorAll('.view');

  navItems.forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelector('.nav-item.active')?.classList.remove('active');
      button.classList.add('active');

      const tab = button.dataset.tab;
      views.forEach((view) => view.classList.remove('active'));
      const targetView = document.getElementById(tab);
      if (targetView) targetView.classList.add('active');

      if (tab === 'printers') {
        void loadPrinters();
      }

      if (tab === 'logs') {
        void loadLogs();
      }
    });
  });

  document.getElementById('refresh-printers')?.addEventListener('click', () => {
    void loadPrinters();
  });
  document.getElementById('add-printer')?.addEventListener('click', () => {
    void addManualPrinter();
  });
  document.getElementById('refresh-logs')?.addEventListener('click', () => {
    void loadLogs();
  });
  document.getElementById('log-type')?.addEventListener('change', () => {
    void loadLogs();
  });
  document.getElementById('check-for-updates')?.addEventListener('click', () => {
    void checkForUpdates();
  });
  document.getElementById('install-update-now')?.addEventListener('click', () => {
    void installUpdateNow();
  });

  if (window.api?.onUpdateStatus) {
    removeUpdateStatusListener = window.api.onUpdateStatus(renderUpdateStatus);
  }

  void initializeScreen();

  window.addEventListener('beforeunload', () => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }
    if (removeUpdateStatusListener) {
      removeUpdateStatusListener();
      removeUpdateStatusListener = null;
    }
  });
});

async function initializeScreen() {
  await loadOperationalStatus();
  await loadPrinters();
  await loadDashboardActivity();
  await loadAutoPrintAttention();
  await loadUpdateStatus();

  if (refreshInterval) {
    clearInterval(refreshInterval);
  }

  refreshInterval = setInterval(() => {
    void loadOperationalStatus();
    void loadDashboardActivity();
    void loadAutoPrintAttention();
    const logsView = document.getElementById('logs');
    if (logsView && logsView.classList.contains('active')) {
      void loadLogs();
    }
  }, 20000);
}

function renderUpdateStatus(status = {}) {
  const statusEl = document.getElementById('update-status');
  const installButton = document.getElementById('install-update-now');
  if (!statusEl || !installButton) return;

  const version = status.readyVersion || status.availableVersion || '';
  const labels = {
    idle: 'Hub atualizado. A verificação automática ocorre em segundo plano.',
    checking: 'Verificando atualizações...',
    available: `Atualização ${version} encontrada. Preparando download em segundo plano...`,
    downloading: `Baixando atualização ${version}${Number.isFinite(status.progressPercent) ? ` · ${Math.round(status.progressPercent)}%` : ''}`,
    ready: `Atualização pronta${version ? `: versão ${version}` : ''}. Será instalada ao fechar o Hub.`,
    error: 'Não foi possível verificar agora. O Hub continua operando normalmente.'
  };

  statusEl.textContent = labels[status.state] || labels.idle;
  installButton.hidden = status.state !== 'ready';
  installButton.disabled = status.state !== 'ready';
}

async function loadUpdateStatus() {
  try {
    const status = window.api?.getUpdateStatus
      ? await window.api.getUpdateStatus()
      : { state: 'idle' };
    renderUpdateStatus(status);
  } catch {
    renderUpdateStatus({ state: 'error' });
  }
}

async function checkForUpdates() {
  const button = document.getElementById('check-for-updates');
  if (button) button.disabled = true;
  try {
    const status = await window.api?.checkForUpdates?.();
    if (status) renderUpdateStatus(status);
  } catch {
    renderUpdateStatus({ state: 'error' });
  } finally {
    if (button) button.disabled = false;
  }
}

async function installUpdateNow() {
  const button = document.getElementById('install-update-now');
  if (button) button.disabled = true;
  try {
    await window.api?.installUpdateNow?.();
  } catch {
    renderUpdateStatus({ state: 'error' });
    if (button) button.disabled = false;
  }
}

function getActiveStorePrinters(settings, pairingStatus) {
  const adminClientId = pairingStatus?.adminClientId;
  if (adminClientId && settings?.storePrinters?.[adminClientId]) {
    return settings.storePrinters[adminClientId];
  }

  const firstStorePrinters = settings?.storePrinters && Object.values(settings.storePrinters)[0];
  return firstStorePrinters || settings?.printers || {};
}

function getAttendancePrinter(autoPrint) {
  return autoPrint?.attendance || autoPrint?.counter || autoPrint?.delivery || null;
}

function getPrinterIdentity(printer) {
  return String(printer?.id || printer?.name || '').trim();
}

function samePrinter(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function getPrinterRoleLabels(printer, storePrinters) {
  const id = getPrinterIdentity(printer);
  const autoPrint = storePrinters?.autoPrint || {};
  const attendancePrinter = getAttendancePrinter(autoPrint);
  const labels = [];

  if (samePrinter(id, autoPrint.kitchen)) labels.push('Cozinha');
  if (samePrinter(id, attendancePrinter)) labels.push('Atendimento');
  if (samePrinter(id, autoPrint.bar)) labels.push('Bar/Bebidas');
  if (samePrinter(id, storePrinters?.default)) labels.push('Padrão/manual');
  if (!labels.length && printer?.isDefault) labels.push('Padrão do sistema');
  if (printer?.type) labels.push(printer.type);

  return labels;
}

function renderRouteWarnings(settings, pairingStatus) {
  const panel = document.getElementById('route-warnings');
  if (!panel) return;

  const storePrinters = getActiveStorePrinters(settings, pairingStatus);
  const autoPrint = storePrinters?.autoPrint || null;
  const kitchenPrinter = autoPrint?.kitchen || null;
  const attendancePrinter = getAttendancePrinter(autoPrint);
  const barPrinter = autoPrint?.bar || null;
  const warnings = [];

  if (pairingStatus?.controlsAutoPrint) {
    warnings.push('Hub local controla a autoimpressão desta loja.');
  } else {
    warnings.push('Fallback do navegador pode assumir a autoimpressão se o Hub local não estiver ativo.');
  }

  if (!autoPrint) {
    warnings.push('Modo legado ativo: clientes antigos continuam imprimindo sem reconfiguração.');
  } else {
    warnings.push(`Cozinha: ${kitchenPrinter || 'sem impressora automática configurada'}.`);
    warnings.push(`Atendimento: ${attendancePrinter || 'sem impressora automática configurada'}.`);
    warnings.push(`Bar/Bebidas: ${barPrinter || 'sem impressora automática configurada'}.`);
    warnings.push('Delivery, balcão, salão e retirada usam a mesma rota Atendimento; bebidas usam Bar/Bebidas quando o setor está ativo.');
  }

  if (attendancePrinter && samePrinter(attendancePrinter, storePrinters?.default)) {
    warnings.push('A impressora padrão está configurada dentro da rota Atendimento; ela não imprime Cozinha automaticamente.');
  }

  panel.innerHTML = `
    <div class="route-panel-title">Rotas de impressão</div>
    <div class="route-panel-body">
      ${warnings.map((entry) => `<div class="route-line">${escapeHtml(entry)}</div>`).join('')}
    </div>
  `;
}

function formatAttentionTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Horário indisponível';
  return date.toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function getAttentionOrderLabel(intent) {
  const orderNumber = intent?.orders?.order_number;
  return orderNumber === null || orderNumber === undefined || orderNumber === ''
    ? 'Pedido sem número'
    : `Pedido #${String(orderNumber).slice(0, 12)}`;
}

function getAttentionErrorLabel(intent) {
  const code = String(intent?.attention_reason || intent?.last_error || 'unknown').trim().toLowerCase();
  return AUTO_PRINT_ATTENTION_ERROR_LABELS[code] || AUTO_PRINT_ATTENTION_ERROR_LABELS.unknown;
}

function renderAutoPrintAttention(intents) {
  const panel = document.getElementById('auto-print-attention');
  if (!panel) return;

  panel.replaceChildren();
  const title = document.createElement('div');
  title.className = 'route-panel-title';
  title.textContent = 'Atenção na autoimpressão';
  panel.appendChild(title);

  const body = document.createElement('div');
  body.className = 'route-panel-body auto-print-attention-body';
  if (!Array.isArray(intents) || intents.length === 0) {
    body.textContent = 'Nenhuma intenção precisa de ação.';
    panel.appendChild(body);
    return;
  }

  intents.forEach((intent) => {
    const item = document.createElement('div');
    item.className = 'auto-print-attention-item';

    const summary = document.createElement('div');
    summary.className = 'auto-print-attention-summary';
    const order = document.createElement('strong');
    order.textContent = getAttentionOrderLabel(intent);
    const meta = document.createElement('span');
    meta.textContent = `${formatAttentionTime(intent.updated_at || intent.created_at)} · ${Math.max(0, Number(intent.attempt_count) || 0)} tentativa(s)`;
    summary.append(order, meta);

    const reason = document.createElement('span');
    reason.className = 'auto-print-attention-reason';
    reason.textContent = getAttentionErrorLabel(intent);

    const actions = document.createElement('div');
    actions.className = 'auto-print-attention-actions';
    const retryButton = document.createElement('button');
    retryButton.type = 'button';
    retryButton.className = 'btn-primary auto-print-attention-retry';
    retryButton.textContent = 'Reimprimir agora';
    retryButton.addEventListener('click', () => resolveAttention(intent, 'retry', actions));
    const dismissButton = document.createElement('button');
    dismissButton.type = 'button';
    dismissButton.className = 'btn-tertiary auto-print-attention-dismiss';
    dismissButton.textContent = 'Dispensar';
    dismissButton.addEventListener('click', () => resolveAttention(intent, 'dismiss', actions));
    actions.append(retryButton, dismissButton);

    item.append(summary, reason, actions);
    body.appendChild(item);
  });

  panel.appendChild(body);
}

async function loadAutoPrintAttention() {
  const panel = document.getElementById('auto-print-attention');
  if (!panel) return;

  if (!window.api?.getAutoPrintAttention) {
    renderAutoPrintAttention([]);
    return;
  }

  try {
    renderAutoPrintAttention(await window.api.getAutoPrintAttention());
  } catch (error) {
    panel.replaceChildren();
    const title = document.createElement('div');
    title.className = 'route-panel-title';
    title.textContent = 'Atenção na autoimpressão';
    const body = document.createElement('div');
    body.className = 'route-panel-body';
    body.textContent = 'Não foi possível carregar as intenções agora.';
    panel.append(title, body);
  }
}

async function resolveAttention(intent, action, actions) {
  const buttons = Array.from(actions.querySelectorAll('button'));
  buttons.forEach((button) => {
    button.disabled = true;
  });

  try {
    if (!window.api?.resolveAutoPrintIntent) throw new Error('Ação indisponível');
    await window.api.resolveAutoPrintIntent(intent.id, action);
    await loadAutoPrintAttention();
  } catch (error) {
    buttons.forEach((button) => {
      button.disabled = false;
    });
    const existing = actions.querySelector('.auto-print-attention-action-error');
    if (existing) existing.remove();
    const message = document.createElement('span');
    message.className = 'auto-print-attention-action-error';
    message.textContent = 'Não foi possível concluir a ação. Tente novamente.';
    actions.appendChild(message);
  }
}

async function loadOperationalStatus() {
  const storeEl = document.getElementById('pairing-store');
  const ownerEl = document.getElementById('auto-owner');
  const routeEl = document.getElementById('route-summary');

  try {
    const [pairingStatus, settings] = await Promise.all([
      window.api.getPairingStatus ? window.api.getPairingStatus() : Promise.resolve(null),
      window.api.getSettings ? window.api.getSettings() : Promise.resolve(null)
    ]);

    lastPairingStatus = pairingStatus;
    lastSettings = settings;

    if (storeEl) {
      storeEl.textContent = pairingStatus?.storeName || pairingStatus?.adminClientId || 'Sem loja';
    }

    if (ownerEl) {
      ownerEl.textContent = pairingStatus?.controlsAutoPrint
        ? 'Hub local'
        : 'Fallback';
    }

    const storePrinters = getActiveStorePrinters(settings, pairingStatus);
    const autoPrint = storePrinters?.autoPrint || null;
    const routeParts = [];
    if (autoPrint?.kitchen) routeParts.push('Cozinha');
    if (getAttendancePrinter(autoPrint)) routeParts.push('Atendimento');
    if (autoPrint?.bar) routeParts.push('Bar/Bebidas');
    if (routeEl) routeEl.textContent = routeParts.length ? routeParts.join(' + ') : 'Modo legado';

    renderRouteWarnings(settings, pairingStatus);
  } catch (error) {
    if (storeEl) storeEl.textContent = 'Indisponível';
    if (ownerEl) ownerEl.textContent = 'Erro';
    if (routeEl) routeEl.textContent = 'Ver logs';
    renderRouteWarnings(null, null);
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setStatus(elementId, message, tone = 'neutral') {
  const element = document.getElementById(elementId);
  if (!element) return;

  element.textContent = message || '';
  element.classList.remove('success', 'error');
  if (tone === 'success' || tone === 'error') {
    element.classList.add(tone);
  }
}

function fillPrinterSelect(select, printers) {
  if (!select) return;

  select.innerHTML = '<option value="">Selecione uma impressora...</option>';
  printers.forEach((printer) => {
    const option = document.createElement('option');
    option.value = printer.id || printer.name;
    option.textContent = printer.type
      ? `${printer.name} (${printer.type})`
      : printer.name;
    select.appendChild(option);
  });
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout ao ${label}`)), timeoutMs);
    })
  ]);
}

async function loadPrinters() {
  const listEl = document.getElementById('printer-list');
  const testSelect = document.getElementById('test-printer');
  const manualSelect = document.getElementById('manual-printer');
  const countEl = document.getElementById('printer-count');

  if (listEl) {
    listEl.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Buscando impressoras...</p></div>';
  }

  try {
    const printers = await withTimeout(
      window.api.getPrinters(),
      PRINTER_DISCOVERY_TIMEOUT_MS,
      'buscar impressoras'
    );
    if (countEl) countEl.textContent = printers && printers.length ? String(printers.length) : '0';

    if (!printers || printers.length === 0) {
      if (listEl) {
        listEl.innerHTML = '<div class="empty-state">Nenhuma impressora encontrada</div>';
      }
      fillPrinterSelect(testSelect, []);
      fillPrinterSelect(manualSelect, []);
      return;
    }

    fillPrinterSelect(testSelect, printers);
    fillPrinterSelect(manualSelect, printers);

    if (listEl) {
      listEl.innerHTML = '';
      const storePrinters = getActiveStorePrinters(lastSettings, lastPairingStatus);

      printers.forEach((printer) => {
        const card = document.createElement('div');
        card.className = 'printer-card';

        const badges = getPrinterRoleLabels(printer, storePrinters)
          .map((label) => `<span class="badge">${escapeHtml(label)}</span>`);

        card.innerHTML = `
          <h4>${escapeHtml(printer.name)}</h4>
          <div class="printer-meta">${badges.join(' ')}</div>
          <div class="printer-actions">
            <button class="btn-tertiary" data-printer="${escapeHtml(printer.id || printer.name)}">Testar</button>
          </div>
        `;

        listEl.appendChild(card);
      });

      document.querySelectorAll('.printer-actions button[data-printer]').forEach((button) => {
        button.addEventListener('click', (event) => {
          const printerId = event.currentTarget.getAttribute('data-printer');
          const select = document.getElementById('test-printer');
          if (select) select.value = printerId;
          void window.testPrint();
        });
      });
    }
  } catch (error) {
    if (countEl) countEl.textContent = '0';
    if (listEl) {
      const message = String(error?.message || error || '');
      const details = message.includes('Timeout ao buscar impressoras')
        ? 'A busca demorou mais do que o esperado. Em Windows 7 ou computadores lentos isso pode acontecer. Tente clicar em Atualizar Lista novamente.'
        : `Erro ao listar impressoras: ${escapeHtml(message)}`;
      listEl.innerHTML = `<div class="error-state">${details}</div>`;
    }
  }
}

function renderLogEntries(containerId, entries) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!entries || entries.length === 0) {
    container.innerHTML = '<div class="empty-state">Nenhum log encontrado</div>';
    return;
  }

  container.innerHTML = entries.map((entry) => `
    <div class="log-line">${escapeHtml(entry)}</div>
  `).join('');
}

async function loadDashboardActivity() {
  const dashboard = document.getElementById('dashboard-logs');
  if (!dashboard) return;

  try {
    const response = await window.api.getLogs({ type: 'print', limit: 8 });
    const entries = response?.entries || [];

    if (!entries.length) {
      dashboard.innerHTML = '<div class="empty-state">Nenhuma atividade recente</div>';
      return;
    }

    dashboard.innerHTML = [...entries].reverse().map((entry) => `
      <div class="log-item">${escapeHtml(entry)}</div>
    `).join('');
  } catch (error) {
    dashboard.innerHTML = `<div class="error-state">Erro ao carregar atividade: ${escapeHtml(error?.message || error)}</div>`;
  }
}

async function loadLogs() {
  const selectedType = document.getElementById('log-type')?.value || 'print';
  const logSource = document.getElementById('log-source');
  const logFilePath = document.getElementById('logs-filepath');

  try {
    const response = await window.api.getLogs({ type: selectedType, limit: 300 });
    renderLogEntries('full-logs', response?.entries || []);

    if (logSource) {
      logSource.textContent = String(selectedType).toUpperCase();
    }

    if (logFilePath && response?.files?.[selectedType]) {
      logFilePath.textContent = response.files[selectedType];
    }
  } catch (error) {
    const container = document.getElementById('full-logs');
    if (container) {
      container.innerHTML = `<div class="error-state">Erro ao carregar logs: ${escapeHtml(error?.message || error)}</div>`;
    }
  }
}

window.manualPrint = async function manualPrint() {
  const printer = document.getElementById('manual-printer')?.value || '';
  const text = document.getElementById('manual-text')?.value || '';

  if (!printer) {
    setStatus('manual-print-status', 'Selecione uma impressora.', 'error');
    return;
  }

  if (!text.trim()) {
    setStatus('manual-print-status', 'Digite o texto para imprimir.', 'error');
    return;
  }

  setStatus('manual-print-status', 'Enviando para impressão...');

  try {
    await window.api.manualPrint({
      printerId: printer,
      text,
    });

    setStatus('manual-print-status', 'Texto enviado para impressão.', 'success');
  } catch (error) {
    setStatus('manual-print-status', `Erro ao imprimir: ${error?.message || error}`, 'error');
  }

  await loadDashboardActivity();
  await loadLogs();
};

window.testPrint = async function testPrint() {
  const printer = document.getElementById('test-printer')?.value || '';

  if (!printer) {
    setStatus('settings-status', 'Selecione uma impressora.', 'error');
    return;
  }

  setStatus('settings-status', 'Enviando teste...');

  try {
    await window.api.testPrinter(printer);
    setStatus('settings-status', 'Teste enviado com sucesso.', 'success');
  } catch (error) {
    setStatus('settings-status', `Erro no teste: ${error?.message || error}`, 'error');
  }

  await loadDashboardActivity();
  await loadLogs();
};

async function addManualPrinter() {
  const name = prompt('Digite o nome exato da impressora (como aparece no Windows)');
  if (!name) return;

  try {
    await window.api.addManualPrinter({ name: name.trim() });
    await loadPrinters();
    alert('Impressora adicionada manualmente.');
  } catch (error) {
    alert(`Falha ao adicionar impressora: ${error?.message || error}`);
  }
}
