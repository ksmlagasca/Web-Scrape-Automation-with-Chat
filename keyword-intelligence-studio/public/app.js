/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  jobId: null,
  keyword: null,
  data: null,
  analytics: null,
  spec: null,
  charts: [],
  chat: [],
  chatInitialized: false,
  regenerating: false
};

/* ------------------------------------------------------------------ */
/* Search + blocker                                                    */
/* ------------------------------------------------------------------ */

const searchForm = $('#search-form');
const keywordInput = $('#keyword');
const blocker = $('#blocker');
const progressFill = $('#progress-fill');

let elapsedTimer = null;

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  startAnalysis(keywordInput.value);
});

$$('.example-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    keywordInput.value = chip.dataset.keyword;
    startAnalysis(chip.dataset.keyword);
  });
});

async function startAnalysis(rawKeyword) {
  const keyword = String(rawKeyword ?? '').trim();

  if (keyword.length < 2) {
    showToast('Enter at least 2 characters.', 'error');
    return;
  }

  // Reset previous run state.
  disposeCharts();
  state.jobId = null;
  state.keyword = keyword;
  state.data = null;
  state.analytics = null;
  state.spec = null;
  state.chat = [];
  state.chatInitialized = false;
  $('#chat-messages').innerHTML = '';
  $('#dashboard').hidden = true;
  $('#empty-state').hidden = true;

  showBlocker(keyword);
  resetBlockerSteps();

  try {
    const response = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Failed to start the scrape.');
    }

    const { jobId } = await response.json();
    state.jobId = jobId;

    await pollJob(jobId);
  } catch (error) {
    hideBlocker();
    showToast(error.message, 'error');
  }
}

async function pollJob(jobId) {
  let attempts = 0;

  while (attempts < 200) {
    attempts += 1;

    const response = await fetch(`/api/scrape/${jobId}`);
    if (!response.ok) {
      throw new Error('Lost contact with the scrape job.');
    }

    const job = await response.json();
    updateBlocker(job);

    if (job.status === 'done') {
      state.data = job.data;
      state.analytics = job.analytics;
      state.keyword = job.keyword;

      setSynthesizingStage();

      try {
        const spec = await requestDashboard(jobId, false);
        state.spec = spec;
        hideBlocker();
        renderDashboard(spec);
        showToast(
          `Dashboard ready — ${job.analytics.counts.total} items analyzed.`,
          'success'
        );
      } catch (error) {
        // Render a minimal client-side view so the user is never stuck.
        hideBlocker();
        const fallback = basicSpecFromJob(job);
        renderDashboard(fallback);
        showToast(
          'Dashboard synthesis failed — showing a basic view. Try Re-synthesize.',
          'error'
        );
      }

      if (job.errors?.length) {
        showToast(
          `${job.errors.length} source(s) failed: ${job.errors
            .map((entry) => entry.key)
            .join(', ')}. Other sources rendered.`,
          'error'
        );
      }

      return;
    }

    if (job.status === 'error') {
      throw new Error(job.error || 'The scrape failed.');
    }

    await sleep(1400);
  }

  throw new Error('The scrape took too long. Try a narrower keyword.');
}

async function requestDashboard(jobId, regenerate) {
  const response = await fetch('/api/dashboard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, regenerate })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Dashboard generation failed.');
  }

  return response.json();
}

/* ------------------------------------------------------------------ */
/* Blocker UI                                                          */
/* ------------------------------------------------------------------ */

function showBlocker(keyword) {
  $('#blocker-keyword').textContent = keyword;
  $('#blocker-sub').textContent = 'Starting three actors in parallel…';
  blocker.hidden = false;
  document.body.classList.add('blocked');
  startElapsed();
}

function hideBlocker() {
  blocker.hidden = true;
  document.body.classList.remove('blocked');
  clearInterval(elapsedTimer);
}

function startElapsed() {
  const startedAt = Date.now();
  clearInterval(elapsedTimer);
  $('#elapsed').textContent = '0s';

  elapsedTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    $('#elapsed').textContent = `${seconds}s`;
  }, 1000);
}

function resetBlockerSteps() {
  ['twitter', 'instagram', 'web', 'synthesize'].forEach((key) => {
    const step = $(`#step-${key}`);
    step.dataset.status = 'queued';
    step.querySelector('.step-meta').textContent =
      key === 'synthesize' ? 'Waiting' : 'Queued';
  });

  progressFill.style.width = '8%';
}

