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
    {"number":"1","type":"choice","prompt":"short version of the question, max 140 chars","options":{"a":"alternative text","b":"..."},"asks_for":"correct","answer_letters":["b"],"confidence":"high","note":""},
    {"number":"21","type":"written","prompt":"short version of the question","points":"(__/3 pti)","ruled_lines":3,"answer":["one continuous paragraph, or numbered lines if asked","..."],"confidence":"high","note":""},
    {"number":"19","type":"fill","prompt":"...","points":"","answer":["1 µm = 10^-6 m","..."],"confidence":"high","note":""}
  ]
}]}

Rules:
- FREE MODE: the input is not always an exam. If the photos or the typed text are a single exercise, a topic, or an instruction to write something (for example «Velocità di una reazione: relazione 1 = in base alla concentrazione, relazione 2 = in base alla temperatura e al catalizzatore»), do NOT look for exam questions. Return ONE exam object with student_line "", header_lines [] and ONE question: number "1", type "written", prompt = a short restatement of the task, points "", answer = the full requested text or the full worked solution (steps of the exercise, formulas, final result), written in the language of the task and with the length the person asked for (if none is given, a complete but compact answer). In this mode ignore the 65-characters-per-line limit: set ruled_lines to the number of handwritten lines the answer needs (about 65 characters per line). Use several array elements (one per paragraph or step) when it reads better. If the input contains several separate exercises, make one written question for each, numbered 1, 2, 3.
- One exam object per distinct exam. Two pages belong to the same exam ONLY if their printed titles match. Different printed titles (for example "Fondamenti della microbiologia" versus "EDUCAZIONE CIVICA: Il microbiota umano") are different exams: never put questions from two titles in one exam, even when the question numbers collide. Pages of the same exam may come in any order: merge them, sorted by printed question order. If a question shows up in more than one photo, include it once.
- Stems and options can be split across photos or pages: a list of alternatives at the top of a photo belongs to the question stem at the bottom of the previous photo. Join them. Copy each prompt as printed. Never replace a question with a different one, and never write a question that is not printed.
- Use the numbering printed on the exam (for example "5.12").
- For every choice question first fill "asks_for": "wrong" if the stem asks for the incorrect option ("errato", "NON è", "NOT", "except", "falso"), otherwise "correct". When asks_for is "wrong", answer_letters must contain ONLY the false alternative(s), never the true ones. Re-check this before answering. For multiple-answer questions, list every letter that satisfies the stem.
- Written answers: same language as the exam, written the way a good student would on the few ruled lines provided: Count the ruled (blank) lines printed under the question and put that number in ruled_lines (if you cannot see them, assume 3). The whole answer must fit in that many handwritten lines: about 65 characters per line, so never exceed ruled_lines x 65 characters in total; be concise and keep only the essential points. Write ONE continuous paragraph in a single array element, unless the question asks for a numbered list. Cover every key idea the question asks for (the definition, the reason, the causes, the examples) and use the standard technical terms from the course; do not drop an essential point. Always put a space after every full stop. If the question asks for N items, give exactly N numbered lines.
- Calculations and fill-in blanks: put the final value in each blank, plain text, powers written like 10^-6.
- If part of a question is cut off or unreadable, still give your best answer, set confidence to "low" and explain in "note".
- If two alternatives share the same letter, say so in "note".
- Exams are told apart by the title printed in the header (for example "Fondamenti della microbiologia" vs "EDUCAZIONE CIVICA: Il microbiota umano") and by the numbering: if the numbering restarts at 1 or the topic changes, it is ANOTHER exam. Never merge two exams into one object. Pages without a header belong to the exam whose numbering and topic they continue.
- A question can start at the bottom of one photo while its alternatives continue at the top of another photo (or a page can be cut off): join them into one question. Always answer the question exactly as printed. NEVER replace a question with a different one and never turn a multiple-choice question into an open question.
- For a choice question give exactly ONE letter in answer_letters, unless the printed question says it has several correct answers (e.g. "risposta multipla", "2 risposte corrette"). Before answering a question that asks for the wrong/incorrect completion ("errato", "NON", "tranne"), check every alternative one by one and pick the false one.
- Text fragments at the very edge of a photo (for example a lone line like "n modo casuale", or alternatives starting with a/b/c/d) are alternatives of the question printed just above or on the neighbouring photo, NOT new questions.
- Never guess a letter. If the question or its alternatives are cut off, rotated or unreadable, set answer_letters to [] and explain in note; the app will show a question mark so the student checks it.
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
    const images = Array.isArray(req.body?.images) ? req.body.images : [];
    const typed = String(req.body?.text || '').trim().slice(0, 20000);
    if (images.length === 0 && !typed) {
      return res.status(400).json({ error: 'Envie uma foto ou digite as questões.' });
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
    if (typed) content.push({ type: 'text', text: 'Questões digitadas pelo aluno (tratar como parte da prova):\n' + typed });
    content.push({ type: 'text', text: 'Responda todas as questões das fotos e do texto. Devolva apenas o JSON.' });

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
