const $ = (s) => document.querySelector(s);

let photos = [];
let exams = [];

const W = 1240, PH = 1754, LEFT = 150, RIGHT = W - 70, LH = 62;
const HAND = '400 44px Caveat, "Segoe Print", "Bradley Hand", cursive';
const LBL = 'bold 22px system-ui, Arial, sans-serif';
const HD = '21px system-ui, Arial, sans-serif';
const meter = document.createElement('canvas').getContext('2d');

function wrap(text, font, maxw) {
  meter.font = font;
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (meter.measureText(t).width <= maxw) cur = t;
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function fitText(ctx, text, x, y, maxw, size) {
  let s = size;
  do { ctx.font = `${s}px system-ui, Arial, sans-serif`; s -= 1; }
  while (ctx.measureText(text).width > maxw && s > 12);
  ctx.fillText(text, x, y);
}

function buildItems(exam, compact) {
  const items = [];
  let block = null;
  const flush = () => { if (block) { items.push(block); block = null; } };
  for (const q of exam.questions || []) {
    if (q.type === 'choice') {
      const letters = (q.answer_letters || []).map((l) => String(l).toLowerCase());
      if (compact) {
        if (!block) block = { label: '', pts: '', answers: [] };
        block.answers.push(`${q.number}. ${letters.map((l) => l + ')').join(' e ')}`);
      } else {
        flush();
        items.push({
          label: `${q.number}. ${q.prompt || ''}`,
          pts: '',
          answers: letters.map((l) => `${l}) ${(q.options && q.options[l]) || ''}`.trim()),
        });
      }
    } else {
      flush();
      items.push({
        label: `${q.number}. ${q.prompt || ''}`,
        pts: q.points || '',
        answers: Array.isArray(q.answer) ? q.answer : [String(q.answer || '')],
      });
    }
  }
  flush();
  return items;
}

function fixSpaces(t) {
  return String(t ?? '').replace(/([.!?;:])(?=[A-ZÀ-ÖØ-Þ])/g, '$1 ');
}

function paginate(items) {
  const maxw = RIGHT - LEFT;
  const laid = items.map((it) => {
    const lab = it.label ? wrap(it.label, LBL, maxw - (it.pts ? 150 : 0)) : [];
    let lines = [];
    for (const a of it.answers) lines = lines.concat(wrap(fixSpaces(a), HAND, maxw));
    const n = Math.max(lines.length, 1);
    const h = (lab.length ? 30 * lab.length : 0) + 8 + LH * n + 26;
    return { ...it, lab, lines, n, h };
  });
  const pages = [];
  let cur = [], y = 195;
  for (const it of laid) {
    if (y + it.h > PH - 70 && cur.length) { pages.push(cur); cur = []; y = 195; }
    cur.push(it); y += it.h;
  }
  if (cur.length) pages.push(cur);
  return pages;
}

function drawPage(pg, idx, total, exam) {
  const c = document.createElement('canvas');
  c.width = W; c.height = PH;
  const d = c.getContext('2d');
  d.fillStyle = '#fdfdfb'; d.fillRect(0, 0, W, PH);
  d.strokeStyle = '#e8a3a3'; d.lineWidth = 3;
  d.beginPath(); d.moveTo(110, 0); d.lineTo(110, PH); d.stroke();

  d.fillStyle = '#444441'; d.textBaseline = 'alphabetic';
  fitText(d, exam.student_line || 'Nome: ______________________', LEFT, 68, RIGHT - LEFT, 21);
  (exam.header_lines || []).slice(0, 2).forEach((h, k) => fitText(d, h, LEFT, 112 + k * 30, RIGHT - LEFT, 21));
  d.strokeStyle = '#888780'; d.lineWidth = 2;
  d.beginPath(); d.moveTo(LEFT, 165); d.lineTo(RIGHT, 165); d.stroke();

  d.font = HD; d.fillStyle = '#5f5e5a'; d.textAlign = 'right';
  d.fillText(`${idx} / ${total}`, RIGHT, PH - 40);
  d.textAlign = 'left';

  let y = 195;
  for (const it of pg) {
    d.font = LBL; d.fillStyle = '#2c2c2a';
    it.lab.forEach((l, i) => d.fillText(l, LEFT, y + i * 30 + 20));
    if (it.pts) { d.font = HD; d.fillStyle = '#5f5e5a'; d.textAlign = 'right'; d.fillText(it.pts, RIGHT, y + 20); d.textAlign = 'left'; }
    const y0 = y + (it.lab.length ? 30 * it.lab.length : 0) + 8;
    d.strokeStyle = '#bed0e6'; d.lineWidth = 2;
    for (let k = 0; k < it.n; k++) {
      const ly = y0 + LH * (k + 1) - 6;
      d.beginPath(); d.moveTo(LEFT - 20, ly); d.lineTo(RIGHT, ly); d.stroke();
    }
    d.font = HAND; d.fillStyle = '#1b2f7a';
    it.lines.forEach((l, k) => d.fillText(l, LEFT, y0 + LH * (k + 1) - 16));
    y += it.h;
  }
  return c;
}

function download(canvas, name) {
  canvas.toBlob((b) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, 'image/png');
}

async function copyImage(canvas, btn) {
  const old = btn.textContent;
  try {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    btn.textContent = 'Copiada';
  } catch {
    btn.textContent = 'Não deu para copiar; use Baixar';
  }
  setTimeout(() => (btn.textContent = old), 2200);
}

function renderSheets(exam, box, n) {
  box.innerHTML = '';
  const pages = paginate(buildItems(exam, $('#compact').checked));
  const canvases = pages.map((pg, i) => drawPage(pg, i + 1, pages.length, exam));
  canvases.forEach((c, i) => {
    const wrapEl = document.createElement('div');
    wrapEl.className = 'sheet';
    wrapEl.appendChild(c);
    const bar = document.createElement('div');
    bar.className = 'bar';
    const dl = document.createElement('button'); dl.textContent = `Baixar folha ${i + 1}`;
    dl.onclick = () => download(c, `prova${n}_folha${i + 1}.png`);
    const cp = document.createElement('button'); cp.textContent = 'Copiar imagem';
    cp.onclick = () => copyImage(c, cp);
    bar.append(dl, cp);
    wrapEl.appendChild(bar);
    box.appendChild(wrapEl);
  });
}

function renderEditor(exam, sheetsBox, n) {
  const det = document.createElement('details');
  det.innerHTML = '<summary>Conferir e editar respostas</summary>';
  let timer;
  const refresh = () => { clearTimeout(timer); timer = setTimeout(() => renderSheets(exam, sheetsBox, n), 250); };
  for (const q of exam.questions || []) {
    const row = document.createElement('div');
    row.className = 'q';
    const p = document.createElement('p');
    p.className = 'p';
    const num = document.createElement('b'); num.textContent = q.number + '. ';
    p.append(num, (q.prompt || '').slice(0, 140));
    if (q.confidence === 'low' || q.confidence === 'medium') {
      const bd = document.createElement('span'); bd.className = 'badge'; bd.textContent = 'conferir'; p.appendChild(bd);
    }
    row.appendChild(p);
    if (q.type === 'choice') {
      const inp = document.createElement('input'); inp.type = 'text';
      inp.value = (q.answer_letters || []).join(', ');
      inp.placeholder = 'Letra(s), ex.: b, d';
      inp.oninput = () => { q.answer_letters = (inp.value.toLowerCase().match(/[a-z]/g) || []); refresh(); };
      row.appendChild(inp);
    } else {
      const ta = document.createElement('textarea');
      ta.value = (Array.isArray(q.answer) ? q.answer : [q.answer || '']).join('\n');
      ta.oninput = () => { q.answer = ta.value.split('\n').filter((l) => l.trim()); refresh(); };
      row.appendChild(ta);
    }
    if (q.note) { const nt = document.createElement('p'); nt.className = 'note'; nt.textContent = q.note; row.appendChild(nt); }
    det.appendChild(row);
  }
  return det;
}

async function showResults() {
  const root = $('#results');
  root.innerHTML = '';
  try { await document.fonts.load('44px Caveat'); } catch {}
  exams.forEach((exam, i) => {
    const n = i + 1;
    const h = document.createElement('h2');
    h.textContent = exams.length > 1 ? `Prova ${n}` : 'Sua prova';
    const sheetsBox = document.createElement('div');
    root.append(h, renderEditor(exam, sheetsBox, n), sheetsBox);
    renderSheets(exam, sheetsBox, n);
  });
}

async function fileToJpeg(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.85);
  return { name: file.name, url, data: url.split(',')[1], type: 'image/jpeg' };
}