function updateBlocker(job) {
  const actorKeys = ['twitter', 'instagram', 'web'];
  let finished = 0;

  for (const key of actorKeys) {
    const step = $(`#step-${key}`);
    const actor = job.actors?.[key];
    const status = actor?.status || 'queued';

    step.dataset.status = status;

    let meta = 'Queued';
    if (status === 'running') meta = 'Scraping…';
    if (status === 'done') meta = `${actor.count ?? 0} items`;
    if (status === 'error') meta = 'Failed';
    step.querySelector('.step-meta').textContent = meta;

    if (status === 'done' || status === 'error') finished += 1;
  }

  const percent = Math.min(85, 12 + finished * 24);
  progressFill.style.width = `${percent}%`;

  if (finished < 3) {
    $('#blocker-sub').textContent =
      'Apify is collecting up to 100 items per source…';
  }
}

function setSynthesizingStage() {
  progressFill.style.width = '92%';
  $('#blocker-sub').textContent =
    'GPT-5.6 Luna is reading the dataset and designing the dashboard…';

  const step = $('#step-synthesize');
  step.dataset.status = 'running';
  step.querySelector('.step-meta').textContent = 'Designing…';

  const completed = $('#step-twitter').dataset.status === 'done' ||
    $('#step-instagram').dataset.status === 'done' ||
    $('#step-web').dataset.status === 'done';

  if (completed) {
    // Keep the completed actor states, but mark synthesis as active.
    step.dataset.status = 'running';
  }
}

/* ------------------------------------------------------------------ */
/* Dashboard rendering                                                 */
/* ------------------------------------------------------------------ */

