import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '40mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const MOCK = process.env.MOCK === '1';

const client = MOCK
  ? null
  : new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
      timeout: 170000,
      maxRetries: 1,
    });

// Passo 1: descrever cada foto para saber qual página é de qual prova.
const GROUP_SYSTEM = `You look at photos of printed school exams. One upload can mix pages of DIFFERENT exams, and usually only the first page of an exam shows the printed header; the other pages just continue the questions.
For every photo report:
- "photo": its number
- "exam": a letter for the exam the page belongs to (same letter = same exam). Different titles or topics are different exams, even with the same subject or teacher. A page without a header belongs to the exam whose questions it continues.
- "header": the exam title printed at the top of that page, copied exactly; empty string if that page shows no header
- "topic": 2 to 6 words about the subject of the questions on that page
- "first" and "last": the first and last question numbers visible on that page, as printed (for example "5.4")
Reply with ONE JSON object and nothing else: {"photos":[{"photo":1,"exam":"A","header":"","topic":"","first":"","last":""}]}`;

// Passo 2: responder uma prova de cada vez.
const SYSTEM = `You read photos of ONE school exam and answer every question on it.
Reply with ONE JSON object and nothing else (no markdown fences, no commentary).

Schema:
{"exams":[{
  "student_line":"copy the exam's own wording for the name line, with the name left blank, plus the class if it is printed in the header, e.g. \\"Alunno: ____________   cl. 3 BTCS\\"",
  "header_lines":["up to 2 lines copied from the header printed at the top: subject and title (the class goes in student_line)"],
  "questions":[
    {"number":"1","type":"choice","prompt":"the question exactly as printed, without the alternatives","options":{"a":"alternative a, max 80 chars","b":"...","c":"...","d":"..."},"why":"one short sentence on why the chosen alternative is right","answer_letters":["b"],"confidence":"high","note":""},
    {"number":"21","type":"written","prompt":"the question exactly as printed","points":"(__/3 pti)","answer":["the whole answer, as one string"],"confidence":"high","note":""},
    {"number":"22","type":"written","prompt":"a question that asks for three items","points":"(__/3 pti)","answer":["1. first item","2. second item","3. third item"],"confidence":"high","note":""},
    {"number":"19","type":"fill","prompt":"...","points":"","answer":["1 µm = 10^-6 m","..."],"confidence":"high","note":""}
  ]
}]}

Rules:
- All the photos are pages of the same exam, in any order, maybe repeated: return exactly one exam object, with the questions in the printed order and each question only once.
- A question can start at the bottom of one photo and continue at the top of another: join the pieces into one question.
- Pages can be printed in two columns: read each question together with the alternatives printed right below it, in the same column.
- Another sheet can show up rotated or partly in a corner of a photo: read the questions on it too.
- Use the numbering printed on the exam (for example "5.12"). Only real questions: never turn a stray number into a question.
- prompt: copy the question word for word as printed; never shorten or paraphrase it, and answer exactly what it asks.
- header_lines: copy only what is printed. If no photo shows the header, leave the list empty; never invent a title.
- Multiple choice: first copy every alternative into "options" exactly as printed (same letters, keep the letter case), then write "why", and only then choose. Pick only letters that exist in "options". Read each prompt carefully: "completamento errato", "NOT", "except" and similar ask for the WRONG alternative. For multiple-answer questions, list every correct letter. Never leave answer_letters empty: if unsure, pick the most likely and set confidence to "low".
- Written answers: same language as the exam, the way a good student would write them on the 3 or 4 ruled lines provided: at most 3 sentences, about 30 to 60 words in total. Cover every key idea the question asks for (the definition, the reason, the causes, the examples) and use the standard technical terms from the course; do not drop an essential point. Always put a space after every full stop.
- Put a written answer in ONE string. Never split a sentence or a paragraph into several strings to fit the lines: the site breaks the lines itself. Only when the question asks for N items, give exactly N strings, each one starting with its number ("1. ...").
- Calculations and fill-in blanks: one string per blank with the final value, plain text, powers written like 10^-6 and subscripts like H_2O.
- If part of a question is cut off or unreadable, still give your best answer, set confidence to "low" and explain in "note".
- If two alternatives share the same letter, say so in "note".
- Never invent questions that are not visible in the photos.
- The reply must be strictly valid JSON. Inside any string value never use the double-quote character: write quotation marks as « » or single quotes. Escape nothing else; no trailing commas.`;

