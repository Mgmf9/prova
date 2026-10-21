const $ = (s) => document.querySelector(s);

let photos = [];
let exams = [];

const W = 1240, PH = 1754, LEFT = 150, RIGHT = W - 70, LH = 62;
const TOP = 195, BOTTOM = PH - 70;
const HAND = '400 44px Caveat, "Segoe Print", "Bradley Hand", cursive';
const HAND_SMALL = '400 30px Caveat, "Segoe Print", "Bradley Hand", cursive';
const LBL = 'bold 22px system-ui, Arial, sans-serif';
const HD = '21px system-ui, Arial, sans-serif';
const meter = document.createElement('canvas').getContext('2d');

// Expoentes e índices na letra de mão: 10^-6, 10^{-6}, m^2, H_2O, x_{n}
const SCRIPT_RE = /\^\{([^}]*)\}|\^([+\-−]?\d+(?:[.,]\d+)?|[a-zA-Z])|_\{([^}]*)\}|_(\d+)/g;
function richParts(text) {
  const parts = [];
  let last = 0, m;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(text))) {
    if (m.index > last) parts.push({ t: text.slice(last, m.index), k: 0 });
    const sup = m[1] !== undefined || m[2] !== undefined;
    parts.push({ t: m[1] ?? m[2] ?? m[3] ?? m[4], k: sup ? 1 : -1 });
    last = SCRIPT_RE.lastIndex;
  }
  if (last < text.length) parts.push({ t: text.slice(last), k: 0 });
  return parts;
}

function textWidth(text, font) {
  if (font !== HAND) { meter.font = font; return meter.measureText(text).width; }
  let w = 0;
  for (const p of richParts(text)) {
    meter.font = p.k ? HAND_SMALL : HAND;
    w += meter.measureText(p.t).width + (p.k ? 3 : 0);
  }
  return w;
}

function drawHand(d, text, x, y) {
  for (const p of richParts(text)) {
    d.font = p.k ? HAND_SMALL : HAND;
    d.fillText(p.t, x + (p.k ? 1 : 0), y + (p.k > 0 ? -17 : p.k < 0 ? 7 : 0));
    x += d.measureText(p.t).width + (p.k ? 3 : 0);
  }
}

function wrap(text, font, maxw) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (textWidth(t, font) <= maxw) cur = t;
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

// Arruma a resposta que chega da IA antes de desenhar.
const SUP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+' };
const SUB = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };
function toMarkup(s) {
  return s
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, (m) => '^{' + [...m].map((c) => SUP[c]).join('') + '}')
    .replace(/[₀₁₂₃₄₅₆₇₈₉]+/g, (m) => '_{' + [...m].map((c) => SUB[c]).join('') + '}');
}
const LIST_ITEM = /^(\d+[.)°º]|[a-zA-Z][.)]|[-–•*])\s+/;
function cleanAnswer(q) {
  const lines = (Array.isArray(q.answer) ? q.answer : [q.answer ?? ''])
    .flatMap((a) => String(a ?? '').split('\n'))
    .map((a) => toMarkup(a.trim()))
    .filter(Boolean);
  if (q.type === 'fill') return lines;
  // A IA às vezes quebra um parágrafo em vários pedaços; cada pedaço começava numa linha nova da folha.
  const out = [];
  for (const l of lines) {
    if (!out.length || LIST_ITEM.test(l)) out.push(l);
    else out[out.length - 1] += ' ' + l;
  }
  return out;
}
function normalizeExams(list) {
  for (const exam of list) {
    for (const q of exam.questions || []) {
      if (q.type === 'choice') q.answer_letters = Array.isArray(q.answer_letters) ? q.answer_letters : [];
      else q.answer = cleanAnswer(q);
    }
  }
  return list;
}

