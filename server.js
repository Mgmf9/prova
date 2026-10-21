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
    });

const SYSTEM = `You read photos of a school exam and answer every question on it.
Reply with ONE JSON object and nothing else (no markdown fences, no commentary).

Schema:
{"exams":[{
  "student_line":"copy the exam's own wording for the name line, with the name left blank, e.g. \\"Alunno: ____________\\"",
  "header_lines":["up to 2 short lines printed at the top: class, subject, title"],
  "questions":[
    {"number":"1","type":"choice","prompt":"short version of the question, max 140 chars","options":{"a":"alternative text","b":"..."},"answer_letters":["b"],"confidence":"high","note":""},
    {"number":"21","type":"written","prompt":"short version of the question","points":"(__/3 pti)","answer":["paragraph or numbered line","..."],"confidence":"high","note":""},
    {"number":"19","type":"fill","prompt":"...","points":"","answer":["1 µm = 10^-6 m","..."],"confidence":"high","note":""}
  ]
}]}

Rules:
- One exam object per distinct exam. Photos may show several pages of the same exam in any order: merge them into one object, sorted by the printed question order. If a question shows up in more than one photo, include it once.
- Use the numbering printed on the exam (for example "5.12").
- Read each prompt carefully: "completamento errato", "NOT", "except" and similar ask for the WRONG alternative. For multiple-answer questions, list every correct letter.
- Written answers: same language as the exam, written the way a good student would on the few ruled lines provided: 2 to 4 sentences. Cover every key idea the question asks for (the definition, the reason, the causes, the examples) and use the standard technical terms from the course; do not drop an essential point. Always put a space after every full stop. If the question asks for N items, give exactly N numbered lines.
- Calculations and fill-in blanks: put the final value in each blank, plain text, powers written like 10^-6.
- If part of a question is cut off or unreadable, still give your best answer, set confidence to "low" and explain in "note".
- If two alternatives share the same letter, say so in "note".
- Never invent questions that are not visible in the photos.
- The reply must be strictly valid JSON. Inside any string value never use the double-quote character: write quotation marks as « » or single quotes. Escape nothing else; no trailing commas.`;

function parseJson(text) {
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('A resposta da IA não veio em JSON.');
  return JSON.parse(t.slice(a, b + 1));
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

    const content = [];
    images.forEach((img, i) => {
      content.push({ type: 'text', text: `Foto ${i + 1}:` });
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.type || 'image/jpeg', data: img.data },
      });
    });
    content.push({ type: 'text', text: 'Responda todas as questões das fotos. Devolva apenas o JSON.' });

    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      messages: [{ role: 'user', content }],
    });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    try {
      return res.json(parseJson(text));
    } catch (firstErr) {
      console.error('JSON inválido, tentando consertar:', firstErr.message);
      const fix = await client.messages.create({
        model: MODEL,
        max_tokens: 8000,
        system: 'You repair broken JSON. Return ONLY the corrected, strictly valid JSON, same content and structure, no commentary. Replace any double quotes inside string values with « » and remove trailing commas.',
        messages: [{ role: 'user', content: text }],
      });
      const fixed = fix.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      return res.json(parseJson(fixed));
    }
  } catch (e) {
    console.error(e);
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    res.status(status).json({ error: e.message || 'Erro ao falar com a API.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Site no ar: http://localhost:${port}${MOCK ? ' (modo simulado)' : ''}`));