const REPAIR_SYSTEM = 'You repair broken JSON. Return ONLY the corrected, strictly valid JSON, same content and structure, no commentary. Replace any double quotes inside string values with « » and remove trailing commas.';

function parseJson(text) {
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('A resposta da IA não veio em JSON.');
  return JSON.parse(t.slice(a, b + 1));
}

// Streaming: a conexão fica viva enquanto a resposta chega, então respostas longas não estouram o tempo.
// Se a API ficar muda por IDLE_MS, ou passar de TOTAL_MS no total, a chamada é cancelada em vez de travar o site.
const IDLE_MS = Number(process.env.IDLE_MS) || 90 * 1000;
const TOTAL_MS = 4 * 60 * 1000;
async function ask(system, content, maxTokens, label) {
  const started = Date.now();
  const stream = client.messages.stream({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] });
  let idle;
  const kick = () => { clearTimeout(idle); idle = setTimeout(() => stream.abort(), IDLE_MS); };
  const total = setTimeout(() => stream.abort(), TOTAL_MS);
  kick();
  stream.on('streamEvent', kick);
  try {
    const msg = await stream.finalMessage();
    console.log(`[${label}] ${Math.round((Date.now() - started) / 1000)}s, ${msg.usage?.output_tokens ?? '?'} tokens, fim: ${msg.stop_reason}`);
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { text, stop: msg.stop_reason };
  } catch (e) {
    if (stream.aborted) {
      console.error(`[${label}] cancelado depois de ${Math.round((Date.now() - started) / 1000)}s sem resposta completa`);
      const err = new Error('A API demorou demais para responder. Tente de novo daqui a pouco, ou com menos fotos.');
      err.timeout = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
  }
}