function renderThumbs() {
  const box = $('#thumbs');
  box.innerHTML = '';
  photos.forEach((p, i) => {
    const d = document.createElement('div'); d.className = 'th';
    const im = document.createElement('img'); im.src = p.url; im.alt = p.name;
    const x = document.createElement('button'); x.textContent = '×'; x.setAttribute('aria-label', 'Remover foto');
    x.onclick = () => { photos.splice(i, 1); renderThumbs(); };
    d.append(im, x); box.appendChild(d);
  });
}

$('#file').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  setStatus('Preparando as fotos…');
  for (const f of files) {
    if (photos.length >= 12) break;
    try { photos.push(await fileToJpeg(f)); } catch { /* ignora arquivo ilegível */ }
  }
  renderThumbs();
  setStatus('');
});

function setStatus(msg, err = false) {
  const s = $('#status'); s.textContent = msg; s.className = err ? 'err' : '';
}

$('#compact').addEventListener('change', () => { if (exams.length) showResults(); });

$('#go').addEventListener('click', async () => {
  if (!photos.length) return setStatus('Anexe pelo menos uma foto.', true);
  const btn = $('#go');
  btn.disabled = true;
  setStatus('Lendo a prova e respondendo… isso pode levar cerca de um minuto.');
  try {
    const r = await fetch('/api/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: photos.map((p) => ({ data: p.data, type: p.type })) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Erro ${r.status}`);
    exams = (j.exams || []).filter((e) => (e.questions || []).length);
    if (!exams.length) throw new Error('Não encontrei questões nas fotos. Tente fotos mais nítidas.');
    setStatus('Pronto. Confira as respostas marcadas com "conferir" antes de usar.');
    await showResults();
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    btn.disabled = false;
  }
});
