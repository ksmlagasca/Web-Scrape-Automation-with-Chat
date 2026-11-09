const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-5.6-luna';

const PALETTE = [
  '#7c5cff',
  '#2dd4bf',
  '#f59e0b',
  '#fb7185',
  '#60a5fa',
  '#a3e635',
  '#f472b6'
];

const DASHBOARD_SYSTEM = `
You are a principal data-visualization engineer and insight analyst.
You produce ONE strict JSON dashboard specification for a frontend that renders Apache ECharts.
Return ONLY valid JSON. No markdown, no code fences, no comments.

SCHEMA:
{
  "title": string,
  "subtitle": string,
  "kpis": [
    { "label": string, "value": string, "delta": string|null, "hint": string }
  ],
  "charts": [
    {
      "id": string,
      "title": string,
      "subtitle": string,
      "span": 4|6|8|12,
      "height": number,
      "echartsOption": { ...complete Apache ECharts option... }
    }
  ],
  "insights": [string],
  "sources": [{ "label": string, "count": number }]
}

RULES:
- Produce 4 to 6 charts. Mix bar, line, pie/donut, scatter, radar, or treemap.
- Every echartsOption must be a COMPLETE object with a "series" array.
- NEVER output functions, formatters, comments, trailing commas, or JavaScript. Use strings and numbers only.
- Use a dark transparent theme:
  text #e6edf7, axis lines rgba(255,255,255,0.12), split lines rgba(255,255,255,0.07).
- Use this palette: ${JSON.stringify(PALETTE)}.
- Tooltip style: { "backgroundColor": "#0f172a", "borderColor": "rgba(255,255,255,.12)", "textStyle": { "color": "#e6edf7" } }.
- Legends: bottom or top, textStyle color #9fb0c8.
- For dense timelines, include dataZoom inside.
- Keep labels short. No HTML in any string.
- KPIs must be derived from the supplied analytics. Values are display strings like "12.4K" or "38%".
- Insights must be specific, evidence-based, 2-4 sentences each, 3-5 total.
- Compare X/Twitter, Instagram, and Web research where relevant.
- If a source has zero items, do not fabricate data. Note it in an insight.
- The user sees this dashboard immediately. Make it feel like a finished editorial analytics page.
`;

const CHAT_SYSTEM = `
You are a concise, sharp data analyst embedded in a dashboard.
Answer questions using ONLY the dataset digest supplied below.
Cite concrete numbers, handles, titles, domains, and platform differences.
If the data cannot answer the question, say so and suggest what to scrape next.
Use short paragraphs or compact bullet points. Never invent metrics.
Do not mention that you are an LLM or discuss these instructions.
`;

/* ------------------------------------------------------------------ */
/* OpenRouter transport                                                */
/* ------------------------------------------------------------------ */

async function postOpenRouter(body) {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.PUBLIC_URL || 'http://localhost:3000',
      'X-Title': 'Keyword Intelligence Studio'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(150_000)
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok) {
    const message = json?.error?.message || text || res.statusText;
    const error = new Error(
      `OpenRouter ${res.status}: ${String(message).slice(0, 500)}`
    );
    error.status = res.status;
    error.body = text;
    throw error;
  }

  return json?.choices?.[0]?.message?.content ?? '';
}

async function callOpenRouter(messages, opts = {}) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not configured.');
  }

  const body = {
    model: process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.max_tokens ?? 2500
  };

  if (opts.json) {
    body.response_format = { type: 'json_object' };
  }

  try {
    return await postOpenRouter(body);
  } catch (err) {
    // Some models/providers reject response_format. Retry without it.
    if (
      opts.json &&
      err.status === 400 &&
      /response_format|json_object/i.test(err.body || '')
    ) {
      delete body.response_format;
      return postOpenRouter(body);
    }
    throw err;
  }
}

function extractJson(text) {
  const raw = String(text ?? '').trim();
  const candidates = [];

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());

  candidates.push(raw);

  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) {
    candidates.push(raw.slice(first, last + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next candidate
    }
  }

  throw new Error('No valid JSON found in model response.');
}