function buildItems(exam, compact) {
  const items = [];
  let block = null;
  const flush = () => { if (block) { items.push(block); block = null; } };
  for (const q of exam.questions || []) {
    if (q.type === 'choice') {
      const letters = (q.answer_letters || []).map((l) => String(l).toLowerCase());
      if (compact) {
        if (!letters.length) continue; // sem letra não vira linha vazia na folha; fica marcada para conferir
        if (!block) block = { label: '', pts: '', answers: [] };
        block.answers.push(`${q.number}. ${letters.map((l) => l + ')').join(' e ')}`);
      } else {
        flush();
        const texts = q.answer_text || [];
        items.push({
          label: `${q.number}. ${q.prompt || ''}`,
          pts: '',
          answers: letters.map((l, i) => `${l}) ${texts[i] || (q.options && q.options[l]) || ''}`.trim()),
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

const labelH = (lab) => (lab.length ? 30 * lab.length : 0) + 8;
const itemH = (lab, n) => labelH(lab) + LH * n + 26;

// Um bloco que não cabe no resto da folha continua na folha seguinte (antes ele era cortado no fim da página).
function paginate(items) {
  const maxw = RIGHT - LEFT;
  const pages = [];
  let cur = [], y = TOP;
  const newPage = () => { pages.push(cur); cur = []; y = TOP; };
  for (const it of items) {
    const lab = it.label ? wrap(it.label, LBL, maxw - (it.pts ? 150 : 0)) : [];
    let lines = [];
    for (const a of it.answers) lines = lines.concat(wrap(fixSpaces(a), HAND, maxw));
    let rest = { ...it, lab, lines, n: Math.max(lines.length, 1) };
    for (;;) {
      const h = itemH(rest.lab, rest.n);
      if (y + h <= BOTTOM) { cur.push({ ...rest, h }); y += h; break; }
      const fits = Math.floor((BOTTOM - y - labelH(rest.lab) - 26) / LH);
      if (fits >= 1 && rest.lines.length > fits) {
        cur.push({ ...rest, lines: rest.lines.slice(0, fits), n: fits, h: itemH(rest.lab, fits) });
        const left = rest.lines.slice(fits);
        rest = { ...rest, lab: [], pts: '', lines: left, n: left.length };
        newPage();
      } else if (cur.length) {
        newPage();
      } else {
        cur.push({ ...rest, h }); y += h;
        break;
      }
    }
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

  let y = TOP;
  for (const it of pg) {
    d.font = LBL; d.fillStyle = '#2c2c2a';
    it.lab.forEach((l, i) => d.fillText(l, LEFT, y + i * 30 + 20));
    if (it.pts) { d.font = HD; d.fillStyle = '#5f5e5a'; d.textAlign = 'right'; d.fillText(it.pts, RIGHT, y + 20); d.textAlign = 'left'; }
    const y0 = y + labelH(it.lab);
    d.strokeStyle = '#bed0e6'; d.lineWidth = 2;
    for (let k = 0; k < it.n; k++) {
      const ly = y0 + LH * (k + 1) - 6;
      d.beginPath(); d.moveTo(LEFT - 20, ly); d.lineTo(RIGHT, ly); d.stroke();
    }
    d.fillStyle = '#1b2f7a';
    it.lines.forEach((l, k) => drawHand(d, l, LEFT, y0 + LH * (k + 1) - 16));
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
    const noLetter = q.type === 'choice' && !(q.answer_letters || []).length;
    if (q.confidence === 'low' || q.confidence === 'medium' || noLetter) {
      const bd = document.createElement('span'); bd.className = 'badge'; bd.textContent = 'conferir'; p.appendChild(bd);
    }
    row.appendChild(p);
    if (q.type === 'choice') {
      const inp = document.createElement('input'); inp.type = 'text';
      inp.value = (q.answer_letters || []).join(', ');
      inp.placeholder = 'Letra(s), ex.: b, d';
      inp.oninput = () => {
        const letters = inp.value.toLowerCase().match(/[a-z]/g) || [];
        const before = (q.answer_letters || []).map((l) => String(l).toLowerCase()).join();
        if (letters.join() !== before) q.answer_text = letters.map((l) => (q.options && q.options[l]) || '');
        q.answer_letters = letters;
        refresh();
      };
      row.appendChild(inp);
    } else {
      const ta = document.createElement('textarea');
      ta.value = (Array.isArray(q.answer) ? q.answer : [q.answer || '']).join('\n');
      ta.oninput = () => { q.answer = ta.value.split('\n').filter((l) => l.trim()); refresh(); };
      row.appendChild(ta);
    }
    for (const t of [q.why, q.note]) {
      if (t) { const nt = document.createElement('p'); nt.className = 'note'; nt.textContent = t; row.appendChild(nt); }
    }
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
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
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
  let skipped = 0;
  for (const f of files) {
    if (photos.length >= 12) break;
    try { photos.push(await fileToJpeg(f)); } catch { skipped++; }
  }
  renderThumbs();
  setStatus(skipped ? `${skipped} foto(s) não abriram. Se for HEIC do iPhone, mande um print ou um JPG.` : '', skipped > 0);
});

function setStatus(msg, err = false) {
  const s = $('#status'); s.textContent = msg; s.className = err ? 'err' : '';
}

$('#compact').addEventListener('change', () => { if (exams.length) showResults(); });

$('#go').addEventListener('click', async () => {
  if (!photos.length) return setStatus('Anexe pelo menos uma foto.', true);
  const btn = $('#go');
  btn.disabled = true;
  // Mostra o tempo passando e desiste depois de 10 minutos, em vez de ficar parado para sempre.
  const started = Date.now();
  const tick = () => {
    const s = Math.round((Date.now() - started) / 1000);
    setStatus(`Lendo a prova e respondendo… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} (costuma levar de 1 a 3 minutos)`);
  };
  tick();
  const clock = setInterval(tick, 1000);
  const ctrl = new AbortController();
  const limit = setTimeout(() => ctrl.abort(), 10 * 60 * 1000);
  try {
    const r = await fetch('/api/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: photos.map((p) => ({ data: p.data, type: p.type })) }),
      signal: ctrl.signal,
    }).catch((err) => {
      throw new Error(err.name === 'AbortError'
        ? 'Demorou mais de 10 minutos e eu desisti. Tente de novo, ou com menos fotos.'
        : 'Perdi a conexão com o servidor. Se você acabou de atualizar o site, espere o Render ficar Live e tente de novo.');
    });
    clearInterval(clock);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(j.error || (r.status === 502 || r.status === 503
        ? `Erro ${r.status}: o servidor reiniciou no meio do pedido (às vezes é o Render publicando uma versão nova). Tente de novo.`
        : `Erro ${r.status}`));
    }
    exams = normalizeExams((j.exams || []).filter((e) => (e.questions || []).length));
    if (!exams.length) throw new Error('Não encontrei questões nas fotos. Tente fotos mais nítidas.');
    setStatus('Pronto. Confira as respostas marcadas com "conferir" antes de usar.');
    await showResults();
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    clearInterval(clock);
    clearTimeout(limit);
    btn.disabled = false;
  }
});
