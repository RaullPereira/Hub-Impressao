document.addEventListener('DOMContentLoaded', () => {
  const navItems = document.querySelectorAll('.nav-item');
  const views = document.querySelectorAll('.view');

  navItems.forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelector('.nav-item.active')?.classList.remove('active');
      btn.classList.add('active');

      const tab = btn.dataset.tab;
      views.forEach(v => v.classList.remove('active'));
      const view = document.getElementById(tab);
      if (view) view.classList.add('active');

      if (tab === 'printers') loadPrinters();
    });
  });

  const refreshBtn = document.getElementById('refresh-printers');
  if (refreshBtn) refreshBtn.addEventListener('click', loadPrinters);
  const addBtn = document.getElementById('add-printer');
  if (addBtn) addBtn.addEventListener('click', addManualPrinter);

  // initial dashboard values
  loadPrinters();
});

async function loadPrinters() {
  const listEl = document.getElementById('printer-list');
  const select = document.getElementById('test-printer');
  const countEl = document.getElementById('printer-count');

  if (listEl) listEl.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Buscando impressoras...</p></div>`;

  try {
    const printers = await window.api.getPrinters();
    if (countEl) countEl.textContent = (printers && printers.length) ? String(printers.length) : '0';

    if (!printers || printers.length === 0) {
      if (listEl) listEl.innerHTML = `<div class="empty-state">Nenhuma impressora encontrada</div>`;
      if (select) select.innerHTML = `<option value="">Selecione uma impressora...</option>`;
      return;
    }

    if (select) {
      select.innerHTML = `<option value="">Selecione uma impressora...</option>`;
    }

    if (listEl) listEl.innerHTML = '';
    printers.forEach(p => {
      const card = document.createElement('div');
      card.className = 'printer-card';
      const meta = p.isDefault ? '<span class="badge">Padrão</span>' : '';
      card.innerHTML = `
        <h4>${p.name}</h4>
        <div class="printer-meta">${meta}</div>
        <div class="printer-actions"><button class="btn-tertiary" data-printer="${p.name}">Testar</button></div>
      `;
      listEl.appendChild(card);

      if (select) {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        select.appendChild(opt);
      }
    });

    // attach test buttons
    document.querySelectorAll('.printer-actions button[data-printer]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const name = e.currentTarget.getAttribute('data-printer');
        document.getElementById('test-printer').value = name;
        testPrint();
      });
    });

  } catch (err) {
    if (listEl) listEl.innerHTML = `<div class="error-state">Erro ao listar impressoras: ${err && err.message ? err.message : err}</div>`;
  }
}

window.testPrint = async function testPrint() {
  const select = document.getElementById('test-printer');
  const status = document.getElementById('settings-status');
  const name = select ? select.value : '';
  if (!name) {
    if (status) status.textContent = 'Selecione uma impressora.';
    return;
  }

  if (status) status.textContent = 'Enviando teste...';
  try {
    await window.api.testPrinter(name);
    if (status) status.textContent = 'Teste enviado com sucesso.';
  } catch (e) {
    if (status) status.textContent = `Erro no teste: ${e && e.message ? e.message : e}`;
  }
};

const API_BASE = 'http://localhost:3001';

async function addManualPrinter() {
  const name = prompt('Digite o nome exato da impressora (como aparece no Windows)');
  if (!name) return;
  try {
    await fetch(`${API_BASE}/api/printers/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() })
    });
    await loadPrinters();
    alert('Impressora adicionada manualmente.');
  } catch (err) {
    alert('Falha ao adicionar impressora: ' + (err && err.message ? err.message : err));
  }
}