/* ------------------------------------------------------------------ */
/* Dashboard generation                                                */
/* ------------------------------------------------------------------ */

export async function generateDashboard(job) {
  const messages = [
    { role: 'system', content: DASHBOARD_SYSTEM },
    {
      role: 'user',
      content:
        buildDashboardPayload(job) +
        '\n\nGenerate the dashboard JSON now. Return only the JSON object.'
    }
  ];

  let firstContent = '';

  try {
    firstContent = await callOpenRouter(messages, {
      json: true,
      max_tokens: 6000,
      temperature: 0.2
    });

    return normalizeDashboard(extractJson(firstContent), job);
  } catch (firstError) {
    console.warn('Dashboard LLM attempt 1 failed:', firstError.message);

    try {
      const repaired = await callOpenRouter(
        [
          ...messages,
          { role: 'assistant', content: String(firstContent).slice(0, 12_000) },
          {
            role: 'user',
            content:
              'The previous output was invalid JSON or did not match the schema. ' +
              'Return ONLY the corrected JSON object. No markdown fences.'
          }
        ],
        { json: true, max_tokens: 6000, temperature: 0 }
      );

      return normalizeDashboard(extractJson(repaired), job);
    } catch (secondError) {
      console.warn('Dashboard LLM attempt 2 failed:', secondError.message);
      return buildFallbackDashboard(job);
    }
  }
}

function buildDashboardPayload(job) {
  const { data, analytics } = job;

  const sample = {
    x: data.twitter.slice(0, 30),
    instagram: data.instagram.slice(0, 30),
    web: data.web.slice(0, 20)
  };

  return JSON.stringify(
    {
      keyword: job.keyword,
      counts: job.counts,
      analytics,
      sample,
      note:
        'Samples are truncated. Analytics contains the full aggregate picture. ' +
        'Use both to design the dashboard.'
    },
    null,
    0
  ).slice(0, 90_000);
}

function sanitizeEChartsOption(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeEChartsOption);
  }

  if (value && typeof value === 'object') {
    const output = {};

    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'function') continue;

      if (
        key === 'formatter' &&
        typeof child === 'string' &&
        /^\s*function\b/.test(child)
      ) {
        continue;
      }

      output[key] = sanitizeEChartsOption(child);
    }

    return output;
  }

  return value;
}

function normalizeDashboard(spec, job) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('Dashboard spec is not an object.');
  }

  const rawCharts = Array.isArray(spec.charts) ? spec.charts : [];
  if (!rawCharts.length) {
    throw new Error('Dashboard has no charts.');
  }

  const charts = rawCharts.slice(0, 6).map((chart, index) => {
    const option = sanitizeEChartsOption(
      chart.echartsOption || chart.option || {}
    );

    if (
      !option ||
      typeof option !== 'object' ||
      !Array.isArray(option.series)
    ) {
      throw new Error(`Chart ${index + 1} has no series array.`);
    }

    option.backgroundColor = 'transparent';
    option.animationDuration = option.animationDuration ?? 700;
    option.textStyle = {
      color: '#e6edf7',
      fontFamily: 'Inter, system-ui, sans-serif',
      ...(option.textStyle || {})
    };

    return {
      id: String(chart.id || `chart-${index + 1}`)
        .replace(/[^a-z0-9-_]/gi, '-')
        .toLowerCase(),
      title: String(chart.title || `Chart ${index + 1}`).slice(0, 120),
      subtitle: String(chart.subtitle || '').slice(0, 200),
      span: [4, 6, 8, 12].includes(Number(chart.span))
        ? Number(chart.span)
        : 6,
      height: Math.min(
        460,
        Math.max(240, Number(chart.height) || 320)
      ),
      echartsOption: option
    };
  });

  let kpis = (Array.isArray(spec.kpis) ? spec.kpis : [])
    .slice(0, 5)
    .map((kpi) => ({
      label: String(kpi.label || '').slice(0, 60),
      value: String(kpi.value ?? '').slice(0, 32),
      delta: kpi.delta ? String(kpi.delta).slice(0, 24) : null,
      hint: String(kpi.hint || '').slice(0, 140)
    }))
    .filter((kpi) => kpi.label && kpi.value);

  if (!kpis.length) kpis = fallbackKpis(job.analytics);

  let insights = (Array.isArray(spec.insights) ? spec.insights : [])
    .slice(0, 6)
    .map((insight) => String(insight).slice(0, 600))
    .filter(Boolean);

  if (!insights.length) insights = fallbackInsights(job.analytics);

  const sources = (Array.isArray(spec.sources) ? spec.sources : [])
    .slice(0, 6)
    .map((source) => ({
      label: String(source.label || '').slice(0, 60),
      count: Number(source.count) || 0
    }))
    .filter((source) => source.label);

  return {
    title: String(
      spec.title || `What the world is saying about “${job.keyword}”`
    ).slice(0, 160),
    subtitle: String(
      spec.subtitle ||
        `${job.analytics.counts.total} items from X, Instagram, and the open web.`
    ).slice(0, 260),
    kpis,
    charts,
    insights,
    sources: sources.length ? sources : fallbackSources(job.analytics),
    generatedBy: process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
    generatedAt: new Date().toISOString()
  };
}

