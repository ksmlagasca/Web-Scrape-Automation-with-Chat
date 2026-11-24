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
- Insights are shown under "What stands out". Do NOT just restate counts (e.g. "12 posts in X and 2 in YouTube").
  Read the actual text/titles in the samples and surface the STORIES and NARRATIVES: recurring themes, how the
  brand/topic is framed (positive, critical, neutral), notable events, claims, controversies, named people or
  organizations, and how the story differs between sources or domains. Quote or paraphrase specific headlines or
  passages as evidence, and use numbers only to support a narrative point.
- At least 2 of the insights must be narrative/story-driven. Include one on what the coverage implies for brand
  visibility (who owns the conversation, which sources dominate, what is missing).
- DONUT CHART REQUIREMENT: NEVER create a chart classifying items by platform/channel (e.g., Instagram vs. X/Twitter vs. Web research).
  Instead, include ONE donut chart (type "pie" with inner/outer radius like ["45%", "72%"]) that groups the results into
  2 to 4 common keyword topics / thematic clusters found across the web results (derived from the actual titles, text samples,
  and topTerms). Each slice must be a short, clear topic label with its count of matching pages or mentions.
- SOURCE ECOSYSTEM AT THE END: Make the LAST chart in the "charts" array a "Source ecosystem" chart showing the web domains
  or source mix (e.g. topDomains / publication ecosystem) from the results.
- Web research is the active source. Mention X/Twitter or Instagram only if they actually contain items in the payload;
  do not fabricate data or waste charts/insights on unused platforms.
- The user sees this dashboard immediately. Make it feel like a finished editorial analytics page.
`;

const CHAT_SYSTEM = `
You are a concise, sharp data analyst embedded in a dashboard.
Answer questions using ONLY the dataset digest supplied below.
Cite concrete numbers, handles, titles, domains, and platform differences.
If the data cannot answer the question, say so and suggest what to look up next.
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
  const hasX = (data.twitter?.length || 0) > 0;
  const hasIg = (data.instagram?.length || 0) > 0;

  const sample = { web: (data.web || []).slice(0, 20) };
  if (hasX) sample.x = data.twitter.slice(0, 30);
  if (hasIg) sample.instagram = data.instagram.slice(0, 30);

  const activePlatforms = { web: analytics.platforms.web };
  if (hasX) activePlatforms.twitter = analytics.platforms.twitter;
  if (hasIg) activePlatforms.instagram = analytics.platforms.instagram;

  const activeCounts = { web: job.counts.web, total: job.counts.total };
  if (hasX) activeCounts.x = job.counts.x;
  if (hasIg) activeCounts.instagram = job.counts.instagram;

  const filteredAnalytics = {
    counts: activeCounts,
    platforms: activePlatforms,
    topDomains: analytics.topDomains,
    topTerms: analytics.topTerms
  };
  if (analytics.topAuthors?.length) filteredAnalytics.topAuthors = analytics.topAuthors;
  if (analytics.timeline?.length) filteredAnalytics.timeline = analytics.timeline;
  if (analytics.dateRange) filteredAnalytics.dateRange = analytics.dateRange;

  return JSON.stringify(
    {
      keyword: job.keyword,
      counts: activeCounts,
      analytics: filteredAnalytics,
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
      spec.title || `Brand visibility for “${job.keyword}”`
    ).slice(0, 160),
    subtitle: String(
      spec.subtitle ||
        `${job.analytics.counts.total} public web pages synced.`
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
  const { platforms, topDomains } = analytics;

  return [
    {
      label: 'Pages synced',
      value: platforms.web.count.toLocaleString(),
      delta: null,
      hint: 'Public web pages found for this keyword'
    },
    {
      label: 'Unique domains',
      value: topDomains.length.toLocaleString(),
      delta: null,
      hint: 'Distinct sites mentioning the keyword'
    },
    {
      label: 'Words analyzed',
      value: platforms.web.words.toLocaleString(),
      delta: null,
      hint: 'Total text synced'
    },
    {
      label: 'Avg. page length',
      value: platforms.web.avgWords.toLocaleString(),
      delta: null,
      hint: 'Words per page'
    }
  ];
}

function fallbackInsights(analytics) {
  const { platforms, topDomains, topTerms } = analytics;

  return [
    `The web sync found ${platforms.web.count} public pages (~${platforms.web.words.toLocaleString()} words). Top domains: ${
      topDomains
        .slice(0, 3)
        .map((entry) => entry.domain)
        .join(', ') || 'n/a'
    }.`,
    topTerms.length
      ? `Most frequent terms: ${topTerms
          .slice(0, 8)
          .map((entry) => entry.term)
          .join(', ')}.`
      : ''
  ].filter(Boolean);
}

function fallbackSources(analytics) {
  return [{ label: 'Web', count: analytics.platforms.web.count }];
}

function fallbackChartBase(title, subtitle, span, height) {
  return { title, subtitle, span, height };
}

function buildFallbackDashboard(job) {
  const analytics = job.analytics;
  const charts = [];

  if (analytics.topTerms.length) {
    // Pick 2-4 common keyword topics (excluding tokens from the search query itself when possible)
    const queryTokens = new Set(
      String(job.keyword || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2)
    );
    const nonQueryTerms = analytics.topTerms.filter(
      (entry) => !queryTokens.has(entry.term.toLowerCase())
    );
    const topicSlice = (nonQueryTerms.length >= 2 ? nonQueryTerms : analytics.topTerms).slice(0, 4);

    if (topicSlice.length >= 2) {
      charts.push({
        id: 'keyword-topics',
        ...fallbackChartBase(
          'Common keyword topics',
          'Top recurring themes across web research results',
          6,
          340
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
              radius: ['45%', '72%'],
              center: ['50%', '45%'],
              itemStyle: { borderColor: '#0d131f', borderWidth: 2 },
              label: { color: '#9fb0c8' },
              data: topicSlice.map((entry) => ({
                name: entry.term,
                value: entry.count
              }))
            }
          ]
        }
      });
    }

    const terms = analytics.topTerms.slice(0, 10).reverse();

    charts.push({
      id: 'top-terms',
      ...fallbackChartBase(
        'Most frequent terms',
        'Keyword and content vocabulary',
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
      id: 'source-ecosystem',
      ...fallbackChartBase(
        'Source ecosystem',
        'Web domains contributing to coverage',
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
        grid: { left: 8, right: 24, top: 12, bottom: 8, containLabel: true },
        xAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: 'rgba(255,255,255,.07)' } },
          axisLabel: { color: '#9fb0c8' }
        },
        yAxis: {
          type: 'category',
          data: analytics.topDomains
            .slice(0, 10)
            .reverse()
            .map((entry) => entry.domain),
          axisLine: { lineStyle: { color: 'rgba(255,255,255,.12)' } },
          axisLabel: { color: '#9fb0c8' }
        },
        series: [
          {
            type: 'bar',
            data: analytics.topDomains
              .slice(0, 10)
              .reverse()
              .map((entry) => entry.count),
            itemStyle: { borderRadius: [0, 4, 4, 0] }
          }
        ]
      }
    });
  }

  return {
    title: `Brand visibility for “${job.keyword}”`,
    subtitle: `${analytics.counts.total} public web pages synced — basic fallback view.`,
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