function photoBlocks(images, nums, keepNumbers) {
  const content = [];
  nums.forEach((n, i) => {
    const img = images[n - 1];
    content.push({ type: 'text', text: `Foto ${keepNumbers ? n : i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.type || 'image/jpeg', data: img.data } });
  });
  return content;
}

const topNum = (q) => parseInt(String(q || ''), 10);
const dotPrefix = (q) => (String(q || '').match(/^(\d+)\./) || [])[1] || null;
const longWords = (s) => new Set(String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z]{5,}/g) || []);

// Quanto uma página sem cabeçalho (g) parece continuar uma prova com cabeçalho (h).
function continuesScore(g, h) {
  let s = 0;
  const hNums = h.photos.flatMap((p) => [p.first, p.last]).filter(Boolean);
  const gFirst = g.photos.map((p) => p.first).filter(Boolean);
  if (gFirst.some((q) => dotPrefix(q) && hNums.some((x) => dotPrefix(x) === dotPrefix(q)))) s += 3;
  const tops = hNums.map(topNum).filter(Number.isFinite);
  if (tops.length && gFirst.some((q) => topNum(q) >= Math.min(...tops) && topNum(q) <= Math.max(...tops) + 1)) s += 1;
  const gw = longWords(g.photos.map((p) => p.topic).join(' '));
  const hw = longWords(h.photos.map((p) => `${p.header} ${p.topic}`).join(' '));
  let common = 0;
  for (const w of gw) if (hw.has(w)) common++;
  return s + Math.min(common, 3);
}
// Desempate: a prova com foto logo antes vence.
const photoGap = (h, g) => Math.min(...h.nums.flatMap((a) => g.nums.map((b) => (a < b ? b - a : 100 + a - b))));

async function groupPhotos(images) {
  const total = images.length;
  const all = images.map((_, i) => i + 1);
  if (total === 1) return [all];
  try {
    const content = photoBlocks(images, all, true);
    content.push({ type: 'text', text: `São ${total} fotos. Descreva cada uma e devolva só o JSON.` });
    const { text } = await ask(GROUP_SYSTEM, content, 1500, 'separar provas');
    const info = new Map();
    for (const p of parseJson(text).photos || []) {
      const n = Number(p && p.photo);
      if (Number.isInteger(n) && n >= 1 && n <= total && !info.has(n)) info.set(n, p);
    }
    if (!info.size) throw new Error('nenhuma foto descrita');
    // Foto esquecida pela IA: mesma prova da foto vizinha.
    for (const n of all) {
      if (!info.has(n)) info.set(n, { exam: (info.get(n - 1) || info.get(n + 1) || [...info.values()][0]).exam, header: '', topic: '', first: '', last: '' });
    }
    const byExam = new Map();
    for (const n of all) {
      const key = String(info.get(n).exam || 'A').trim().toUpperCase() || 'A';
      if (!byExam.has(key)) byExam.set(key, { nums: [], photos: [] });
      byExam.get(key).nums.push(n);
      byExam.get(key).photos.push(info.get(n));
    }
    const groups = [...byExam.values()];
    const headed = groups.filter((g) => g.photos.some((p) => String(p.header || '').trim()));
    // Uma "prova" sem nenhuma página com cabeçalho é, na verdade, continuação de outra.
    if (headed.length) {
      for (const g of groups) {
        if (headed.includes(g)) continue;
        const best = headed
          .map((h) => ({ h, s: continuesScore(g, h) }))
          .sort((a, b) => b.s - a.s || photoGap(a.h, g) - photoGap(b.h, g))[0].h;
        best.nums.push(...g.nums);
        best.photos.push(...g.photos);
      }
    }
    return (headed.length ? headed : groups).map((g) => g.nums.sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
  } catch (e) {
    if (e.timeout) throw e; // API travada: não adianta tentar de novo com todas as fotos
    console.error('Não consegui separar as provas; mando todas as fotos juntas:', e.message);
    return [all];
  }
}

async function solveExam(images, nums) {
  const content = photoBlocks(images, nums, false);
  content.push({ type: 'text', text: 'Responda todas as questões das fotos. Devolva apenas o JSON.' });
  const first = await ask(SYSTEM, content, 16000, `responder fotos ${nums.join(',')}`);
  if (first.stop === 'max_tokens') {
    throw new Error('A resposta da IA ficou grande demais e foi cortada. Mande menos fotos de cada vez.');
  }
  try {
    return parseJson(first.text);
  } catch (firstErr) {
    console.error('JSON inválido, tentando consertar:', firstErr.message);
    const fix = await ask(REPAIR_SYSTEM, [{ type: 'text', text: first.text }], 16000, 'consertar JSON');
    return parseJson(fix.text);
  }
}

app.get('/healthz', (_req, res) => res.send('ok'));

app.get('/api/models', async (_req, res) => {
  try {
    if (MOCK) return res.json({ models: [] });
    const ids = [];
    for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
    res.json({ current: MODEL, models: ids });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Não consegui listar os modelos.' });
  }
});

app.post('/api/solve', async (req, res) => {
  try {
    const images = req.body?.images;
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'Envie pelo menos uma foto.' });
    }
    if (images.length > 12) return res.status(400).json({ error: 'No máximo 12 fotos por vez.' });

    if (MOCK) {
      const mock = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'mock.json'), 'utf8'));
      return res.json(mock);
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Falta ANTHROPIC_API_KEY no arquivo .env do servidor.' });
    }

    const groups = await groupPhotos(images);
    const results = await Promise.all(groups.map((nums) => solveExam(images, nums)));
    res.json({ exams: results.flatMap((r) => r.exams || []) });
  } catch (e) {
    console.error(e);
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    res.status(status).json({ error: e.message || 'Erro ao falar com a API.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Site no ar: http://localhost:${port}${MOCK ? ' (modo simulado)' : ''}`));
