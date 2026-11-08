const APIFY_BASE = 'https://api.apify.com/v2';
const MAX_ITEMS = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const ACTORS = {
  twitter: {
    key: 'twitter',
    label: 'X / Twitter',
    actorId: 'apidojo~twitter-scraper-lite',
    buildInput: (keyword) => ({
      searchTerms: [keyword],
      sort: 'Latest',
      maxItems: MAX_ITEMS
    })
  },
  instagram: {
    key: 'instagram',
    label: 'Instagram Reels',
    actorId: 'apify~instagram-reel-scraper',
    buildInput: (keyword) => ({
      // The reel scraper is profile-oriented. The keyword is treated
      // as a public Instagram handle, e.g. "@natgeo" or "natgeo".
      username: [handleFromKeyword(keyword)],
      resultsLimit: MAX_ITEMS
    })
  },
  web: {
    key: 'web',
    label: 'Web research',
    actorId: 'apify~rag-web-browser',
    buildInput: (keyword) => ({
      query: keyword,
      maxResults: MAX_ITEMS,
      outputFormats: ['markdown', 'text']
    })
  }
};

function token() {
  const value = process.env.APIFY_TOKEN;
  if (!value) throw new Error('APIFY_TOKEN is not configured.');
  return value;
}

function handleFromKeyword(keyword) {
  return (
    keyword
      .trim()
      .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
      .replace(/\/.*$/, '')
      .replace(/^@/, '')
      .replace(/\s+/g, '')
      .toLowerCase() || keyword.trim()
  );
}

async function apifyJson(path, init = {}, timeoutMs = 45_000) {
  const url = new URL(`${APIFY_BASE}${path}`);
  url.searchParams.set('token', token());

  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs)
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const detail = json?.error?.message || text || res.statusText;
    throw new Error(`Apify ${res.status}: ${String(detail).slice(0, 400)}`);
  }

  return json;
}

async function startRun(def, input) {
  const url = new URL(`${APIFY_BASE}/acts/${def.actorId}/runs`);
  url.searchParams.set('token', token());
  url.searchParams.set('timeout', '240');
  // Caps pay-per-result actors. The input also enforces the limit.
  url.searchParams.set('maxItems', String(MAX_ITEMS));

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(45_000)
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }

  if (!res.ok) {
    const detail = json?.error?.message || text || res.statusText;
    throw new Error(`Apify start ${res.status}: ${String(detail).slice(0, 400)}`);
  }

  return json.data;
}

async function waitForRun(runId, maxWaitMs = 250_000) {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const { data } = await apifyJson(`/actor-runs/${runId}`, {}, 30_000);

    if (['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(data.status)) {
      return data;
    }

    await sleep(2_000);
  }

  return { status: 'TIMED-OUT' };
}

async function fetchItems(datasetId) {
  const url = new URL(`${APIFY_BASE}/datasets/${datasetId}/items`);
  url.searchParams.set('token', token());
  url.searchParams.set('limit', String(MAX_ITEMS));
  url.searchParams.set('clean', 'true');
  url.searchParams.set('format', 'json');

  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });

  if (!res.ok) {
    throw new Error(`Apify dataset ${res.status}: ${res.statusText}`);
  }

  const items = await res.json();
  return Array.isArray(items) ? items.slice(0, MAX_ITEMS) : [];
}

/* ------------------------------------------------------------------ */
/* Normalizers                                                         */
/* ------------------------------------------------------------------ */

