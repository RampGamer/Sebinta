'use strict';

/*
 * Controlador da página de diagnóstico de metadados (metadata-check.html).
 * Reutiliza o mesmo worker.js da limpeza real (upload.js) para a simulação
 * "limpar no browser", garantindo que o resultado mostrado é exatamente o
 * que aconteceria num upload verdadeiro.
 */
(function () {
  const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
  const PDF_EXTS = new Set(['.pdf']);
  const OOXML_EXTS = new Set(['.docx', '.xlsx', '.pptx']);

  const toastContainer = document.getElementById('toast-container');
  function toast(message, type) {
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = message;
    toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  function extOf(name) {
    const idx = name.lastIndexOf('.');
    return idx === -1 ? '' : name.slice(idx).toLowerCase();
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB'];
    let val = bytes, i = -1;
    do { val /= 1024; i++; } while (val >= 1024 && i < units.length - 1);
    return val.toFixed(val < 10 ? 1 : 0) + ' ' + units[i];
  }

  function detectCleanKind(ext) {
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (PDF_EXTS.has(ext)) return 'pdf';
    if (OOXML_EXTS.has(ext)) return 'ooxml';
    return null;
  }

  /** Renderiza um resultado de inspectFile() num par (resumo, lista de cards). */
  function renderResult(summaryEl, findingsEl, result) {
    summaryEl.replaceChildren();
    findingsEl.replaceChildren();

    if (result.error) {
      const s = document.createElement('div');
      s.className = 'diag-summary warn';
      s.textContent = '⚠ ' + result.error;
      summaryEl.appendChild(s);
      return;
    }
    if (!result.supported) {
      const s = document.createElement('div');
      s.className = 'diag-summary muted';
      s.textContent = 'Este tipo de ficheiro não é analisado no browser (a limpeza deste tipo acontece só no servidor). Usa a secção 2 para verificares o resultado real.';
      summaryEl.appendChild(s);
      return;
    }

    const warnings = result.findings.filter((f) => f.severity === 'warning');
    const s = document.createElement('div');
    if (warnings.length === 0) {
      s.className = 'diag-summary ok';
      s.textContent = '✅ Nenhum metadado sensível encontrado.';
    } else {
      s.className = 'diag-summary warn';
      s.textContent = `⚠ ${warnings.length} item(ns) de metadados encontrados.`;
    }
    summaryEl.appendChild(s);

    for (const finding of result.findings) {
      const card = document.createElement('div');
      card.className = 'finding-card ' + (finding.severity || 'info');

      const label = document.createElement('div');
      label.className = 'finding-label';
      label.textContent = finding.label;
      card.appendChild(label);

      if (finding.detail) {
        const detail = document.createElement('div');
        detail.className = 'finding-detail';
        detail.textContent = finding.detail;
        card.appendChild(detail);
      }

      if (finding.lines && finding.lines.length) {
        const ul = document.createElement('ul');
        for (const line of finding.lines) {
          const li = document.createElement('li');
          li.textContent = line;
          ul.appendChild(li);
        }
        card.appendChild(ul);
      }

      findingsEl.appendChild(card);
    }
  }

  // === Secção 1: ficheiro local ===
  const fileInput = document.getElementById('local-file-input');
  const pickBtn = document.getElementById('btn-pick-file');
  const fileMeta = document.getElementById('local-file-meta');
  const columns = document.getElementById('local-columns');
  const originalSummary = document.getElementById('local-original-summary');
  const originalFindings = document.getElementById('local-original-findings');
  const cleanedSummary = document.getElementById('local-cleaned-summary');
  const cleanedFindings = document.getElementById('local-cleaned-findings');
  const cleanBtn = document.getElementById('btn-clean-local');

  let currentFile = null;
  let currentBuffer = null;
  let worker = null;

  function getWorker() {
    if (!worker) worker = new Worker('/js/metadata/worker.js');
    return worker;
  }

  pickBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    currentFile = file;
    currentBuffer = await file.arrayBuffer();

    fileMeta.textContent = `${file.name} — ${formatSize(file.size)} — ${file.type || 'tipo desconhecido'}`;
    columns.hidden = false;
    cleanedSummary.replaceChildren();
    cleanedFindings.replaceChildren();

    const ext = extOf(file.name);
    const result = await window.MetadataInspect.inspectFile(currentBuffer.slice(0), ext);
    renderResult(originalSummary, originalFindings, result);

    const kind = detectCleanKind(ext);
    cleanBtn.hidden = !kind;
    if (!kind) {
      const s = document.createElement('div');
      s.className = 'diag-summary muted';
      s.textContent = 'Este tipo não tem limpeza no browser — segue direto para a quarentena do servidor.';
      cleanedSummary.appendChild(s);
    }
  });

  cleanBtn.addEventListener('click', async () => {
    if (!currentFile || !currentBuffer) return;
    const ext = extOf(currentFile.name);
    const kind = detectCleanKind(ext);
    if (!kind) return;

    cleanBtn.disabled = true;
    cleanedSummary.replaceChildren();
    cleanedFindings.replaceChildren();
    const pending = document.createElement('div');
    pending.className = 'diag-summary muted';
    pending.textContent = 'a limpar…';
    cleanedSummary.appendChild(pending);

    try {
      const bufferCopy = currentBuffer.slice(0);
      const id = Date.now();
      const w = getWorker();
      const resultPromise = new Promise((resolve, reject) => {
        function onMessage(ev) {
          if (ev.data.id !== id) return;
          w.removeEventListener('message', onMessage);
          if (ev.data.ok) resolve(ev.data);
          else reject(new Error(ev.data.error));
        }
        w.addEventListener('message', onMessage);
      });
      w.postMessage({ id, kind, buffer: bufferCopy, mimeType: currentFile.type || '' }, [bufferCopy]);
      const cleaned = await resultPromise;

      const result = await window.MetadataInspect.inspectFile(cleaned.buffer.slice(0), ext);
      renderResult(cleanedSummary, cleanedFindings, result);
    } catch (err) {
      cleanedSummary.replaceChildren();
      const s = document.createElement('div');
      s.className = 'diag-summary warn';
      s.textContent = '⚠ A limpeza falhou: ' + err.message;
      cleanedSummary.appendChild(s);
      toast('Limpeza falhou: ' + err.message, 'error');
    } finally {
      cleanBtn.disabled = false;
    }
  });

  // === Secção 2: ficheiro já enviado num pad ===
  const padInput = document.getElementById('pad-input');
  const listBtn = document.getElementById('btn-list-files');
  const fileListEl = document.getElementById('pad-file-list');
  const remoteColumns = document.getElementById('remote-columns');
  const remoteSummary = document.getElementById('remote-summary');
  const remoteFindings = document.getElementById('remote-findings');

  async function listPadFiles() {
    const padId = padInput.value.trim();
    if (!padId) { toast('Indica o nome do pad.', 'error'); return; }
    fileListEl.replaceChildren();
    let res;
    try {
      res = await fetch(`/api/pad?id=${encodeURIComponent(padId)}`, { credentials: 'same-origin' });
    } catch (e) {
      toast('Erro de rede.', 'error');
      return;
    }
    if (!res.ok) { toast('Não foi possível abrir este pad.', 'error'); return; }
    const data = await res.json();
    if (data.locked) {
      toast('Este pad está protegido por password — abre-o primeiro na página normal do pad para o desbloqueares.', 'error');
      return;
    }
    if (!data.files || data.files.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'diag-summary muted';
      empty.textContent = 'Este pad não tem ficheiros.';
      fileListEl.appendChild(empty);
      return;
    }
    for (const file of data.files) {
      const row = document.createElement('div');
      row.className = 'item';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = `${file.name} (${formatSize(file.size)})`;
      name.title = file.name;
      const btn = document.createElement('button');
      btn.textContent = 'Analisar';
      btn.addEventListener('click', () => downloadAndScan(padId, file.id, file.name));
      row.appendChild(name);
      row.appendChild(btn);
      fileListEl.appendChild(row);
    }
  }

  async function downloadAndScan(padId, fileId, fileName) {
    remoteColumns.hidden = false;
    remoteSummary.replaceChildren();
    remoteFindings.replaceChildren();
    const pending = document.createElement('div');
    pending.className = 'diag-summary muted';
    pending.textContent = `a descarregar "${fileName}"…`;
    remoteSummary.appendChild(pending);

    let res;
    try {
      res = await fetch(`/api/files/${encodeURIComponent(fileId)}/download?id=${encodeURIComponent(padId)}`, { credentials: 'same-origin' });
    } catch (e) {
      toast('Erro de rede ao descarregar.', 'error');
      return;
    }
    if (!res.ok) { toast('Não foi possível descarregar este ficheiro.', 'error'); return; }
    const buffer = await res.arrayBuffer();
    const ext = extOf(fileName);
    const result = await window.MetadataInspect.inspectFile(buffer, ext);
    renderResult(remoteSummary, remoteFindings, result);
  }

  listBtn.addEventListener('click', listPadFiles);
  padInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') listPadFiles(); });
})();
