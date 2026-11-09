import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scrapeAll } from './lib/apify.js';
import { generateDashboard, chatAboutJob } from './lib/openrouter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

/**
 * In-memory job store.
 * For production, replace with Redis or a database and use Apify webhooks
 * instead of polling.
 */
const jobs = new Map();

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    apify: Boolean(process.env.APIFY_TOKEN),
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    model: process.env.OPENROUTER_MODEL || 'openai/gpt-5.6-luna'
  });
});

app.post('/api/scrape', (req, res) => {
  const keyword = String(req.body?.keyword ?? '').trim();

  if (keyword.length < 2 || keyword.length > 160) {
    return res.status(400).json({
      error: 'Keyword must be between 2 and 160 characters.'
    });
  }

  if (!process.env.APIFY_TOKEN) {
    return res.status(500).json({
      error: 'APIFY_TOKEN is not configured on the server.'
    });
  }

  const jobId = crypto.randomUUID();

  const job = {
    id: jobId,
    keyword,
    status: 'running',
    createdAt: Date.now(),
    actors: {
      twitter: { status: 'queued', label: 'X / Twitter' },
      instagram: { status: 'queued', label: 'Instagram' },
      web: { status: 'queued', label: 'Web research' }
    }
  };

  jobs.set(jobId, job);

  scrapeAll(keyword, (progress) => {
    const current = jobs.get(jobId);
    if (!current) return;
    current.actors = progress.actors;
  })
    .then((result) => {
      const current = jobs.get(jobId);
      if (!current) return;
      Object.assign(current, {
        status: 'done',
        data: result.data,
        analytics: result.analytics,
        counts: result.counts,
        errors: result.errors,
        finishedAt: Date.now()
      });
    })
    .catch((err) => {
      const current = jobs.get(jobId);
      if (!current) return;
      current.status = 'error';
      current.error = err.message;
    });

  res.status(202).json({ jobId });
});

app.get('/api/scrape/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired.' });
  }

  res.json({
    id: job.id,
    keyword: job.keyword,
    status: job.status,
    actors: job.actors,
    counts: job.counts,
    analytics: job.analytics,
    errors: job.errors,
    error: job.error,
    // Only send the full dataset once the job is complete.
    data: job.status === 'done' ? job.data : undefined
  });
});

app.post('/api/dashboard', async (req, res) => {
  const job = jobs.get(String(req.body?.jobId ?? ''));
  if (!job || job.status !== 'done') {
    return res.status(400).json({ error: 'Analysis is not ready.' });
  }

  try {
    if (!job.spec || req.body?.regenerate) {
      job.spec = await generateDashboard(job);
    }
    res.json(job.spec);
  } catch (err) {
    console.error('Dashboard generation error:', err);
    res.status(500).json({ error: 'Dashboard generation failed.' });
  }
});

app.post('/api/chat', async (req, res) => {
  const job = jobs.get(String(req.body?.jobId ?? ''));
  if (!job || job.status !== 'done') {
    return res.status(400).json({ error: 'Run an analysis first.' });
  }

  const question = String(req.body?.question ?? '').trim().slice(0, 2000);
  if (!question) {
    return res.status(400).json({ error: 'Question is empty.' });
  }

  const history = Array.isArray(req.body?.history) ? req.body.history : [];

  try {
    const answer = await chatAboutJob(job, question, history);
    res.json({ answer });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'The analyst is temporarily unavailable.' });
  }
});

// Expire jobs after one hour.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, () => {
  console.log(`Keyword Intelligence Studio → http://localhost:${PORT}`);
  if (!process.env.APIFY_TOKEN) console.warn('⚠  APIFY_TOKEN is missing');
  if (!process.env.OPENROUTER_API_KEY) console.warn('⚠  OPENROUTER_API_KEY is missing');
});