function renderDashboard(spec, options = {}) {
  state.spec = spec;

  $('#empty-state').hidden = true;
  $('#dashboard').hidden = false;

  $('#dashboard-title').textContent = spec.title || 'Dashboard';
  $('#dashboard-subtitle').textContent = spec.subtitle || '';
  $('#keyword-chip').textContent = `“${state.keyword || ''}”`;

  const timestamp = new Date(spec.generatedAt || Date.now());
  $('#dashboard-timestamp').textContent = `Synthesized ${timestamp.toLocaleString()}${
    spec.generatedBy ? ` · ${spec.generatedBy}` : ''
  }`;

  renderSourcePills(spec);
  renderKpis(spec.kpis || []);
  renderInsights(spec.insights || []);
  renderCharts(spec.charts || []);
  renderRawData(state.data);

  if (!options.keepScroll) {
    $('#dashboard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function renderSourcePills(spec) {
  const container = $('#source-pills');
  container.innerHTML = '';

  const sources = spec.sources?.length
    ? spec.sources
    : (state.data
        ? [
            { label: 'X / Twitter', count: state.data.twitter.length },
            { label: 'Instagram', count: state.data.instagram.length },
            { label: 'Web', count: state.data.web.length }
          ]
        : []);

  for (const source of sources) {
    const pill = document.createElement('span');
    pill.className = 'source-pill';
    pill.innerHTML = `${esc(source.label)} <strong>${Number(
      source.count || 0
    ).toLocaleString()}</strong>`;
    container.appendChild(pill);
  }
}

function renderKpis(kpis) {
  const grid = $('#kpi-grid');
  grid.innerHTML = '';

  kpis.forEach((kpi, index) => {
    const card = document.createElement('article');
    card.className = 'kpi-card';
    card.style.animationDelay = `${index * 60}ms`;

    card.innerHTML = `
      <p class="kpi-label">${esc(kpi.label)}</p>
      <p class="kpi-value">${esc(kpi.value)}</p>
      ${kpi.delta ? `<span class="kpi-delta">${esc(kpi.delta)}</span>` : ''}
      ${kpi.hint ? `<p class="kpi-hint">${esc(kpi.hint)}</p>` : ''}
    `;

    grid.appendChild(card);
  });
}

function renderInsights(insights) {
  const panel = $('#insights-panel');
  panel.innerHTML = '';

  if (!insights.length) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;

  const heading = document.createElement('h3');
  heading.textContent = 'What stands out';
  panel.appendChild(heading);

  const list = document.createElement('ol');
  list.className = 'insights-list';

  insights.forEach((insight, index) => {
    const item = document.createElement('li');
    item.className = 'insight-item';
    item.innerHTML = `
      <span class="insight-index">${String(index + 1).padStart(2, '0')}</span>
      <span>${esc(insight)}</span>
    `;
    list.appendChild(item);
  });

  panel.appendChild(list);
}

function renderCharts(charts) {
  disposeCharts();

  const grid = $('#chart-grid');
  grid.innerHTML = '';

  if (!window.echarts) {
    grid.innerHTML =
      '<p class="chart-error">ECharts failed to load. Check your network and refresh.</p>';
    return;
  }

  charts.forEach((chart, index) => {
    const card = document.createElement('article');
    const span = [4, 6, 8, 12].includes(Number(chart.span))
      ? Number(chart.span)
      : 6;
    card.className = `chart-card span-${span}`;
    card.style.animationDelay = `${index * 60}ms`;

    const head = document.createElement('div');
    head.className = 'chart-head';

    const titles = document.createElement('div');
    titles.innerHTML = `
      <h3>${esc(chart.title || 'Untitled chart')}</h3>
      ${chart.subtitle ? `<p>${esc(chart.subtitle)}</p>` : ''}
    `;

    const actions = document.createElement('div');
    actions.className = 'chart-actions';

    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.className = 'icon-btn';
    downloadButton.title = 'Download PNG';
    downloadButton.setAttribute('aria-label', 'Download chart as PNG');
    downloadButton.innerHTML = `
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
        <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    `;

    actions.appendChild(downloadButton);
    head.append(titles, actions);

    const canvas = document.createElement('div');
    canvas.className = 'chart-canvas';
    canvas.style.height = `${chart.height || 320}px`;

    card.append(head, canvas);
    grid.appendChild(card);

    let instance = null;

    try {
      instance = window.echarts.init(canvas, null, { renderer: 'canvas' });
      instance.setOption(chart.echartsOption || {}, true);
      state.charts.push(instance);
    } catch (error) {
      console.warn('Chart render failed:', error);
      canvas.innerHTML =
        '<div class="chart-error">Could not render this chart.</div>';
    }

    downloadButton.addEventListener('click', () => {
      if (!instance) return;
      const url = instance.getDataURL({
        type: 'png',
        pixelRatio: 2,
        backgroundColor: '#0d131f'
      });
      const link = document.createElement('a');
      link.href = url;
      link.download = `${slugify(chart.title || 'chart')}.png`;
      link.click();
    });
  });

  // Ensure charts fill their cards after layout settles.
  requestAnimationFrame(() => {
    state.charts.forEach((chart) => chart.resize());
  });
}

function disposeCharts() {
  state.charts.forEach((chart) => {
    try {
      chart.dispose();
    } catch {
      // ignore
    }
  });
  state.charts = [];
}

function renderRawData(data) {
  const panel = $('#raw-panel');
  const tabs = $('#raw-tabs');
  const pre = $('#raw-pre');

  if (!data) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;

  const groups = [
    { key: 'twitter', label: 'X / Twitter', items: data.twitter || [] },
    { key: 'instagram', label: 'Instagram', items: data.instagram || [] },
    { key: 'web', label: 'Web', items: data.web || [] }
  ];

  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  $('#raw-count').textContent = `${total.toLocaleString()} items`;

  tabs.innerHTML = '';

  const show = (key) => {
    const group = groups.find((entry) => entry.key === key);
    pre.textContent = JSON.stringify(group?.items ?? [], null, 2);

    [...tabs.children].forEach((button) => {
      button.classList.toggle('active', button.dataset.key === key);
    });
  };

  groups.forEach((group) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'raw-tab';
    button.dataset.key = group.key;
    button.textContent = `${group.label} (${group.items.length})`;
    button.addEventListener('click', () => show(group.key));
    tabs.appendChild(button);
  });

  show('twitter');
}

function basicSpecFromJob(job) {
  const counts = job.analytics?.counts || {
    x: job.data?.twitter?.length || 0,
    instagram: job.data?.instagram?.length || 0,
    web: job.data?.web?.length || 0,
    total:
      (job.data?.twitter?.length || 0) +
      (job.data?.instagram?.length || 0) +
      (job.data?.web?.length || 0)
  };

  return {
    title: `What the world is saying about “${job.keyword}”`,
    subtitle:
      'A minimal client-side view. Use Re-synthesize to retry the LLM dashboard.',
    kpis: [
      {
        label: 'Items analyzed',
        value: String(counts.total),
        delta: null,
        hint: 'X + Instagram + Web'
      },
      {
        label: 'X / Twitter',
        value: String(counts.x),
        delta: null,
        hint: 'Posts returned'
      },
      {
        label: 'Instagram Reels',
        value: String(counts.instagram),
        delta: null,
        hint: 'Reels returned'
      },
      {
        label: 'Web pages',
        value: String(counts.web),
        delta: null,
        hint: 'Pages extracted'
      }
    ],
    charts: [
      {
        id: 'volume',
        title: 'Content volume by source',
        subtitle: 'Items returned by each actor',
        span: 12,
        height: 320,
        echartsOption: {
          color: ['#7c5cff', '#2dd4bf', '#f59e0b'],
          tooltip: {
            trigger: 'axis',
            backgroundColor: '#0f172a',
            borderColor: 'rgba(255,255,255,.12)',
            textStyle: { color: '#e6edf7' }
          },
          grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
          xAxis: {
            type: 'category',
            data: ['X / Twitter', 'Instagram', 'Web'],
            axisLine: { lineStyle: { color: 'rgba(255,255,255,.12)' } },
            axisLabel: { color: '#9fb0c8' }
          },
          yAxis: {
            type: 'value',
            splitLine: { lineStyle: { color: 'rgba(255,255,255,.07)' } },
            axisLabel: { color: '#9fb0c8' }
          },
          series: [
            {
              type: 'bar',
              colorBy: 'data',
              barWidth: '46%',
              itemStyle: { borderRadius: [6, 6, 0, 0] },
              data: [counts.x, counts.instagram, counts.web]
            }
          ]
        }
      }
    ],
    insights: [
      'The LLM dashboard could not be generated, so this basic view shows the raw source volumes.',
      'The full dataset is still available below under “Explore the raw data”.'
    ],
    sources: [
      { label: 'X / Twitter', count: counts.x },
      { label: 'Instagram', count: counts.instagram },
      { label: 'Web', count: counts.web }
    ],
    generatedBy: 'client-fallback',
    generatedAt: new Date().toISOString()
  };
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'chart';
}

/* ------------------------------------------------------------------ */
/* Re-synthesize                                                       */
/* ------------------------------------------------------------------ */

$('#regenerate-btn').addEventListener('click', async () => {
  if (!state.jobId || state.regenerating) return;

  state.regenerating = true;
  const button = $('#regenerate-btn');
  button.disabled = true;
  button.classList.add('loading');

  try {
    const spec = await requestDashboard(state.jobId, true);
    renderDashboard(spec, { keepScroll: true });
    showToast('Dashboard re-synthesized with GPT-5.6 Luna.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    state.regenerating = false;
    button.disabled = false;
    button.classList.remove('loading');
  }
});

/* ------------------------------------------------------------------ */
/* Chatbot                                                             */
/* ------------------------------------------------------------------ */

const chatPanel = $('#chat-panel');
const chatFab = $('#chat-fab');
const chatClose = $('#chat-close');
const chatForm = $('#chat-form');
const chatInput = $('#chat-input');
const chatSend = $('#chat-send');
const chatMessages = $('#chat-messages');

chatFab.addEventListener('click', () => {
  chatPanel.hidden = !chatPanel.hidden;

  if (!chatPanel.hidden) {
    chatInput.focus();

    if (!state.chatInitialized) {
      addChatMessage(
        'assistant',
        'I’ve read this dataset. Ask me about engagement, narratives, outliers, or what to investigate next.'
      );
      state.chatInitialized = true;
    }
  }
});

chatClose.addEventListener('click', () => {
  chatPanel.hidden = true;
});

$$('#chat-suggestions button').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.q) sendChat(button.dataset.q);
  });
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  sendChat(chatInput.value);
});