function pick(obj, ...paths) {
  for (const path of paths) {
    const value = path
      .split('.')
      .reduce((acc, part) => acc?.[part], obj);

    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function compactTwitter(item = {}) {
  return {
    platform: 'x',
    text: String(
      pick(item, 'fullText', 'text', 'tweetText', 'content') ?? ''
    ).slice(0, 1200),
    author: pick(
      item,
      'author.userName',
      'author.username',
      'user.screen_name',
      'username',
      'author.name',
      'user.name'
    ),
    createdAt: pick(item, 'createdAt', 'created_at', 'timestamp', 'date'),
    likes: num(pick(item, 'likeCount', 'favoriteCount', 'likes')),
    replies: num(pick(item, 'replyCount', 'replies')),
    reposts: num(pick(item, 'retweetCount', 'reposts', 'retweets')),
    views: num(pick(item, 'viewCount', 'views', 'impressions')),
    url: pick(item, 'url', 'twitterUrl', 'tweetUrl'),
    lang: pick(item, 'lang', 'language')
  };
}

function compactInstagram(item = {}) {
  return {
    platform: 'instagram',
    caption: String(
      pick(
        item,
        'caption',
        'text',
        'title',
        'edge_media_to_caption.edges.0.node.text'
      ) ?? ''
    ).slice(0, 1200),
    owner: pick(item, 'ownerUsername', 'owner.username', 'username'),
    createdAt: pick(item, 'timestamp', 'takenAt', 'date'),
    likes: num(pick(item, 'likesCount', 'likes', 'edge_liked_by.count')),
    comments: num(
      pick(item, 'commentsCount', 'comments', 'edge_media_to_comment.count')
    ),
    views: num(
      pick(item, 'videoPlayCount', 'videoViewCount', 'playCount', 'views')
    ),
    url: pick(item, 'url', 'displayUrl', 'shortCode'),
    type: pick(item, 'type', 'productType') || 'reel'
  };
}

function compactWeb(item = {}) {
  const url = pick(item, 'metadata.url', 'url', 'sourceUrl', 'searchResult.url');

  let domain = null;
  try {
    domain = url ? new URL(url).hostname.replace(/^www\./, '') : null;
  } catch {
    domain = null;
  }

  const text = String(
    pick(item, 'markdown', 'text', 'content', 'ragContent') ?? ''
  );

  return {
    platform: 'web',
    title: pick(item, 'metadata.title', 'title', 'searchResult.title'),
    url,
    domain,
    text: text.slice(0, 1600),
    wordCount:
      num(pick(item, 'wordCount')) ||
      text.split(/\s+/).filter(Boolean).length
  };
}

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

function buildAnalytics(data) {
  const x = data.twitter;
  const ig = data.instagram;
  const web = data.web;

  const sum = (arr, key) => arr.reduce((acc, item) => acc + num(item[key]), 0);

  const xEngagement = x.reduce(
    (acc, item) => acc + item.likes + item.replies + item.reposts,
    0
  );
  const igEngagement = ig.reduce(
    (acc, item) => acc + item.likes + item.comments,
    0
  );

  const platforms = {
    twitter: {
      label: 'X / Twitter',
      count: x.length,
      likes: sum(x, 'likes'),
      replies: sum(x, 'replies'),
      reposts: sum(x, 'reposts'),
      views: sum(x, 'views'),
      engagement: xEngagement,
      avgEngagement: x.length ? Number((xEngagement / x.length).toFixed(1)) : 0
    },
    instagram: {
      label: 'Instagram Reels',
      count: ig.length,
      likes: sum(ig, 'likes'),
      comments: sum(ig, 'comments'),
      views: sum(ig, 'views'),
      engagement: igEngagement,
      avgEngagement: ig.length
        ? Number((igEngagement / ig.length).toFixed(1))
        : 0
    },
    web: {
      label: 'Web research',
      count: web.length,
      words: sum(web, 'wordCount'),
      avgWords: web.length
        ? Math.round(sum(web, 'wordCount') / web.length)
        : 0
    }
  };

  // Top authors / handles
  const authorMap = new Map();
  for (const item of [...x, ...ig]) {
    const name = item.author || item.owner;
    if (!name) continue;

    const key = `${item.platform}:${name}`;
    const entry =
      authorMap.get(key) || {
        name,
        platform: item.platform,
        count: 0,
        engagement: 0
      };

    entry.count += 1;
    entry.engagement +=
      item.platform === 'x'
        ? item.likes + item.replies + item.reposts
        : item.likes + item.comments;

    authorMap.set(key, entry);
  }

  const topAuthors = [...authorMap.values()]
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, 12);

  // Top web domains
  const domainMap = new Map();
  for (const item of web) {
    if (!item.domain) continue;
    domainMap.set(item.domain, (domainMap.get(item.domain) || 0) + 1);
  }

  const topDomains = [...domainMap.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  // Timeline
  const buckets = new Map();

  const addDate = (value, platform) => {
    if (!value) return;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return;

    const key = date.toISOString().slice(0, 10);
    const bucket = buckets.get(key) || { date: key, x: 0, instagram: 0 };
    bucket[platform] += 1;
    buckets.set(key, bucket);
  };

  x.forEach((item) => addDate(item.createdAt, 'x'));
  ig.forEach((item) => addDate(item.createdAt, 'instagram'));

  const timeline = [...buckets.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30);

  // Top terms
  const stopwords = new Set(
    (
      'the,a,an,and,or,but,if,then,else,for,of,to,in,on,at,by,with,from,' +
      'is,are,was,were,be,been,being,it,this,that,these,those,as,not,no,' +
      'you,your,we,our,they,their,i,my,me,he,she,his,her,them,us,do,does,' +
      'did,can,could,should,would,will,just,about,into,than,so,up,out,over,' +
      'after,before,more,most,some,any,all,also,new,now,via,amp,https,http,' +
      'www,com,get,got,make,like,one,two,first,last,rt'
    ).split(',')
  );

  const termMap = new Map();

  for (const item of [...x, ...ig, ...web]) {
    const text = `${item.text || ''} ${item.caption || ''} ${item.title || ''}`
      .toLowerCase();

    for (const term of text.split(/[^a-z0-9#@']+/)) {
      if (term.length < 3 || stopwords.has(term) || /^\d+$/.test(term)) {
        continue;
      }
      termMap.set(term, (termMap.get(term) || 0) + 1);
    }
  }

  const topTerms = [...termMap.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  // Date range
  const dates = [...x, ...ig]
    .map((item) => item.createdAt)
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a - b);

  return {
    counts: {
      x: x.length,
      instagram: ig.length,
      web: web.length,
      total: x.length + ig.length + web.length
    },
    platforms,
    topAuthors,
    topDomains,
    timeline,
    topTerms,
    dateRange: dates.length
      ? {
          from: dates[0].toISOString(),
          to: dates[dates.length - 1].toISOString()
        }
      : null
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function scrapeAll(keyword, onProgress = () => {}) {
  if (!process.env.APIFY_TOKEN) {
    throw new Error('APIFY_TOKEN is not configured.');
  }

  const state = {
    twitter: { status: 'queued', label: 'X / Twitter' },
    instagram: { status: 'queued', label: 'Instagram Reels' },
    web: { status: 'queued', label: 'Web research' }
  };

  const emit = () => onProgress({ actors: structuredClone(state) });

  const tasks = Object.values(ACTORS).map(async (def) => {
    const startedAt = Date.now();

    state[def.key] = { status: 'running', label: def.label };
    emit();

    try {
      const run = await startRun(def, def.buildInput(keyword));

      state[def.key] = {
        status: 'running',
        label: def.label,
        runId: run.id
      };
      emit();

      const finished = await waitForRun(run.id);

      if (finished.status !== 'SUCCEEDED') {
        throw new Error(`Run ended with status ${finished.status}`);
      }

      const items = await fetchItems(finished.defaultDatasetId);

      state[def.key] = {
        status: 'done',
        label: def.label,
        count: items.length,
        durationMs: Date.now() - startedAt
      };
      emit();

      return { key: def.key, items };
    } catch (err) {
      state[def.key] = {
        status: 'error',
        label: def.label,
        error: err.message,
        durationMs: Date.now() - startedAt
      };
      emit();

      return { key: def.key, items: [], error: err.message };
    }
  });

  const results = await Promise.all(tasks);

  const raw = Object.fromEntries(results.map((r) => [r.key, r.items]));

  const data = {
    twitter: raw.twitter.map(compactTwitter).filter(Boolean),
    instagram: raw.instagram.map(compactInstagram).filter(Boolean),
    web: raw.web.map(compactWeb).filter(Boolean)
  };

  const errors = results
    .filter((r) => r.error)
    .map((r) => ({ key: r.key, error: r.error }));

  return {
    keyword,
    scrapedAt: new Date().toISOString(),
    counts: {
      twitter: data.twitter.length,
      instagram: data.instagram.length,
      web: data.web.length
    },
    data,
    analytics: buildAnalytics(data),
    errors
  };
}