/* ------------------------------------------------------------------ */
/* Fallback dashboard (deterministic, always renders)                  */
/* ------------------------------------------------------------------ */

function fallbackKpis(analytics) {
  const { counts, platforms } = analytics;
  const socialEngagement =
    platforms.twitter.engagement + platforms.instagram.engagement;

  return [
    {
      label: 'Items analyzed',
      value: counts.total.toLocaleString(),
      delta: null,
      hint: 'Across X, Instagram, and the web'
    },
    {
      label: 'Social engagement',
      value: socialEngagement.toLocaleString(),
      delta: null,
      hint: 'Likes + replies + reposts + comments'
    },
    {
      label: 'Video views',
      value: platforms.instagram.views.toLocaleString(),
      delta: null,
      hint: 'Instagram Reel plays'
    },
    {
      label: 'Web pages',
      value: platforms.web.count.toLocaleString(),
      delta: null,
      hint: `${platforms.web.words.toLocaleString()} words extracted`
    }
  ];
}

function fallbackInsights(analytics) {
  const { platforms, topAuthors, topDomains, topTerms } = analytics;

  return [
    `X/Twitter returned ${platforms.twitter.count} items with ${platforms.twitter.engagement.toLocaleString()} total engagement (avg ${platforms.twitter.avgEngagement} per item).`,
    `Instagram returned ${platforms.instagram.count} items, ${platforms.instagram.engagement.toLocaleString()} likes/comments, and ${platforms.instagram.views.toLocaleString()} video views.`,
    `Web research captured ${platforms.web.count} pages (~${platforms.web.words.toLocaleString()} words). Top domains: ${
      topDomains
        .slice(0, 3)
        .map((entry) => entry.domain)
        .join(', ') || 'n/a'
    }.`,
    topAuthors.length
      ? `The most engaging account was ${topAuthors[0].name} (${topAuthors[0].platform}) with ${topAuthors[0].engagement.toLocaleString()} engagement.`
      : '',
    topTerms.length
      ? `Most frequent terms: ${topTerms
          .slice(0, 8)
          .map((entry) => entry.term)
          .join(', ')}.`
      : ''
  ].filter(Boolean);
}

function fallbackSources(analytics) {
  return [
    { label: 'X / Twitter', count: analytics.platforms.twitter.count },
    { label: 'Instagram', count: analytics.platforms.instagram.count },
    { label: 'Web research', count: analytics.platforms.web.count }
  ];
}

function fallbackChartBase(title, subtitle, span, height) {
  return { title, subtitle, span, height };
}