async function sendChat(rawQuestion) {
  const question = String(rawQuestion ?? '').trim();
  if (!question) return;

  chatInput.value = '';

  if (!state.jobId || !state.data) {
    addChatMessage(
      'assistant',
      'Run an analysis first, then ask me anything about the scraped data.'
    );
    return;
  }

  addChatMessage('user', question);
  state.chat.push({ role: 'user', content: question });

  const typing = showTyping();
  setChatLoading(true);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: state.jobId,
        question,
        history: state.chat.slice(-9, -1)
      })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'The analyst is unavailable.');
    }

    const { answer } = await response.json();

    typing.remove();
    addChatMessage('assistant', answer || 'I could not produce an answer.');
    state.chat.push({ role: 'assistant', content: answer || '' });
  } catch (error) {
    typing.remove();
    addChatMessage('assistant', error.message);
  } finally {
    setChatLoading(false);
  }
}

/**
 * Converts markdown text to sanitized HTML.
 * Uses marked + DOMPurify when available, with a built-in fallback parser.
 */
function renderMarkdown(rawText) {
  const text = String(rawText ?? '');
  if (!text.trim()) return '';

  if (typeof marked !== 'undefined' && typeof marked.parse === 'function') {
    try {
      marked.setOptions({
        gfm: true,
        breaks: true
      });
      const rawHtml = marked.parse(text);
      if (typeof DOMPurify !== 'undefined' && typeof DOMPurify.sanitize === 'function') {
        return DOMPurify.sanitize(rawHtml, {
          ADD_ATTR: ['target', 'rel']
        });
      }
      return rawHtml;
    } catch (err) {
      console.warn('marked parse error, falling back:', err);
    }
  }

  return formatMarkdownFallback(text);
}

