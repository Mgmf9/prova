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

// Passo 1: descobrir quais fotos são de qual prova.
const GROUP_SYSTEM = `You sort photos of printed school exams.
One upload can mix pages of DIFFERENT exams. Two photos belong to the same exam when they share the printed header (title, subject, topic) or when one clearly continues the other (same topic and question numbering that continues). Two exams with different titles or topics are always different exams, even if they have the same subject or teacher.
Reply with ONE JSON object and nothing else: {"groups":[[1,2],[3]]}
Each inner list holds the photo numbers of one exam, in page order. Every photo number appears in exactly one list.`;

// Passo 2: responder uma prova de cada vez.
const SYSTEM = `You read photos of ONE school exam and answer every question on it.
Reply with ONE JSON object and nothing else (no markdown fences, no commentary).

Schema:
{"exams":[{
  "student_line":"copy the exam's own wording for the name line, with the name left blank, e.g. \\"Alunno: ____________\\"",
  "header_lines":["up to 2 short lines printed at the top: class, subject, title"],
  "questions":[
    {"number":"1","type":"choice","prompt":"short version of the question, max 140 chars","answer_letters":["b"],"answer_text":["text of alternative b"],"confidence":"high","note":""},
    {"number":"21","type":"written","prompt":"short version of the question","points":"(__/3 pti)","answer":["the whole answer, as one string"],"confidence":"high","note":""},
    {"number":"22","type":"written","prompt":"a question that asks for three items","points":"(__/3 pti)","answer":["1. first item","2. second item","3. third item"],"confidence":"high","note":""},
    {"number":"19","type":"fill","prompt":"...","points":"","answer":["1 µm = 10^-6 m","..."],"confidence":"high","note":""}
  ]
}]}

Rules:
- All the photos are pages of the same exam, in any order, maybe repeated: return exactly one exam object, with the questions in the printed order and each question only once.
- A question can start at the bottom of one photo and continue at the top of another: join the pieces into one question.
- Use the numbering printed on the exam (for example "5.12").
- Read each prompt carefully: "completamento errato", "NOT", "except" and similar ask for the WRONG alternative. For multiple-answer questions, list every correct letter.
- answer_text: the text of each correct alternative, in the same order as answer_letters.
- Written answers: same language as the exam, written the way a good student would on the few ruled lines provided: 2 to 4 sentences. Cover every key idea the question asks for (the definition, the reason, the causes, the examples) and use the standard technical terms from the course; do not drop an essential point. Always put a space after every full stop.
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
async function ask(system, content, maxTokens) {
  const msg = await client.messages
    .stream({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] })
    .finalMessage();
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, stop: msg.stop_reason };
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

async function groupPhotos(images) {
  const total = images.length;
  const all = images.map((_, i) => i + 1);
  if (total === 1) return [all];
  try {
    const content = photoBlocks(images, all, true);
    content.push({ type: 'text', text: `São ${total} fotos. Agrupe por prova e devolva só o JSON.` });
    const { text } = await ask(GROUP_SYSTEM, content, 600);
    const seen = new Set();
    const groups = (parseJson(text).groups || [])
      .map((g) => (Array.isArray(g) ? g : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= total && !seen.has(n) && seen.add(n)))
      .filter((g) => g.length);
    if (!groups.length) throw new Error('nenhum grupo');
    // Foto esquecida pela IA: vai para o grupo da foto vizinha.
    for (const n of all) {
      if (seen.has(n)) continue;
      const near = groups.find((g) => g.includes(n - 1)) || groups.find((g) => g.includes(n + 1)) || groups[0];
      near.push(n);
      seen.add(n);
    }
    return groups.sort((a, b) => Math.min(...a) - Math.min(...b));
  } catch (e) {
    console.error('Não consegui separar as provas; mando todas as fotos juntas:', e.message);
    return [all];
  }
}

async function solveExam(images, nums) {
  const content = photoBlocks(images, nums, false);
  content.push({ type: 'text', text: 'Responda todas as questões das fotos. Devolva apenas o JSON.' });
  const first = await ask(SYSTEM, content, 16000);
  if (first.stop === 'max_tokens') {
    throw new Error('A resposta da IA ficou grande demais e foi cortada. Mande menos fotos de cada vez.');
  }
  try {
    return parseJson(first.text);
  } catch (firstErr) {
    console.error('JSON inválido, tentando consertar:', firstErr.message);
    const fix = await ask(REPAIR_SYSTEM, [{ type: 'text', text: first.text }], 16000);
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