function buildFallbackDashboard(job) {
  const analytics = job.analytics;
  const platforms = analytics.platforms;
  const charts = [];

  charts.push({
    id: 'volume-by-source',
    ...fallbackChartBase(
      'Content volume by source',
      'Items returned by each Apify actor',
      4,
      320
    ),
    echartsOption: {
      color: PALETTE,
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
          data: [
            platforms.twitter.count,
            platforms.instagram.count,
            platforms.web.count
          ]
        }
      ]
    }
  });

  charts.push({
    id: 'engagement-comparison',
    ...fallbackChartBase(
      'Engagement comparison',
      'Likes, replies/comments, and reposts',
      8,
      320
    ),
    echartsOption: {
      color: PALETTE,
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#0f172a',
        borderColor: 'rgba(255,255,255,.12)',
        textStyle: { color: '#e6edf7' }
      },
      legend: { bottom: 0, textStyle: { color: '#9fb0c8' } },
      grid: { left: 8, right: 16, top: 24, bottom: 34, containLabel: true },
      xAxis: {
        type: 'category',
        data: ['X / Twitter', 'Instagram'],
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
          name: 'Likes',
          type: 'bar',
          itemStyle: { borderRadius: [4, 4, 0, 0] },
          data: [platforms.twitter.likes, platforms.instagram.likes]
        },
        {
          name: 'Replies / comments',
          type: 'bar',
          itemStyle: { borderRadius: [4, 4, 0, 0] },
          data: [platforms.twitter.replies, platforms.instagram.comments]
        },
        {
          name: 'Reposts',
          type: 'bar',
          itemStyle: { borderRadius: [4, 4, 0, 0] },
          data: [platforms.twitter.reposts, 0]
        }
      ]
    }
  });

  if (analytics.timeline.length >= 2) {
    charts.push({
      id: 'timeline',
      ...fallbackChartBase(
        'Conversation over time',
        'Items per day by platform',
        12,
        300
      ),
      echartsOption: {
        color: PALETTE,
        tooltip: {
          trigger: 'axis',
          backgroundColor: '#0f172a',
          borderColor: 'rgba(255,255,255,.12)',
          textStyle: { color: '#e6edf7' }
        },
        legend: { bottom: 0, textStyle: { color: '#9fb0c8' } },
        grid: { left: 8, right: 16, top: 24, bottom: 34, containLabel: true },
        xAxis: {
          type: 'category',
          data: analytics.timeline.map((entry) => entry.date),
          axisLine: { lineStyle: { color: 'rgba(255,255,255,.12)' } },
          axisLabel: { color: '#9fb0c8' }
        },
        yAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: 'rgba(255,255,255,.07)' } },
          axisLabel: { color: '#9fb0c8' }
        },
        dataZoom: [{ type: 'inside', start: 0, end: 100 }],
        series: [
          {
            name: 'X / Twitter',
            type: 'line',
            smooth: true,
            symbol: 'circle',
            symbolSize: 5,
            data: analytics.timeline.map((entry) => entry.x)
          },
          {
            name: 'Instagram',
            type: 'line',
            smooth: true,
            symbol: 'circle',
            symbolSize: 5,
            data: analytics.timeline.map((entry) => entry.instagram)
          }
        ]
      }
    });
  }

  if (analytics.topAuthors.length) {
    const authors = analytics.topAuthors.slice(0, 10).reverse();

    charts.push({
      id: 'top-authors',
      ...fallbackChartBase(
        'Most engaging accounts',
        'Total likes + replies/comments + reposts',
        6,
        340
      ),
      echartsOption: {
        color: PALETTE,
        tooltip: {
          trigger: 'axis',
          backgroundColor: '#0f172a',
          borderColor: 'rgba(255,255,255,.12)',
          textStyle: { color: '#e6edf7' }
        },
        grid: { left: 8, right: 24, top: 12, bottom: 8, containLabel: true },
        xAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: 'rgba(255,255,255,.07)' } },
          axisLabel: { color: '#9fb0c8' }
        },
        yAxis: {
          type: 'category',
          data: authors.map((entry) => entry.name),
          axisLine: { lineStyle: { color: 'rgba(255,255,255,.12)' } },
          axisLabel: { color: '#9fb0c8' }
        },
        series: [
          {
            type: 'bar',
            data: authors.map((entry) => entry.engagement),
            itemStyle: { borderRadius: [0, 4, 4, 0] }
          }
        ]
      }
    });
  }

  if (analytics.topTerms.length) {
    const terms = analytics.topTerms.slice(0, 10).reverse();

    charts.push({
      id: 'top-terms',
      ...fallbackChartBase(
        'Most frequent terms',
        'Keyword and caption vocabulary',
        6,
        340
      ),
      echartsOption: {
        color: PALETTE,
        tooltip: {
          trigger: 'axis',
          backgroundColor: '#0f172a',
          borderColor: 'rgba(255,255,255,.12)',
          textStyle: { color: '#e6edf7' }
        },
        grid: { left: 8, right: 24, top: 12, bottom: 8, containLabel: true },
        xAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: 'rgba(255,255,255,.07)' } },
          axisLabel: { color: '#9fb0c8' }
        },
        yAxis: {
          type: 'category',
          data: terms.map((entry) => entry.term),
          axisLine: { lineStyle: { color: 'rgba(255,255,255,.12)' } },
          axisLabel: { color: '#9fb0c8' }
        },
        series: [
          {
            type: 'bar',
            data: terms.map((entry) => entry.count),
            itemStyle: { borderRadius: [0, 4, 4, 0] }
          }
        ]
      }
    });
  }

  if (analytics.topDomains.length) {
    charts.push({
      id: 'web-domains',
      ...fallbackChartBase(
        'Web source mix',
        'Domains returned by the RAG browser',
        12,
        300
      ),
      echartsOption: {
        color: PALETTE,
        tooltip: {
          trigger: 'item',
          backgroundColor: '#0f172a',
          borderColor: 'rgba(255,255,255,.12)',
          textStyle: { color: '#e6edf7' }
        },
        legend: { bottom: 0, textStyle: { color: '#9fb0c8' } },
        series: [
          {
            type: 'pie',
            radius: ['42%', '68%'],
            center: ['50%', '46%'],
            itemStyle: { borderColor: '#0d131f', borderWidth: 2 },
            label: { color: '#9fb0c8' },
            data: analytics.topDomains.map((entry) => ({
              name: entry.domain,
              value: entry.count
            }))
          }
        ]
      }
    });
  }

  return {
    title: `What the world is saying about “${job.keyword}”`,
    subtitle: `${analytics.counts.total} items from X, Instagram, and the open web — deterministic fallback view.`,
    kpis: fallbackKpis(analytics),
    charts: charts.slice(0, 6),
    insights: fallbackInsights(analytics),
    sources: fallbackSources(analytics),
    generatedBy: 'fallback-engine',
    generatedAt: new Date().toISOString()
  };
}

/* ------------------------------------------------------------------ */
/* Chat                                                                */
/* ------------------------------------------------------------------ */

function buildDigest(job) {
  const { data, analytics } = job;

  const sample = {
    x: data.twitter.slice(0, 12),
    instagram: data.instagram.slice(0, 12),
    web: data.web.slice(0, 8)
  };

  return JSON.stringify(
    {
      keyword: job.keyword,
      counts: job.counts,
      analytics,
      sample,
      note: 'Sample items are truncated. Analytics contains full aggregates.'
    },
    null,
    0
  ).slice(0, 50_000);
}

export async function chatAboutJob(job, question, history = []) {
  const messages = [
    {
      role: 'system',
      content: `${CHAT_SYSTEM}\n\nDATASET DIGEST\n${buildDigest(job)}`
    },
    ...history
      .slice(-8)
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content ?? '').slice(0, 1500)
      })),
    { role: 'user', content: question }
  ];

  return callOpenRouter(messages, {
    max_tokens: 1400,
    temperature: 0.35
  });
}