/**
 * Lightweight fallback parser for basic markdown elements.
 */
function formatMarkdownFallback(text) {
  let html = esc(text);

  // Fenced code blocks ```...```
  html = html.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  });

  // Inline code `...`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headers (####, ###, ##, #)
  html = html.replace(/^#### (.*?)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.*?)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.*?)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.*?)$/gm, '<h1>$1</h1>');

  // Bold (**text** or __text__)
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // Italic (*text* or _text_)
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/\b_([^_]+)_\b/g, '<em>$1</em>');

  // Blockquotes (> quote)
  html = html.replace(/^>\s?(.*?)$/gm, '<blockquote>$1</blockquote>');

  // Unordered list items (* or -)
  html = html.replace(/^[\*\-]\s+(.*?)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
  html = html.replace(/<\/ul>\s*<ul>/g, '');

  // Ordered list items (1. )
  html = html.replace(/^\d+\.\s+(.*?)$/gm, '<oli>$1</oli>');
  html = html.replace(/(<oli>[\s\S]*?<\/oli>)/g, '<ol>$1</ol>');
  html = html.replace(/<oli>/g, '<li>').replace(/<\/oli>/g, '</li>');
  html = html.replace(/<\/ol>\s*<ol>/g, '');

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // Paragraphs
  const paragraphs = html
    .split(/\n\s*\n/)
    .map((p) => {
      const trimmed = p.trim();
      if (!trimmed) return '';
      if (/^(<h[1-4]>|<pre>|<ul>|<ol>|<blockquote>)/.test(trimmed)) {
        return trimmed;
      }
      return `<p>${trimmed.replace(/\n/g, '<br />')}</p>`;
    })
    .filter(Boolean);

  return paragraphs.join('');
}

function addChatMessage(role, content) {
  const message = document.createElement('div');
  message.className = `msg ${role}`;
  if (role === 'assistant') {
    message.innerHTML = renderMarkdown(content);
    message.querySelectorAll('a').forEach((link) => {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    });
  } else {
    message.textContent = content;
  }
  chatMessages.appendChild(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showTyping() {
  const message = document.createElement('div');
  message.className = 'msg assistant typing';
  message.innerHTML =
    '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  chatMessages.appendChild(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return message;
}

function setChatLoading(loading) {
  chatSend.disabled = loading;
  chatInput.disabled = loading;
  if (!loading) chatInput.focus();
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

let toastTimer = null;

function showToast(message, type = 'info') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast show ${type}`;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = 'toast';
  }, 4800);
}

/* ------------------------------------------------------------------ */
/* Resize handling                                                     */
/* ------------------------------------------------------------------ */

let resizeTimer = null;

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    state.charts.forEach((chart) => {
      try {
        chart.resize();
      } catch {
        // ignore
      }
    });
  }, 150);
});