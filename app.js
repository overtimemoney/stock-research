/* Stock Research PWA — personal stock research with live data.
 * Data sources (public, no key): Finviz (fundamentals), Nasdaq API
 * (quote, summary, EPS forecasts), Yahoo Finance chart (1y history).
 * None of them send CORS headers, so every request goes through a chain
 * of public CORS relays; the first that answers wins. Quotes are cached
 * 15 minutes in localStorage. Missing fields stay missing — never faked. */
'use strict';

/* ============================== utilities ============================== */
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function isNum(n) { return typeof n === 'number' && isFinite(n); }
function fmtMoney(n, dec) {
  if (!isNum(n)) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: dec == null ? 2 : dec, maximumFractionDigits: dec == null ? 2 : dec });
}
function fmtNum(n, dec) {
  if (!isNum(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: dec == null ? 2 : dec, maximumFractionDigits: dec == null ? 2 : dec });
}
function fmtPct(n, dec) {
  if (!isNum(n)) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(dec == null ? 1 : dec) + '%';
}
function fmtCap(n) { // dollars -> $969.1B
  if (!isNum(n)) return '—';
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  return fmtMoney(n, 0);
}
function parseNum(s) {
  if (s == null) return null;
  if (typeof s === 'number') return isFinite(s) ? s : null;
  var t = String(s).replace(/[$,%]/g, '').replace(/,/g, '').trim();
  if (!t || t === '-' || t === '—' || /^n\/?a$/i.test(t) || /^none$/i.test(t)) return null;
  var n = parseFloat(t);
  return isNaN(n) ? null : n;
}
function parseCapStr(s) { // "969.05B" / "12.3M" / "1.2T"
  if (s == null) return null;
  var m = String(s).trim().match(/^([\d.,]+)\s*([BMT])?$/i);
  if (!m) return parseNum(s);
  var n = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(n)) return null;
  var u = (m[2] || '').toUpperCase();
  if (u === 'T') return n * 1e12;
  if (u === 'B') return n * 1e9;
  if (u === 'M') return n * 1e6;
  return n;
}
function lsGet(key, fallback) {
  try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch (e) { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}

/* ============================== relay fetch ============================== */
var RELAYS = [
  // The user's own Cloudflare Worker relay (deployed 2026-10-24) — first
  // route: fast and reliable. The free public relays below stay as backup.
  function (u) { return 'https://stock-research-relay.supplessayings-6e6.workers.dev/?url=' + encodeURIComponent(u); },
  function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); },
  function (u) { return 'https://api.cors.lol/?url=' + encodeURIComponent(u); },
  function (u) { return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u); },
  function (u) { return 'https://corsproxy.io/?url=' + encodeURIComponent(u); }
];
function fetchWithTimeout(url, ms) {
  if (typeof AbortController === 'undefined') return fetch(url);
  var ctl = new AbortController();
  var to = setTimeout(function () { ctl.abort(); }, ms);
  return fetch(url, { signal: ctl.signal }).finally(function () { clearTimeout(to); });
}
/* Race every route at once (direct + all relays); the first response that
 * validates wins. Sequential relay fallback could stack 4 timeouts per
 * source and look like a perpetual spinner, so everything runs parallel. */
/* Which route served the first successful fetch of a lookup: 'your relay'
 * (the user's Cloudflare Worker), 'public relay' (a backup) or 'direct'.
 * Shown on the scorecard so the user can see what actually carried data. */
var FIRST_ROUTE = null;
function relayFetch(url, opts) {
  opts = opts || {};
  var timeout = opts.timeout || 10000;
  var attempts = [url];
  for (var i = 0; i < RELAYS.length; i++) attempts.push(RELAYS[i](url));
  return new Promise(function (resolve, reject) {
    var done = false, pending = attempts.length, lastErr = null;
    var killer = setTimeout(function () {
      if (!done) { done = true; reject(lastErr || new Error('data sources timed out')); }
    }, timeout);
    attempts.forEach(function (u, ai) {
      fetchWithTimeout(u, timeout).then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.text();
      }).then(function (text) {
        if (!text || text.length < 8) throw new Error('empty response');
        if (/error code: 5\d\d|Rate limit exceeded/i.test(text) && text.length < 200) {
          throw new Error('relay busy');
        }
        if (opts.validate && !opts.validate(text)) throw new Error('unexpected content');
        if (!done) {
          done = true; clearTimeout(killer);
          if (!FIRST_ROUTE) FIRST_ROUTE = ai === 0 ? 'direct' : (ai === 1 ? 'your relay' : 'public relay');
          resolve(text);
        }
      }).catch(function (e) {
        lastErr = e; pending--;
        if (!done && pending === 0) { done = true; clearTimeout(killer); reject(lastErr || new Error('all relays failed')); }
      });
    });
  });
}
async function relayJSON(url) {
  var text = await relayFetch(url, { validate: function (t) { return t.trim().charAt(0) === '{'; } });
  return JSON.parse(text);
}

/* ============================== source parsers ============================== */
/* Finviz stock page: label/content pairs live inside the same <tr>.
 * Regex-based (not DOMParser) so the exact shipped code is testable. */
function stripTags(s) { return String(s).replace(/<[^>]+>/g, '').trim(); }
function parseFinviz(html) {
  var pairs = {};
  var trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi, trM;
  while ((trM = trRe.exec(html)) !== null) {
    var block = trM[1];
    var labs = [], cons = [], m;
    var labRe = /class="snapshot-td-label">(?:<a[^>]*>)?([^<]+)/g;
    while ((m = labRe.exec(block)) !== null) labs.push(m[1].trim());
    var conRe = /class="snapshot-td-content">([\s\S]*?)<\/div>/g;
    while ((m = conRe.exec(block)) !== null) cons.push(stripTags(m[1]));
    labs.forEach(function (key, i) {
      if (key && !(key in pairs)) pairs[key] = cons[i] || '';
    });
  }
  return pairs;
}
function finvizPctBelowHigh(pairs) {
  var raw = pairs['52W High'] || ''; // e.g. "1255.00 -31.75%"
  var m = raw.match(/(-?[\d.]+)%/);
  if (m) return Math.abs(parseFloat(m[1]));
  var hi = parseNum((raw.split(' ')[0] || ''));
  return hi; // caller falls back to price math if this looks like a price
}

/* "$63.34B" / "$890M" style strings to plain numbers. */
function parseRevStr(s) {
  if (!s) return null;
  var m = String(s).replace(/[$,]/g, '').trim().match(/^([\d.]+)\s*([BMK])?$/i);
  if (!m) return null;
  var v = parseFloat(m[1]);
  if (!isNum(v)) return null;
  var u = (m[2] || '').toUpperCase();
  return u === 'B' ? v * 1e9 : u === 'M' ? v * 1e6 : u === 'K' ? v * 1e3 : v;
}

/* MarketBeat earnings page: the history table with Consensus Estimate vs
 * Reported EPS per quarter (newest first). Their free table carries the
 * last ~8-9 quarters — the deepest EPS-surprise history fetchable without
 * a paid API key (Nasdaq/Zacks publish only 4). */
function parseMBEarnings(html) {
  var tables = String(html).match(/<table[\s\S]*?<\/table>/g) || [];
  for (var ti = 0; ti < tables.length; ti++) {
    var t = tables[ti];
    if (t.indexOf('Consensus Estimate') === -1 || t.indexOf('Reported EPS') === -1) continue;
    var rows = [], trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi, trM;
    while ((trM = trRe.exec(t)) !== null) {
      var cells = [], tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi, tdM;
      while ((tdM = tdRe.exec(trM[1])) !== null) cells.push(stripTags(tdM[1]));
      if (cells.length >= 4) {
        var consensus = parseNum(cells[2]);
        var reported = parseNum(cells[3]);
        if (isNum(consensus) && isNum(reported)) {
          rows.push({
            date: cells[0], quarter: cells[1], consensus: consensus, reported: reported,
            rev: cells.length >= 8 ? parseRevStr(cells[7]) : null
          });
        }
      }
    }
    if (rows.length) return rows.slice(0, 20);
  }
  return [];
}
/* Miss = reported EPS below the consensus estimate; within a tenth of a
 * cent counts as in line. Returns counts plus miss/beat percentages. */
function epsRecordStats(rows) {
  var n = rows.length, misses = 0, beats = 0, meets = 0;
  rows.forEach(function (r) {
    var diff = r.reported - r.consensus;
    if (diff < -0.001) misses++; else if (diff > 0.001) beats++; else meets++;
  });
  return {
    n: n, misses: misses, beats: beats, meets: meets,
    missPct: n ? Math.round(misses / n * 100) : null,
    beatPct: n ? Math.round(beats / n * 100) : null
  };
}

/* ============================== data assembly ============================== */
var CACHE_KEY = 'sr_qcache_v1';
var CACHE_TTL = 15 * 60 * 1000;

/* Fill a stock object from a parsed Finviz snapshot. Shared by the
 * full scorecard fetch and the watchlist's light valuation pass. */
function fillFromFinviz(d, fvHtml) {
  var p = parseFinviz(fvHtml);
  if (!p['Price'] && !p['Market Cap']) throw new Error('no snapshot');
  d.sourceFinviz = p;
  d.name = d.name || null;
  d.price = parseNum(p['Price']);
  d.marketCap = parseCapStr(p['Market Cap']);
  d.pe = parseNum(p['P/E']);
  d.forwardPE = parseNum(p['Forward P/E']);
  d.peg = parseNum(p['PEG']);
  d.epsTTM = parseNum(p['EPS (ttm)']);
  d.epsNextY = parseNum(p['EPS next Y']);
  var g5 = p['EPS next 5Y'] || '';
  d.epsGrowth5Y = parseNum(g5);
  d.epsGrowthTTM = parseNum(p['EPS Y/Y TTM']);
  d.salesGrowthTTM = parseNum(p['Sales Y/Y TTM']);
  d.grossMargin = parseNum(p['Gross Margin']);
  d.operMargin = parseNum(p['Oper. Margin']);
  d.profitMargin = parseNum(p['Profit Margin']);
  d.debtEq = parseNum(p['Debt/Eq']);
  d.beta = parseNum(p['Beta']);
  d.roe = parseNum(p['ROE']);
  // Finviz renamed "Dividend %" away: the yield now rides in parens in
  // "Dividend TTM" / "Dividend Est." — e.g. "2.10 (2.27%)". "-" when the
  // stock pays no dividend.
  var divRaw = p['Dividend TTM'] || p['Dividend Est.'] || '';
  var divM = divRaw.match(/\(([\d.]+)%\)/);
  if (divM) d.divYield = parseFloat(divM[1]);
  else if (isNum(parseNum(p['Dividend %']))) d.divYield = parseNum(p['Dividend %']);
  var hiParts = (p['52W High'] || '').split(/\s+/);
  var loParts = (p['52W Low'] || '').split(/\s+/);
  d.high52 = parseNum(hiParts[0]);
  d.low52 = parseNum(loParts[0]);
  var pctM = (p['52W High'] || '').match(/(-?[\d.]+)%/);
  if (pctM) d.pctBelowHigh = Math.abs(parseFloat(pctM[1]));
  d.companyName = null; // finviz quote page title handled by Nasdaq below
  var titleM = fvHtml.match(/<title>([^<]+)<\/title>/i);
  if (titleM) {
    var nm = titleM[1].replace(/\s+Stock Price.*$/i, '').replace(/\s+Quote.*$/i, '').trim();
    // Finviz titles look like "MU - Micron Technology Inc Stock Price and Quote"
    var dashParts = nm.split(' - ');
    if (dashParts.length > 1) d.companyName = dashParts.slice(1).join(' - ').trim();
  }
  d.sources.push('Finviz');
}

async function fetchStock(ticker, opts) {
  opts = opts || {};
  var T = String(ticker || '').trim().toUpperCase();
  if (!T) throw new Error('Enter a ticker symbol.');
  var cache = lsGet(CACHE_KEY, {});
  var hit = cache[T];
  if (!opts.fresh && hit && (Date.now() - hit.ts) < CACHE_TTL && hit.data) {
    hit.data.fromCache = true;
    return hit.data;
  }
  var d = { ticker: T, sources: [], errors: [] };
  FIRST_ROUTE = null;

  // --- Finviz: fundamentals workhorse ---
  var srcFinviz = async function () { try {
    var fvHtml = await relayFetch('https://finviz.com/stock?t=' + encodeURIComponent(T), {
      validate: function (t) { return t.indexOf('snapshot-td-label') !== -1; }
    });
    fillFromFinviz(d, fvHtml);
  } catch (e) { d.errors.push('Finviz: ' + e.message); } };

  // --- Nasdaq: quote + summary + EPS forecasts ---
  var srcNasdaqInfo = async function () { try {
    var info = await relayJSON('https://api.nasdaq.com/api/quote/' + encodeURIComponent(T) + '/info?assetclass=stocks');
    var id = (info && info.data) || {};
    if (id.companyName) d.companyName = String(id.companyName).replace(/\s+(Common Stock|Class A.*|Common Shares)$/i, '').trim();
    if (id.exchange) d.exchange = id.exchange;
    var pd = id.primaryData || {};
    var nqPrice = parseNum(pd.lastSalePrice);
    if (isNum(nqPrice)) { if (!isNum(d.price)) d.price = nqPrice; d.nasdaqPrice = nqPrice; }
    d.dayChangePct = parseNum(pd.percentageChange);
    var ks = (id.keyStats || {}).fiftyTwoWeekHighLow || {};
    var rangeM = String(ks.value || '').match(/([\d.,]+)\s*-\s*([\d.,]+)/);
    if (rangeM) {
      if (!isNum(d.low52)) d.low52 = parseNum(rangeM[1]);
      if (!isNum(d.high52)) d.high52 = parseNum(rangeM[2]);
    }
    d.sources.push('Nasdaq');
  } catch (e) { d.errors.push('Nasdaq quote: ' + e.message); } };

  var srcNasdaqSummary = async function () { try {
    var sum = await relayJSON('https://api.nasdaq.com/api/quote/' + encodeURIComponent(T) + '/summary?assetclass=stocks');
    var sd = (sum && sum.data && sum.data.summaryData) || {};
    var mc = sd.MarketCap ? parseNum(sd.MarketCap.value) : null;
    if (isNum(mc) && !isNum(d.marketCap)) d.marketCap = mc;
    if (sd.Sector) d.sector = sd.Sector.value;
    if (sd.Industry) d.industry = sd.Industry.value;
    if (sd.OneYrTarget) d.target1Y = parseNum(sd.OneYrTarget.value);
    if (sd.Yield && !isNum(d.divYield)) d.divYield = parseNum(sd.Yield.value);
    if (sd.PreviousClose) d.prevClose = parseNum(sd.PreviousClose.value);
  } catch (e) { d.errors.push('Nasdaq summary: ' + e.message); } };

  var srcNasdaqForecast = async function () { try {
    var fc = await relayJSON('https://api.nasdaq.com/api/analyst/' + encodeURIComponent(T) + '/earnings-forecast?assetclass=stocks');
    var rows = (fc && fc.data && fc.data.yearlyForecast && fc.data.yearlyForecast.rows) || [];
    d.epsForecasts = rows.map(function (r) {
      return {
        fiscalEnd: r.fiscalEnd,
        eps: typeof r.consensusEPSForecast === 'number' ? r.consensusEPSForecast : parseNum(r.consensusEPSForecast),
        high: parseNum(r.highEPSForecast),
        low: parseNum(r.lowEPSForecast),
        n: parseNum(r.noOfEstimates)
      };
    }).filter(function (r) { return isNum(r.eps); });
    if (d.epsForecasts.length) d.sources.push('Nasdaq estimates');
  } catch (e) { d.errors.push('Nasdaq forecasts: ' + e.message); d.epsForecasts = []; } };

  // --- MarketBeat: EPS surprise history (consensus vs reported) ---
  var srcSurprise = async function () { try {
    var ex = String(d.exchange || '').toUpperCase();
    var segs = [];
    if (['NASDAQ', 'NYSE', 'AMEX'].indexOf(ex) !== -1) segs.push(ex);
    ['NASDAQ', 'NYSE'].forEach(function (s) { if (segs.indexOf(s) === -1) segs.push(s); });
    var urls = segs.slice(0, 2).map(function (s) {
      return 'https://www.marketbeat.com/stocks/' + s + '/' + encodeURIComponent(T) + '/earnings/';
    });
    var html = await new Promise(function (resolve, reject) {
      var pending = urls.length, done = false;
      urls.forEach(function (u) {
        relayFetch(u, { timeout: 15000, validate: function (t) { return t.indexOf('Reported EPS') !== -1 && t.indexOf('Consensus Estimate') !== -1; } })
          .then(function (text) { if (!done) { done = true; resolve(text); } })
          .catch(function (e) { pending--; if (pending === 0 && !done) reject(e || new Error('no earnings history')); });
      });
    });
    var rows = parseMBEarnings(html);
    if (rows.length >= 4) {
      d.epsRecord = epsRecordStats(rows);
      d.sources.push('MarketBeat');
    }
    // Latest quarter's revenue growth: newest quarter vs the same
    // quarter a year earlier (4 rows back in the newest-first table).
    if (rows.length >= 5 && isNum(rows[0].rev) && isNum(rows[4].rev) && rows[4].rev > 0) {
      d.revGrowthQtr = (rows[0].rev / rows[4].rev - 1) * 100;
    }
  } catch (e) { d.errors.push('EPS history: ' + e.message); } };

  // --- Yahoo chart: 1y weekly price history ---
  var srcYahoo = async function () { try {
    var ch = await relayJSON('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(T) + '?range=1y&interval=1wk');
    var res = ch && ch.chart && ch.chart.result && ch.chart.result[0];
    if (res) {
      var closes = ((res.indicators && res.indicators.quote && res.indicators.quote[0].close) || [])
        .filter(function (c) { return isNum(c); });
      d.history = closes;
      var meta = res.meta || {};
      if (!isNum(d.price) && isNum(meta.regularMarketPrice)) d.price = meta.regularMarketPrice;
      if (!isNum(d.high52) && isNum(meta.fiftyTwoWeekHigh)) d.high52 = meta.fiftyTwoWeekHigh;
      if (!isNum(d.low52) && isNum(meta.fiftyTwoWeekLow)) d.low52 = meta.fiftyTwoWeekLow;
      if (!d.companyName && meta.longName) d.companyName = meta.longName;
      d.sources.push('Yahoo');
    }
  } catch (e) { d.errors.push('Yahoo chart: ' + e.message); } };

  // Fast stage: the four small JSON sources in parallel. Finviz (a huge
  // HTML page through a relay) runs after, so price/chart/EPS render
  // immediately and valuation details fill in when they land.
  await Promise.all([srcNasdaqInfo(), srcNasdaqSummary(), srcNasdaqForecast(), srcYahoo()]);
  deriveValues(d);
  if (opts.onStage && (isNum(d.price) || isNum(d.marketCap))) {
    d.partial = true;
    d.route = FIRST_ROUTE;
    d.fetchedAt = Date.now();
    try { opts.onStage(d); } catch (e) {}
  }
  // Slow stage: Finviz fundamentals + MarketBeat EPS-surprise history in
  // parallel — both are big HTML pages through the relays.
  await Promise.all([srcFinviz(), srcSurprise()]);
  deriveValues(d);
  d.partial = false;

  // --- derived values (transparent arithmetic on sourced numbers) ---
  function deriveValues(d) {
  if (!isNum(d.pctBelowHigh) && isNum(d.price) && isNum(d.high52) && d.high52 > 0) {
    d.pctBelowHigh = Math.max(0, (1 - d.price / d.high52) * 100);
  }
  if (!isNum(d.dayChangePct) && isNum(d.price) && isNum(d.prevClose) && d.prevClose > 0) {
    d.dayChangePct = (d.price / d.prevClose - 1) * 100;
  }
  // EPS growth into next fiscal year
  var nextFY = (d.epsForecasts && d.epsForecasts[0]) || null;
  if (isNum(d.epsNextY) && isNum(d.epsTTM) && d.epsTTM > 0) {
    d.epsGrowthNextY = (d.epsNextY / d.epsTTM - 1) * 100;
  } else if (nextFY && isNum(d.epsTTM) && d.epsTTM > 0) {
    d.epsGrowthNextY = (nextFY.eps / d.epsTTM - 1) * 100;
  }
  // Forward P/E fallback: price / next-FY consensus EPS (labelled calc.)
  if (!isNum(d.forwardPE) && isNum(d.price)) {
    var fyEps = isNum(d.epsNextY) ? d.epsNextY : (nextFY ? nextFY.eps : null);
    if (isNum(fyEps) && fyEps > 0) { d.forwardPE = d.price / fyEps; d.forwardPECalc = true; }
  }
  // PEG fallback: forward P/E / next-year EPS growth % (labelled calc.)
  if (!isNum(d.peg) && isNum(d.forwardPE) && isNum(d.epsGrowthNextY) && d.epsGrowthNextY > 0) {
    d.peg = d.forwardPE / d.epsGrowthNextY; d.pegCalc = true;
  }
  }
  d.fetchedAt = Date.now();
  d.route = FIRST_ROUTE;
  d.fromCache = false;
  if (!isNum(d.price) && !isNum(d.marketCap)) {
    throw new Error('Could not load data for "' + T + '" — the data routes may be busy. Check the ticker and try again in a moment.');
  }
  cache[T] = { ts: Date.now(), data: d };
  lsSet(CACHE_KEY, cache);
  return d;
}

/* ============================== scoring ============================== */
/* Transparent rubric — every factor's points are shown to the user. */
function scoreStock(d) {
  var factors = [];
  function band(v, bands) { // bands: [[limitInclusive, points], ...] ascending
    for (var i = 0; i < bands.length; i++) { if (v <= bands[i][0]) return bands[i][1]; }
    return 0;
  }
  function add(name, value, display, max, pts, note) {
    factors.push({ name: name, value: value, display: display, max: max, pts: pts, note: note || '' });
  }
  if (isNum(d.forwardPE) && d.forwardPE > 0) {
    add('Forward P/E', d.forwardPE, fmtNum(d.forwardPE, 2) + (d.forwardPECalc ? ' (calc.)' : ''), 25,
      band(d.forwardPE, [[6, 25], [8, 22], [10, 19], [13, 15], [18, 11], [25, 7], [35, 3], [Infinity, 0]]),
      'Cheaper earnings = more points');
  }
  if (isNum(d.peg) && d.peg > 0) {
    add('PEG ratio', d.peg, fmtNum(d.peg, 2) + (d.pegCalc ? ' (calc.)' : ''), 20,
      band(d.peg, [[0.3, 20], [0.5, 18], [0.75, 15], [1, 12], [1.5, 8], [2, 4], [Infinity, 0]]),
      'Price vs growth — under 0.5 is rare air');
  }
  if (isNum(d.pctBelowHigh)) {
    add('Below 52-wk high', d.pctBelowHigh, fmtNum(d.pctBelowHigh, 1) + '%', 15,
      d.pctBelowHigh >= 40 ? 15 : d.pctBelowHigh >= 30 ? 13 : d.pctBelowHigh >= 25 ? 11 :
      d.pctBelowHigh >= 15 ? 8 : d.pctBelowHigh >= 5 ? 4 : 1,
      'Bigger discount to the high = more points');
  }
  if (isNum(d.epsGrowthNextY)) {
    add('EPS growth, next yr', d.epsGrowthNextY, fmtPct(d.epsGrowthNextY), 15,
      d.epsGrowthNextY >= 50 ? 15 : d.epsGrowthNextY >= 25 ? 13 : d.epsGrowthNextY >= 15 ? 10 :
      d.epsGrowthNextY >= 8 ? 7 : d.epsGrowthNextY >= 0 ? 3 : 0,
      'Consensus EPS, next fiscal year vs trailing');
  }
  if (isNum(d.profitMargin)) {
    add('Profit margin', d.profitMargin, fmtNum(d.profitMargin, 1) + '%', 10,
      d.profitMargin >= 25 ? 10 : d.profitMargin >= 15 ? 8 : d.profitMargin >= 10 ? 6 :
      d.profitMargin >= 5 ? 4 : d.profitMargin > 0 ? 2 : 0, 'Net margin, trailing');
  }
  if (isNum(d.grossMargin)) {
    add('Gross margin', d.grossMargin, fmtNum(d.grossMargin, 1) + '%', 5,
      d.grossMargin >= 60 ? 5 : d.grossMargin >= 45 ? 4 : d.grossMargin >= 30 ? 3 :
      d.grossMargin >= 15 ? 1 : 0, 'Pricing power proxy');
  }
  if (isNum(d.debtEq)) {
    add('Debt / Equity', d.debtEq, fmtNum(d.debtEq, 2), 10,
      d.debtEq <= 0.1 ? 10 : d.debtEq <= 0.4 ? 8 : d.debtEq <= 0.8 ? 6 :
      d.debtEq <= 1.5 ? 3 : d.debtEq <= 3 ? 1 : 0, 'Lower leverage = more points');
  }
  var got = factors.reduce(function (s, f) { return s + f.pts; }, 0);
  var maxAvailable = factors.reduce(function (s, f) { return s + f.max; }, 0);
  var score = maxAvailable > 0 ? Math.round(got / maxAvailable * 100) : null;
  var verdict = null;
  if (score != null) verdict = score >= 70 ? 'Undervalued' : score >= 45 ? 'Fairly valued' : 'Overpriced';
  return { factors: factors, got: got, maxAvailable: maxAvailable, score: score, verdict: verdict };
}

function valueScreen(d) {
  return [
    { label: 'Market cap over $5B', test: isNum(d.marketCap) ? (d.marketCap > 5e9) : null, value: fmtCap(d.marketCap) },
    { label: 'Forward P/E under 10', test: isNum(d.forwardPE) ? (d.forwardPE < 10) : null, value: isNum(d.forwardPE) ? fmtNum(d.forwardPE, 2) : '—' },
    { label: 'PEG under 0.5', test: isNum(d.peg) ? (d.peg < 0.5) : null, value: isNum(d.peg) ? fmtNum(d.peg, 2) : '—' },
    { label: '25%+ below 52-wk high', test: isNum(d.pctBelowHigh) ? (d.pctBelowHigh >= 25) : null, value: isNum(d.pctBelowHigh) ? fmtNum(d.pctBelowHigh, 1) + '% below' : '—' }
  ];
}

/* EPS trajectory: TTM actual + consensus forecasts; cliff = a later year
 * falls 10%+ below the running peak, or next year drops vs TTM. */
function epsTrajectory(d) {
  var pts = [];
  if (isNum(d.epsTTM)) pts.push({ label: 'TTM', eps: d.epsTTM, kind: 'actual' });
  (d.epsForecasts || []).slice(0, 4).forEach(function (f) {
    var yr = String(f.fiscalEnd || '').replace(/^[A-Za-z]+\s+/, '');
    pts.push({ label: 'FY' + yr, eps: f.eps, kind: 'est', n: f.n });
  });
  if (pts.length < 2 && isNum(d.epsNextY)) {
    pts.push({ label: 'Next yr est', eps: d.epsNextY, kind: 'est' });
  }
  var warning = null;
  if (pts.length >= 2) {
    var peak = -Infinity, peakLabel = '';
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].eps > peak) { peak = pts[i].eps; peakLabel = pts[i].label; }
      else if (peak > 0 && pts[i].eps < peak * 0.90) {
        warning = 'Earnings cliff in consensus: EPS peaks at ' + fmtNum(peak) + ' (' + peakLabel +
          ') then falls to ' + fmtNum(pts[i].eps) + ' by ' + pts[i].label + ' (' +
          fmtPct((pts[i].eps / peak - 1) * 100) + '). Cheap multiples on peak earnings are how value traps happen — check whether the peak is cyclical.';
        break;
      }
    }
    if (!warning && pts[1].eps < pts[0].eps) {
      warning = 'Consensus has earnings falling next year (' + fmtNum(pts[0].eps) + ' → ' + fmtNum(pts[1].eps) +
        '). A low forward multiple on shrinking earnings is not the same as cheap.';
    }
  }
  return { points: pts, warning: warning };
}

/* ============================== SVG charts ============================== */
function barChartSVG(pts, w, h) {
  w = w || 640; h = h || 190;
  if (!pts.length) return '';
  var padB = 26, padT = 22, padX = 8;
  var max = Math.max.apply(null, pts.map(function (p) { return p.eps; }).concat([0]));
  var min = Math.min.apply(null, pts.map(function (p) { return p.eps; }).concat([0]));
  var span = (max - min) || 1;
  var bw = (w - padX * 2) / pts.length;
  var zeroY = padT + (max / span) * (h - padT - padB);
  var out = '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="EPS trajectory chart">';
  out += '<line x1="' + padX + '" y1="' + zeroY + '" x2="' + (w - padX) + '" y2="' + zeroY + '" stroke="#d8c98f" stroke-width="1"/>';
  pts.forEach(function (p, i) {
    var bh = Math.abs(p.eps) / span * (h - padT - padB);
    var x = padX + i * bw + bw * 0.16, bwid = bw * 0.68;
    var y = p.eps >= 0 ? zeroY - bh : zeroY;
    var fill = p.kind === 'actual' ? '#141414' : 'url(#goldGrad)';
    out += '<rect x="' + x + '" y="' + y + '" width="' + bwid + '" height="' + Math.max(bh, 1.5) + '" rx="4" fill="' + fill + '"/>';
    var vy = p.eps >= 0 ? y - 5 : y + bh + 13;
    out += '<text x="' + (x + bwid / 2) + '" y="' + vy + '" text-anchor="middle" font-size="12.5" font-weight="800" fill="#141414">' + fmtNum(p.eps, Math.abs(p.eps) >= 100 ? 0 : 2) + '</text>';
    out += '<text x="' + (x + bwid / 2) + '" y="' + (h - 8) + '" text-anchor="middle" font-size="11.5" font-weight="700" fill="#77705f">' + esc(p.label) + (p.kind === 'est' ? ' est' : '') + '</text>';
  });
  out += '<defs><linearGradient id="goldGrad" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0%" stop-color="#B46A11"/><stop offset="33%" stop-color="#D68D15"/>' +
    '<stop offset="68%" stop-color="#E7AC18"/><stop offset="99%" stop-color="#F8C73D"/></linearGradient></defs>';
  out += '</svg>';
  return out;
}
function lineChartSVG(closes, high52, w, h) {
  w = w || 640; h = h || 170;
  if (!closes || closes.length < 2) return '';
  var padT = 16, padB = 20, padX = 6;
  var max = Math.max.apply(null, closes), min = Math.min.apply(null, closes);
  if (isNum(high52)) max = Math.max(max, high52);
  var span = (max - min) || 1;
  var X = function (i) { return padX + i * (w - padX * 2) / (closes.length - 1); };
  var Y = function (v) { return padT + (max - v) / span * (h - padT - padB); };
  var pts = closes.map(function (c, i) { return X(i).toFixed(1) + ',' + Y(c).toFixed(1); }).join(' ');
  var out = '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="One-year price chart">';
  if (isNum(high52)) {
    out += '<line x1="' + padX + '" y1="' + Y(high52) + '" x2="' + (w - padX) + '" y2="' + Y(high52) + '" stroke="#B46A11" stroke-width="1.4" stroke-dasharray="5 4"/>' +
      '<text x="' + (w - padX) + '" y="' + (Y(high52) - 4) + '" text-anchor="end" font-size="11" font-weight="800" fill="#B46A11">52-wk high ' + fmtNum(high52, 0) + '</text>';
  }
  out += '<polyline points="' + pts + '" fill="none" style="stroke:var(--chart-line)" stroke-width="2.2" stroke-linejoin="round"/>';
  out += '<text x="' + padX + '" y="' + (h - 5) + '" font-size="11" font-weight="700" fill="#77705f">1 year ago</text>' +
    '<text x="' + (w - padX) + '" y="' + (h - 5) + '" text-anchor="end" font-size="11" font-weight="700" fill="#77705f">now · ' + fmtNum(closes[closes.length - 1]) + '</text>';
  out += '</svg>';
  return out;
}

/* ============================== scorecard UI ============================== */
var lastStock = null;
function kvItem(k, v) { return '<div class="kv-item"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>'; }

/* ============================== SWOT (auto) ============================== */
/* A SWOT built from the numbers already on the scorecard — every bullet
 * cites the metric behind it. It reads figures, not news: company-specific
 * events (lawsuits, new rivals, regulation) can't appear here. */
function buildSwot(d) {
  var S = [], W = [], O = [], T = [];
  var sc = scoreStock(d);
  var traj = epsTrajectory(d);
  var pts = traj.points;
  // Implied growth between consecutive EPS points (TTM -> forecasts).
  var gs = [];
  for (var i = 1; i < pts.length; i++) {
    if (isNum(pts[i - 1].eps) && isNum(pts[i].eps) && pts[i - 1].eps > 0) {
      gs.push((pts[i].eps / pts[i - 1].eps - 1) * 100);
    }
  }
  // Strengths
  if (isNum(d.grossMargin) && d.grossMargin >= 50) S.push('Gross margin ' + fmtNum(d.grossMargin, 1) + '% — real pricing power; customers aren\'t buying on price alone.');
  if (isNum(d.roe) && d.roe >= 20) S.push('ROE ' + fmtNum(d.roe, 1) + '% — owners\' capital is working hard.');
  if (isNum(d.operMargin) && d.operMargin >= 20) S.push('Operating margin ' + fmtNum(d.operMargin, 1) + '% — the core business is solidly profitable.');
  var bestRev = Math.max(isNum(d.salesGrowthTTM) ? d.salesGrowthTTM : -Infinity, isNum(d.revGrowthQtr) ? d.revGrowthQtr : -Infinity);
  if (bestRev >= 15) S.push('Revenue growing ' + fmtPct(bestRev) + ' — demand is expanding, not just prices rising.');
  if (d.epsRecord && d.epsRecord.n >= 6 && d.epsRecord.beatPct >= 75) S.push('Beats EPS estimates ' + d.epsRecord.beatPct + '% of the time (last ' + d.epsRecord.n + ' quarters) — management tends to deliver.');
  if (isNum(d.debtEq) && d.debtEq <= 0.5) S.push('Light debt load (Debt/Equity ' + fmtNum(d.debtEq, 2) + ') — room to weather a downturn.');
  if (isNum(d.divYield) && d.divYield >= 2) S.push('Pays a ' + fmtNum(d.divYield, 2) + '% dividend — cash back while you wait.');
  if (isNum(d.marketCap) && d.marketCap >= 1e11) S.push('Large, established company (' + fmtCap(d.marketCap) + ' market cap) — liquid and widely followed.');
  // Weaknesses
  if (isNum(d.profitMargin) && d.profitMargin < 0) W.push('Currently unprofitable — net margin ' + fmtNum(d.profitMargin, 1) + '%.');
  if (isNum(d.debtEq) && d.debtEq >= 2) W.push('Heavy debt load (Debt/Equity ' + fmtNum(d.debtEq, 2) + ') — interest eats flexibility, and refinancing risk is real if rates stay high.');
  if (isNum(d.grossMargin) && d.grossMargin < 20) W.push('Thin gross margin ' + fmtNum(d.grossMargin, 1) + '% — little pricing power; cost rises land straight on profit.');
  if (isNum(d.epsGrowthTTM) && d.epsGrowthTTM < 0) W.push('EPS shrank ' + fmtPct(d.epsGrowthTTM) + ' over the last year.');
  if (isNum(d.revGrowthQtr) && d.revGrowthQtr < 0) W.push('Revenue fell ' + fmtPct(d.revGrowthQtr) + ' in the latest quarter vs a year earlier.');
  else if (isNum(d.salesGrowthTTM) && d.salesGrowthTTM < 3) W.push('Revenue barely growing — ' + fmtPct(d.salesGrowthTTM) + ' over the last year.');
  if (d.epsRecord && d.epsRecord.n >= 4 && d.epsRecord.missPct >= 40) W.push('Misses EPS estimates ' + d.epsRecord.missPct + '% of the time (last ' + d.epsRecord.n + ' quarters) — forecasts here are unreliable.');
  if (isNum(d.beta) && d.beta >= 1.8) W.push('Beta ' + fmtNum(d.beta, 2) + ' — swings roughly ' + fmtNum(d.beta, 1) + '× the market, both ways. Position size matters.');
  // Opportunities
  if (isNum(d.pctBelowHigh) && d.pctBelowHigh >= 25 && sc.score != null && sc.score >= 55) O.push(fmtNum(d.pctBelowHigh, 1) + '% below its 52-week high while the scorecard still rates it ' + sc.score + '/100 — a possible price dislocation.');
  if (isNum(d.target1Y) && isNum(d.price) && d.price > 0 && d.target1Y > d.price * 1.1) O.push('Analysts\' 1-yr target (' + fmtMoney(d.target1Y) + ') implies ' + fmtPct((d.target1Y / d.price - 1) * 100) + ' upside from here.');
  if (gs.length >= 2) {
    var avgG = gs.reduce(function (a, b) { return a + b; }, 0) / gs.length;
    if (avgG >= 15) O.push('Consensus sees EPS compounding ~' + fmtNum(avgG, 0) + '%/yr (' + pts[0].label + ' ' + fmtNum(pts[0].eps) + ' → ' + pts[pts.length - 1].label + ' ' + fmtNum(pts[pts.length - 1].eps) + ').');
  }
  if (isNum(d.peg) && d.peg < 1 && isNum(d.epsGrowth5Y) && d.epsGrowth5Y >= 10) O.push('PEG ' + fmtNum(d.peg, 2) + ' — the market isn\'t fully pricing the expected ~' + fmtNum(d.epsGrowth5Y, 0) + '%/yr growth.');
  if (isNum(d.revGrowthQtr) && isNum(d.salesGrowthTTM) && d.revGrowthQtr > d.salesGrowthTTM + 3) O.push('Revenue growth is accelerating — latest quarter ' + fmtPct(d.revGrowthQtr) + ' vs ' + fmtPct(d.salesGrowthTTM) + ' trailing.');
  // Threats
  var peak = -Infinity, peakLabel = '', cliff = null;
  for (var j = 0; j < pts.length; j++) {
    if (isNum(pts[j].eps) && pts[j].eps > peak) { peak = pts[j].eps; peakLabel = pts[j].label; }
    else if (peak > 0 && isNum(pts[j].eps) && pts[j].eps < peak * 0.90) { cliff = pts[j]; break; }
  }
  if (cliff) T.push('Earnings cliff in consensus — EPS peaks at ' + fmtNum(peak) + ' (' + peakLabel + '), then falls to ' + fmtNum(cliff.eps) + ' by ' + cliff.label + '.');
  else if (pts.length >= 2 && isNum(pts[1].eps) && isNum(pts[0].eps) && pts[1].eps < pts[0].eps) T.push('Consensus expects EPS to fall next year (' + fmtNum(pts[0].eps) + ' → ' + fmtNum(pts[1].eps) + ').');
  if (isNum(d.revGrowthQtr) && isNum(d.salesGrowthTTM) && d.revGrowthQtr < d.salesGrowthTTM - 3) T.push('Revenue growth is decelerating — latest quarter ' + fmtPct(d.revGrowthQtr) + ' vs ' + fmtPct(d.salesGrowthTTM) + ' trailing.');
  if (isNum(d.epsGrowthTTM) && d.epsGrowthTTM >= 60 && isNum(d.forwardPE) && d.forwardPE <= 12) T.push('Earnings look cyclically hot — EPS up ' + fmtPct(d.epsGrowthTTM) + ' in a year rarely lasts, and peak earnings make the P/E look deceptively cheap.');
  if (isNum(d.forwardPE) && d.forwardPE >= 35) T.push('Rich valuation (forward P/E ' + fmtNum(d.forwardPE, 1) + ') — priced for perfection; any miss hurts.');
  if (isNum(d.peg) && d.peg >= 2) T.push('PEG ' + fmtNum(d.peg, 2) + ' — paying a lot for the growth that\'s expected.');
  if (isNum(d.pctBelowHigh) && d.pctBelowHigh >= 45) T.push('Down ' + fmtNum(d.pctBelowHigh, 1) + '% from its 52-week high — a fall that deep can signal structural problems, not just a sale.');
  var cap4 = function (a) { return a.slice(0, 4); };
  return { S: cap4(S), W: cap4(W), O: cap4(O), T: cap4(T) };
}
function swotBox(letter, title, items, cls) {
  var lis = items.length
    ? items.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('')
    : '<li>Nothing stands out in the data.</li>';
  return '<div class="swot-box ' + cls + '"><h5><span class="swot-badge">' + letter + '</span>' + esc(title) + '</h5><ul>' + lis + '</ul></div>';
}

/* ============================== AI SWOT ============================== */
/* Classic qualitative SWOT generated on demand by the Llama 4 model on
 * the user's own Cloudflare Worker (/swot endpoint, Workers AI free
 * tier). The app sends the ticker plus a summary of the live metrics it
 * already fetched; the worker adds recent Yahoo headlines and returns
 * the four lists. Saved on-device per ticker so it persists. */
var AI_SWOT_URL = 'https://stock-research-relay.supplessayings-6e6.workers.dev/swot';
var AI_SWOT_KEY = 'sr_aiswot_v1';

function getAiSwot(ticker) {
  var all = lsGet(AI_SWOT_KEY, {});
  return all[ticker] || null;
}
function saveAiSwot(ticker, entry) {
  var all = lsGet(AI_SWOT_KEY, {});
  all[ticker] = entry;
  lsSet(AI_SWOT_KEY, all);
}
function aiMetricsText(d) {
  var sc = scoreStock(d);
  var parts = [];
  if (isNum(d.marketCap)) parts.push('market cap ' + fmtCap(d.marketCap));
  if (isNum(d.forwardPE)) parts.push('forward P/E ' + fmtNum(d.forwardPE, 1));
  if (isNum(d.pe)) parts.push('trailing P/E ' + fmtNum(d.pe, 1));
  if (isNum(d.peg)) parts.push('PEG ' + fmtNum(d.peg, 2));
  if (isNum(d.grossMargin)) parts.push('gross margin ' + fmtNum(d.grossMargin, 1) + '%');
  if (isNum(d.operMargin)) parts.push('operating margin ' + fmtNum(d.operMargin, 1) + '%');
  if (isNum(d.profitMargin)) parts.push('profit margin ' + fmtNum(d.profitMargin, 1) + '%');
  if (isNum(d.roe)) parts.push('ROE ' + fmtNum(d.roe, 1) + '%');
  if (isNum(d.debtEq)) parts.push('debt/equity ' + fmtNum(d.debtEq, 2));
  if (isNum(d.beta)) parts.push('beta ' + fmtNum(d.beta, 2));
  if (isNum(d.salesGrowthTTM)) parts.push('revenue growth (TTM) ' + fmtPct(d.salesGrowthTTM));
  if (isNum(d.revGrowthQtr)) parts.push('revenue growth latest quarter ' + fmtPct(d.revGrowthQtr));
  if (isNum(d.epsGrowthTTM)) parts.push('EPS growth (TTM) ' + fmtPct(d.epsGrowthTTM));
  var traj = epsTrajectory(d);
  if (traj.points.length >= 2) {
    parts.push('consensus EPS path: ' + traj.points.map(function (p) { return p.label + ' ' + fmtNum(p.eps); }).join(' -> '));
  }
  if (traj.warning) parts.push('note: ' + traj.warning);
  if (d.epsRecord && d.epsRecord.n >= 4) {
    parts.push('EPS beat rate ' + d.epsRecord.beatPct + '% / miss rate ' + d.epsRecord.missPct + '% over last ' + d.epsRecord.n + ' quarters');
  }
  if (isNum(d.divYield)) parts.push('dividend yield ' + fmtNum(d.divYield, 2) + '%');
  return parts.join('; ') + '.';
}
function aiSwotGridHtml(entry) {
  return '<div class="swot-grid">' +
    swotBox('S', 'Strengths', entry.swot.S, 'sw-s') + swotBox('W', 'Weaknesses', entry.swot.W, 'sw-w') +
    swotBox('O', 'Opportunities', entry.swot.O, 'sw-o') + swotBox('T', 'Threats', entry.swot.T, 'sw-t') + '</div>' +
    '<p class="fineprint">AI-generated ' + esc(entry.asOf || '') + ' by Llama 4 on your Cloudflare account, from the live numbers above plus recent headlines. Strengths/Weaknesses are internal to the company; Opportunities/Threats are external factors. AI can be wrong or out of date — a starting point, not gospel. <button class="btn-ghost" id="ai-swot-btn" type="button">↻ Regenerate</button></p>';
}
function bindAiSwotBtn(d) {
  var b = $('ai-swot-btn');
  if (b) b.addEventListener('click', function () { runAiSwot(d); });
}
async function runAiSwot(d) {
  var zone = $('ai-swot-zone');
  if (!zone) return;
  zone.innerHTML = '<p class="fineprint"><span class="spinner"></span>Writing the SWOT — the AI is reading the numbers and recent headlines; give it up to ~30 seconds…</p>';
  try {
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 90000) : null;
    var resp = await fetch(AI_SWOT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker: d.ticker,
        name: d.companyName || d.ticker,
        sector: d.sector || '',
        industry: d.industry || '',
        metrics: aiMetricsText(d)
      }),
      signal: ctrl ? ctrl.signal : undefined
    });
    if (timer) clearTimeout(timer);
    var data = await resp.json();
    if (!resp.ok || !data.swot) throw new Error((data && data.error) || ('HTTP ' + resp.status));
    var entry = { asOf: data.asOf || '', swot: data.swot };
    saveAiSwot(d.ticker, entry);
    var z2 = $('ai-swot-zone');
    if (z2) { z2.innerHTML = aiSwotGridHtml(entry); bindAiSwotBtn(d); }
  } catch (e) {
    var z3 = $('ai-swot-zone');
    if (z3) {
      z3.innerHTML = '<div class="alert warn">The AI SWOT didn\'t come back (' + esc(e.message || 'network error') + '). <button class="btn-ghost" id="ai-swot-btn" type="button">Try again</button></div>';
      bindAiSwotBtn(d);
    }
  }
}

function renderScorecard(d) {
  lastStock = d;
  var sc = scoreStock(d);
  var screen = valueScreen(d);
  var traj = epsTrajectory(d);
  var passCount = screen.filter(function (s) { return s.test === true; }).length;
  var knownCount = screen.filter(function (s) { return s.test !== null; }).length;
  var vClass = sc.verdict === 'Undervalued' ? 'undervalued' : sc.verdict === 'Fairly valued' ? 'fair' : 'overpriced';
  var chgCls = isNum(d.dayChangePct) ? (d.dayChangePct >= 0 ? 'up' : 'down') : '';
  var html = '<div class="card">';
  html += '<div class="sc-head"><div><div class="sc-name">' + esc(d.companyName || d.ticker) + ' <span class="gold-text">' + esc(d.ticker) + '</span></div>' +
    '<div class="sc-sub">' + esc([d.exchange, d.sector, d.industry].filter(Boolean).join(' · ')) + '</div></div>' +
    '<div class="sc-price"><div class="p">' + fmtMoney(d.price) + '</div>' +
    '<div class="chg ' + chgCls + '">' + (isNum(d.dayChangePct) ? fmtPct(d.dayChangePct) + ' today' : '') + '</div></div></div>';

  if (sc.score != null) {
    html += '<div class="verdict ' + vClass + '"><div><div class="v-label">Valuation verdict</div>' +
      '<div class="v-word">' + esc(sc.verdict) + '</div></div>' +
      '<div class="v-score">' + sc.score + '<small> / 100</small></div></div>';
    html += '<div class="score-bar"><div style="width:' + sc.score + '%"></div></div>';
    html += '<table class="factors"><tr><th>Factor</th><th>Value</th><th class="num">Points</th></tr>';
    sc.factors.forEach(function (f) {
      html += '<tr><td><strong>' + esc(f.name) + '</strong><div class="factor-note">' + esc(f.note) + '</div></td><td>' + esc(f.display) + '</td><td class="num"><strong>' + f.pts + '</strong> / ' + f.max + '</td></tr>';
    });
    html += '</table>';
    if (sc.maxAvailable < 100) {
      html += '<p class="fineprint">Score is scaled to 100 over the ' + sc.factors.length + ' factors with available data (' + sc.maxAvailable + ' pts possible). Missing data is never guessed.</p>';
    }
  } else {
    html += '<div class="alert warn">Not enough data came back to score this stock. The key stats below show what was found.</div>';
  }

  html += '<div class="section-h">Your value screen — <span class="gold-text">' + passCount + ' of ' + knownCount + '</span></div>';
  html += '<div class="screen-chips">';
  screen.forEach(function (s) {
    var cls = s.test === null ? '' : s.test ? 'pass' : 'fail';
    var mark = s.test === null ? '?' : s.test ? '✓ PASS' : '✗';
    html += '<div class="chip ' + cls + '"><span>' + esc(s.label) + '<br><span class="factor-note">' + esc(s.value) + '</span></span><span class="mark">' + mark + '</span></div>';
  });
  html += '</div>';

  html += '<div class="section-h">Key <span class="gold-text">stats</span></div><div class="kv-grid">';
  html += kvItem('Market cap', fmtCap(d.marketCap));
  html += kvItem('Forward P/E', isNum(d.forwardPE) ? fmtNum(d.forwardPE, 2) + (d.forwardPECalc ? ' (calc.)' : '') : '—');
  html += kvItem('P/E (trailing)', isNum(d.pe) ? fmtNum(d.pe, 2) : '—');
  html += kvItem('PEG', isNum(d.peg) ? fmtNum(d.peg, 2) + (d.pegCalc ? ' (calc.)' : '') : '—');
  html += kvItem('EPS (trailing)', isNum(d.epsTTM) ? fmtNum(d.epsTTM) : '—');
  html += kvItem('EPS growth next yr', isNum(d.epsGrowthNextY) ? fmtPct(d.epsGrowthNextY) : '—');
  if (d.epsRecord && d.epsRecord.n >= 4) {
    html += kvItem('EPS miss rate · last ' + d.epsRecord.n + ' qtrs', d.epsRecord.missPct + '%');
    html += kvItem('EPS beat rate · last ' + d.epsRecord.n + ' qtrs', d.epsRecord.beatPct + '%');
  }
  html += kvItem('Revenue growth (TTM)', isNum(d.salesGrowthTTM) ? fmtPct(d.salesGrowthTTM) : '—');
  if (isNum(d.revGrowthQtr)) {
    html += kvItem('Revenue growth (latest qtr)', fmtPct(d.revGrowthQtr));
  }
  html += kvItem('Gross margin', isNum(d.grossMargin) ? fmtNum(d.grossMargin, 1) + '%' : '—');
  html += kvItem('Operating margin', isNum(d.operMargin) ? fmtNum(d.operMargin, 1) + '%' : '—');
  html += kvItem('Profit margin', isNum(d.profitMargin) ? fmtNum(d.profitMargin, 1) + '%' : '—');
  html += kvItem('Debt / Equity', isNum(d.debtEq) ? fmtNum(d.debtEq, 2) : '—');
  html += kvItem('ROE', isNum(d.roe) ? fmtNum(d.roe, 1) + '%' : '—');
  html += kvItem('Beta', isNum(d.beta) ? fmtNum(d.beta, 2) : '—');
  html += kvItem('52-wk range', (isNum(d.low52) ? fmtNum(d.low52, 0) : '—') + ' – ' + (isNum(d.high52) ? fmtNum(d.high52, 0) : '—'));
  html += kvItem('Below 52-wk high', isNum(d.pctBelowHigh) ? fmtNum(d.pctBelowHigh, 1) + '%' : '—');
  html += kvItem('Dividend yield', isNum(d.divYield) ? fmtNum(d.divYield, 2) + '%' : '—');
  html += kvItem('Analyst 1-yr target', isNum(d.target1Y) ? fmtMoney(d.target1Y) : '—');
  html += '</div>';

  html += '<div class="section-h">EPS trajectory — <span class="gold-text">cliff check</span></div>';
  if (traj.points.length >= 2) {
    html += '<div class="chart-wrap">' + barChartSVG(traj.points) + '</div>';
    if (traj.warning) html += '<div class="alert warn">⚠ ' + esc(traj.warning) + '</div>';
    else html += '<div class="alert ok">✓ No cliff in the consensus path — estimates don\'t fall off a peak inside the forecast window. That doesn\'t make it safe; it means the cheapness isn\'t obviously a peak-earnings illusion.</div>';
  } else {
    html += '<p class="fineprint">Not enough EPS data came back to run the cliff check for this ticker.</p>';
  }

  var aiSaved = getAiSwot(d.ticker);
  html += '<div class="section-h">Classic SWOT — <span class="gold-text">AI</span></div><div id="ai-swot-zone">';
  if (aiSaved && aiSaved.swot) {
    html += aiSwotGridHtml(aiSaved);
  } else {
    html += '<p class="fineprint">Written on demand by an AI (Llama 4, running free on your own Cloudflare account) from the live numbers on this page plus recent headlines — the qualitative side the numbers can\'t show: brand, rivals, regulation. Classic rules: Strengths and Weaknesses are internal to the company; Opportunities and Threats are external factors.</p>' +
      '<button class="btn-ghost" id="ai-swot-btn" type="button">✦ Generate AI SWOT</button>';
  }
  html += '</div>';

  var swot = buildSwot(d);
  html += '<div class="section-h">SWOT — <span class="gold-text">from the numbers</span></div>';
  html += '<div class="swot-grid">' +
    swotBox('S', 'Strengths', swot.S, 'sw-s') + swotBox('W', 'Weaknesses', swot.W, 'sw-w') +
    swotBox('O', 'Opportunities', swot.O, 'sw-o') + swotBox('T', 'Threats', swot.T, 'sw-t') + '</div>';
  html += '<p class="fineprint">Auto-generated from the figures on this page — it reads the numbers, not the news, so company-specific events (lawsuits, new rivals, regulation) won\'t show up here.</p>';

  if (d.history && d.history.length >= 2) {
    html += '<div class="section-h">Price — <span class="gold-text">1 year</span></div><div class="chart-wrap">' + lineChartSVG(d.history, d.high52) + '</div>';
  }

  html += '<div class="sc-actions">' +
    '<button class="btn-ghost" id="sc-watch" type="button">◎ Add to watchlist</button>' +
    '<button class="btn-ghost" id="sc-journal" type="button">✎ Journal this stock</button>' +
    '<button class="btn-ghost" id="sc-project" type="button">✦ Project it</button>' +
    '<button class="btn-ghost" id="sc-refresh" type="button">↻ Refresh data</button></div>';

  var when = d.fetchedAt ? new Date(d.fetchedAt).toLocaleString() : '';
  if (d.partial) html += '<div class="alert warn">Fast data is in — still pulling valuation details (forward P/E, PEG, margins)… the score updates when they land.</div>';
  html += '<p class="src-line">Sources: ' + esc(d.sources.join(', ') || '—') + ' · Fetched ' + esc(when) + (d.fromCache ? ' (cached, ≤15 min old)' : '') +
    (d.route ? ' · Route: ' + esc(d.route === 'public relay' ? 'public relay (backup)' : d.route) : '') +
    '. Figures can differ slightly between sources and from your broker. Research tool, not financial advice.</p>';
  html += '</div>';
  $('score-result').innerHTML = html;
  $('score-empty').style.display = 'none';

  bindAiSwotBtn(d);
  $('sc-watch').addEventListener('click', function () {
    addToWatchlist(d.ticker, isNum(d.price) ? d.price : null);
    switchTab('watchlist');
  });
  $('sc-journal').addEventListener('click', function () {
    switchTab('journal');
    startJournalEdit(d.ticker);
  });
  $('sc-project').addEventListener('click', function () {
    switchTab('tools');
    $('pj-ticker').value = d.ticker;
    fillProjection(d);
    runProjection();
  });
  $('sc-refresh').addEventListener('click', function () { runSearch(d.ticker, true); });
}

async function runSearch(ticker, fresh) {
  var T = String(ticker || '').trim().toUpperCase();
  if (!T) return;
  var status = $('score-status');
  status.className = 'status';
  status.innerHTML = '<span class="spinner"></span>Pulling live data for ' + esc(T) + '…';
  // Instant paint: if this ticker was looked up before, show the saved
  // data right away (even if stale) and refresh over the top — repeat
  // lookups feel instant instead of staring at a spinner in a relay wave.
  var staleHit = lsGet(CACHE_KEY, {})[T];
  var showedStale = false;
  if (staleHit && staleHit.data) {
    staleHit.data.fromCache = true;
    try { renderScorecard(staleHit.data); showedStale = true; } catch (e) {}
    if (showedStale) {
      status.innerHTML = '<span class="spinner"></span>Showing your last saved data for ' + esc(T) + ' — refreshing…';
    }
  }
  // The free relays fail in waves (rate limits, brief outages). Rather
  // than erroring on the first bad wave, retry the whole lookup a few
  // times with pauses — most waves clear within a minute.
  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      var d = await fetchStock(T, { fresh: !!fresh, onStage: function (interim) {
        status.innerHTML = '<span class="spinner"></span>Fast data for ' + esc(T) + ' is in — valuation details still coming…';
        renderScorecard(interim);
      } });
      status.textContent = '';
      renderScorecard(d);
      return;
    } catch (e) {
      if (attempt >= 3) {
        status.className = 'status err';
        status.textContent = showedStale
          ? 'Couldn\'t refresh ' + T + ' — the data routes are having a bad stretch. You\'re still seeing your last saved data above; try Refresh again in a minute.'
          : (e.message || 'Something went wrong fetching that ticker.') + ' (Tried 3 times — the data routes are having a bad stretch. Give it a minute and tap Research again.)';
        return;
      }
      status.innerHTML = '<span class="spinner"></span>A data route hiccuped — retrying automatically (' + attempt + ' of 3)…';
      await new Promise(function (res) { setTimeout(res, attempt * 1500); });
    }
  }
}

/* ============================== compare ============================== */
async function runCompare() {
  var tickers = [$('cmp-1').value, $('cmp-2').value, $('cmp-3').value]
    .map(function (v) { return v.trim().toUpperCase(); }).filter(Boolean);
  var status = $('compare-status');
  if (tickers.length < 2) { status.className = 'status err'; status.textContent = 'Enter at least two tickers to compare.'; return; }
  status.className = 'status';
  status.innerHTML = '<span class="spinner"></span>Fetching ' + tickers.join(', ') + '…';
  var results = [];
  for (var i = 0; i < tickers.length; i++) {
    try { results.push(await fetchStock(tickers[i])); }
    catch (e) { results.push({ ticker: tickers[i], error: e.message }); }
  }
  status.textContent = '';
  var ok = results.filter(function (r) { return !r.error; });
  if (!ok.length) { $('compare-result').innerHTML = '<div class="alert warn">None of those tickers loaded — the data routes may be busy. Try again in a moment.</div>'; return; }
  var rows = [
    { label: 'Price', get: function (d) { return d.price; }, fmt: function (v) { return fmtMoney(v); }, best: null },
    { label: 'Market cap', get: function (d) { return d.marketCap; }, fmt: fmtCap, best: 'max' },
    { label: 'Forward P/E ↓', get: function (d) { return d.forwardPE; }, fmt: function (v) { return fmtNum(v, 2); }, best: 'min' },
    { label: 'PEG ↓', get: function (d) { return d.peg; }, fmt: function (v) { return fmtNum(v, 2); }, best: 'min' },
    { label: 'Below 52-wk high', get: function (d) { return d.pctBelowHigh; }, fmt: function (v) { return fmtNum(v, 1) + '%'; }, best: 'max' },
    { label: 'EPS growth next yr', get: function (d) { return d.epsGrowthNextY; }, fmt: function (v) { return fmtPct(v); }, best: 'max' },
    { label: 'Profit margin', get: function (d) { return d.profitMargin; }, fmt: function (v) { return fmtNum(v, 1) + '%'; }, best: 'max' },
    { label: 'Debt / Equity ↓', get: function (d) { return d.debtEq; }, fmt: function (v) { return fmtNum(v, 2); }, best: 'min' },
    { label: 'Value screen', get: function (d) { return valueScreen(d).filter(function (s) { return s.test === true; }).length; }, fmt: function (v) { return v + ' / 4'; }, best: 'max' },
    { label: 'Score', get: function (d) { return scoreStock(d).score; }, fmt: function (v) { return isNum(v) ? v + ' / 100' : '—'; }, best: 'max' }
  ];
  var html = '<div class="card"><table class="cmp"><tr><th></th>';
  ok.forEach(function (d) { html += '<th class="num">' + esc(d.ticker) + '</th>'; });
  html += '</tr>';
  rows.forEach(function (row) {
    var vals = ok.map(row.get);
    var bestIdx = -1;
    if (row.best) {
      var bestVal = row.best === 'min' ? Infinity : -Infinity;
      vals.forEach(function (v, i2) {
        if (isNum(v) && (row.best === 'min' ? v < bestVal : v > bestVal)) { bestVal = v; bestIdx = i2; }
      });
    }
    html += '<tr><td class="rowh">' + esc(row.label) + '</td>';
    vals.forEach(function (v, i2) {
      var isBest = i2 === bestIdx;
      html += '<td class="num' + (isBest ? ' best' : '') + '">' + (isBest ? '<span class="star">★</span> ' : '') + esc(row.fmt(v)) + '</td>';
    });
    html += '</tr>';
  });
  html += '</table><p class="fineprint">★ = strongest value on that row. Lower is better where marked ↓. Same scoring rubric as the Scorecard tab.</p></div>';
  $('compare-result').innerHTML = html;
}

/* ============================== tools ============================== */
/* Populate the Projection Builder from a fetched stock record:
 * current price, current (TTM) EPS, and the analysts' year-by-year EPS
 * forecast path (up to 5 years). Every year renders an editable EPS box
 * and an editable growth-% box; the two stay in sync — edit an EPS and
 * its growth recomputes, edit a growth % and that year's EPS recomputes. */
var pjPath = [];            // [{label:'FY2026', eps:1.42, extrapolated:bool}]
var pjPathFromForecast = false;

function pjBaseEps() { var v = parseFloat($('pj-eps').value); return isNum(v) ? v : null; }
function pjYearsWanted() {
  var y = parseInt($('pj-years').value, 10);
  return isNum(y) ? Math.max(1, Math.min(5, y)) : 3;
}
function pjFlatGrowth() {
  var g = parseFloat($('pj-growth').value);
  return isNum(g) ? g : 15;
}
/* Growth % of each path year vs the prior year's EPS (year 1 vs base). */
function pjGrowths(base, path) {
  var out = [], prev = base;
  for (var i = 0; i < path.length; i++) {
    out.push(isNum(prev) && prev !== 0 && isNum(path[i].eps) ? (path[i].eps / prev - 1) * 100 : null);
    prev = path[i].eps;
  }
  return out;
}
/* Pure case math: chain the EPS path with every year's growth shifted by
 * deltaPts and return the exit-year EPS. Exported for testing. */
function pjCaseEps(base, path, deltaPts) {
  var growths = pjGrowths(base, path);
  var eps = base;
  for (var i = 0; i < path.length; i++) {
    var g = growths[i];
    if (!isNum(g) || !isNum(eps)) { eps = path[i].eps; continue; }
    eps = eps * (1 + (g + deltaPts) / 100);
  }
  return eps;
}
/* Grow the path to at least n years, extrapolating past the last known
 * year at that year's growth (or the flat fallback rate). */
function pjEnsureYears(n) {
  var base = pjBaseEps(), guard = 0;
  while (pjPath.length < n && guard++ < 5) {
    var prevEps = pjPath.length ? pjPath[pjPath.length - 1].eps : base;
    var growths = pjGrowths(base, pjPath);
    var lastG = growths.length ? growths[growths.length - 1] : null;
    var g = isNum(lastG) ? lastG : pjFlatGrowth();
    var yr = null;
    if (pjPath.length) {
      var m = String(pjPath[pjPath.length - 1].label).match(/(\d{4})/);
      if (m) yr = parseInt(m[1], 10) + 1;
    }
    pjPath.push({
      label: yr ? 'FY' + yr : 'Year ' + (pjPath.length + 1),
      eps: isNum(prevEps) ? +(prevEps * (1 + g / 100)).toFixed(4) : null,
      extrapolated: true
    });
  }
}
/* No analyst path available: synthesize the rows from the flat rate. */
function pjSynthPath() {
  pjPath = [];
  pjPathFromForecast = false;
  var base = pjBaseEps(), g = pjFlatGrowth(), n = pjYearsWanted();
  var eps = base;
  for (var i = 0; i < n; i++) {
    eps = isNum(eps) ? eps * (1 + g / 100) : null;
    pjPath.push({ label: 'Year ' + (i + 1), eps: isNum(eps) ? +eps.toFixed(4) : null, extrapolated: false });
  }
}
function renderPjPath() {
  var box = $('pj-path');
  if (!box) return;
  var base = pjBaseEps();
  var n = pjYearsWanted();
  pjEnsureYears(n);
  var growths = pjGrowths(base, pjPath);
  var html = '';
  for (var i = 0; i < n; i++) {
    var row = pjPath[i];
    html += '<div class="pj-yrow"><div class="pj-ylab">' + esc(row.label) + (row.extrapolated && isNum(row.eps) ? ' *' : '') + '</div>' +
      '<label>EPS $<input data-pjeps="' + i + '" type="number" step="any" value="' + (isNum(row.eps) ? fmtNum(row.eps, 2) : '') + '"></label>' +
      '<label>Growth %<input data-pjg="' + i + '" type="number" step="any" value="' + (isNum(growths[i]) ? fmtNum(growths[i], 1) : '') + '"></label></div>';
  }
  box.innerHTML = html;
}
function onPjPathEdit(e) {
  var t = e.target;
  if (!t || !t.hasAttribute) return;
  var base = pjBaseEps();
  if (t.hasAttribute('data-pjeps')) {
    var i = parseInt(t.getAttribute('data-pjeps'), 10);
    var v = parseFloat(t.value);
    if (isNum(v) && pjPath[i]) { pjPath[i].eps = v; pjPath[i].extrapolated = false; renderPjPath(); }
  } else if (t.hasAttribute('data-pjg')) {
    var j = parseInt(t.getAttribute('data-pjg'), 10);
    var gv = parseFloat(t.value);
    var prev = j === 0 ? base : (pjPath[j - 1] ? pjPath[j - 1].eps : null);
    if (isNum(gv) && isNum(prev) && pjPath[j]) {
      pjPath[j].eps = +(prev * (1 + gv / 100)).toFixed(4);
      pjPath[j].extrapolated = false;
      renderPjPath();
    }
  }
}
function fillProjection(d) {
  if (isNum(d.price)) $('pj-price').value = d.price;
  var base = isNum(d.epsTTM) ? d.epsTTM : (isNum(d.epsNextY) ? d.epsNextY :
    (d.epsForecasts && d.epsForecasts[0] ? d.epsForecasts[0].eps : null));
  if (isNum(base)) $('pj-eps').value = base;
  if (isNum(d.epsGrowth5Y)) $('pj-growth').value = Math.max(-20, Math.min(60, Math.round(d.epsGrowth5Y)));
  else if (isNum(d.epsGrowthNextY)) $('pj-growth').value = Math.round(Math.max(-20, Math.min(60, d.epsGrowthNextY)));
  // Year-by-year analyst EPS path, up to 5 years.
  var fc = (d.epsForecasts || []).filter(function (r) { return r && isNum(r.eps); }).slice(0, 5);
  if (fc.length) {
    pjPathFromForecast = true;
    pjPath = fc.map(function (r, i) {
      var ym = String(r.fiscalEnd || '').match(/(\d{4})/);
      return { label: ym ? 'FY' + ym[1] : 'Year ' + (i + 1), eps: r.eps, extrapolated: false };
    });
  } else {
    pjSynthPath();
  }
  renderPjPath();
}
async function loadProjectionTicker() {
  var T = ($('pj-ticker').value || '').trim().toUpperCase();
  var status = $('pj-status');
  if (!T) { status.className = 'status err'; status.textContent = 'Type a ticker first.'; return; }
  status.className = 'status';
  status.innerHTML = '<span class="spinner"></span>Loading live data for ' + esc(T) + '…';
  try {
    var d = await fetchStock(T);
    fillProjection(d);
    var bits = [];
    if (isNum(d.price)) bits.push('price ' + fmtMoney(d.price));
    if (isNum(d.epsTTM)) bits.push('EPS (TTM) ' + fmtMoney(d.epsTTM));
    var fcBits = (d.epsForecasts || []).filter(function (r) { return r && isNum(r.eps); }).slice(0, 5);
    if (fcBits.length) bits.push('analyst EPS path ' + fcBits.map(function (r) { return fmtMoney(r.eps); }).join(' → '));
    if (isNum(d.epsGrowth5Y)) bits.push('analyst 5-yr EPS growth ' + fmtNum(d.epsGrowth5Y, 1) + '%/yr');
    else if (isNum(d.epsGrowthNextY)) bits.push('next-yr EPS growth ' + fmtNum(d.epsGrowthNextY, 1) + '%');
    status.textContent = 'Loaded ' + T + (bits.length ? ' — ' + bits.join(' · ') : '') + '. Adjust the assumptions below, then build.';
    runProjection();
  } catch (e) {
    status.className = 'status err';
    status.textContent = e.message || 'Could not load that ticker.';
  }
}
function runProjection() {
  var price = parseFloat($('pj-price').value);
  var base = pjBaseEps();
  var years = pjYearsWanted();
  var mult = parseFloat($('pj-mult').value);
  var out = $('pj-result');
  if (!isNum(price) || !isNum(base) || !isNum(mult)) {
    out.innerHTML = '<div class="alert warn">Fill in price, EPS base and exit P/E to build the projection.</div>'; return;
  }
  if (!pjPath.length) pjSynthPath();
  pjEnsureYears(years);
  renderPjPath();
  var path = pjPath.slice(0, years);
  var scen = [
    { name: 'Bear', d: -5, m: mult - 2, note: 'path −5 pts/yr' },
    { name: 'Base', d: 0, m: mult, note: 'your path' },
    { name: 'Bull', d: 5, m: mult + 2, note: 'path +5 pts/yr' }
  ];
  var html = '<table class="factors scen"><tr><th>Case</th><th>EPS in ' + years + 'y</th><th>Exit P/E</th><th class="num">Implied price</th><th class="num">Return</th><th class="num">CAGR</th></tr>';
  scen.forEach(function (s) {
    var feps = pjCaseEps(base, path, s.d);
    if (!isNum(feps)) {
      html += '<tr><td><strong>' + s.name + '</strong> <span class="factor-note">(' + s.note + ')</span></td><td>—</td><td>' + fmtNum(s.m, 1) + '×</td><td class="num">—</td><td class="num">—</td><td class="num">—</td></tr>';
      return;
    }
    var fp = feps * s.m;
    var ret = (fp / price - 1) * 100;
    var cagr = fp > 0 ? (Math.pow(fp / price, 1 / years) - 1) * 100 : -100;
    html += '<tr><td><strong>' + s.name + '</strong> <span class="factor-note">(' + s.note + ')</span></td><td>' + fmtMoney(feps) + '</td><td>' + fmtNum(s.m, 1) + '×</td>' +
      '<td class="num"><strong>' + fmtMoney(fp) + '</strong></td><td class="num ' + (ret >= 0 ? 'up' : 'down') + '">' + fmtPct(ret) + '</td><td class="num">' + fmtPct(cagr) + '</td></tr>';
  });
  html += '</table>';
  out.innerHTML = html;
}
function runCompound() {
  var init = parseFloat($('cc-init').value) || 0;
  var monthly = parseFloat($('cc-monthly').value) || 0;
  var years = parseInt($('cc-years').value, 10) || 0;
  var rate = parseFloat($('cc-rate').value);
  var out = $('cc-result');
  if (!isNum(rate) || years < 1) { out.innerHTML = '<div class="alert warn">Enter a return rate and at least 1 year.</div>'; return; }
  var r = rate / 100 / 12, bal = init, series = [init], contributed = init;
  for (var m = 1; m <= years * 12; m++) {
    bal = bal * (1 + r) + monthly;
    contributed += monthly;
    if (m % 12 === 0) series.push(bal);
  }
  var gains = bal - contributed;
  // mini area chart
  var w = 640, h = 150, max = Math.max.apply(null, series.concat([contributed])), min = 0;
  var X = function (i) { return 6 + i * (w - 12) / (series.length - 1); };
  var Y = function (v) { return 8 + (max - v) / ((max - min) || 1) * (h - 34); };
  var pts = series.map(function (v, i) { return X(i).toFixed(1) + ',' + Y(v).toFixed(1); }).join(' ');
  var area = '6,' + (h - 26) + ' ' + pts + ' ' + X(series.length - 1).toFixed(1) + ',' + (h - 26);
  var svg = '<svg viewBox="0 0 ' + w + ' ' + h + '"><polygon points="' + area + '" fill="rgba(248,199,61,.35)"/>' +
    '<polyline points="' + pts + '" fill="none" stroke="#B46A11" stroke-width="2.4"/>' +
    '<text x="6" y="' + (h - 6) + '" font-size="11" font-weight="700" fill="#77705f">today</text>' +
    '<text x="' + (w - 6) + '" y="' + (h - 6) + '" text-anchor="end" font-size="11" font-weight="700" fill="#77705f">year ' + years + '</text></svg>';
  out.innerHTML = '<div class="tool-big">Worth ' + fmtMoney(bal, 0) + ' in ' + years + ' years</div>' +
    '<p class="fineprint" style="margin:6px 0 10px">You put in ' + fmtMoney(contributed, 0) + ' · growth adds ' + fmtMoney(gains, 0) +
    ' at ' + fmtNum(rate, 1) + '%/yr with monthly compounding.</p><div class="chart-wrap">' + svg + '</div>';
}

/* ============================== watchlist ============================== */
var WL_KEY = 'sr_watchlist_v1';
function getWatchlist() { return lsGet(WL_KEY, []); }
function setWatchlist(w) { lsSet(WL_KEY, w); }
function addToWatchlist(ticker, target) {
  var T = String(ticker || '').trim().toUpperCase();
  if (!T) return;
  var wl = getWatchlist();
  var existing = wl.filter(function (x) { return x.ticker === T; })[0];
  if (existing) { if (isNum(target)) existing.target = target; }
  else wl.push({ ticker: T, target: isNum(target) ? target : null, addedAt: Date.now() });
  setWatchlist(wl);
  renderWatchlist(true);
}
async function fetchLightPrice(T) {
  var cache = lsGet(CACHE_KEY, {});
  var hit = cache[T];
  if (hit && hit.data && isNum(hit.data.price) && (Date.now() - hit.ts) < CACHE_TTL) return hit.data.price;
  try {
    var info = await relayJSON('https://api.nasdaq.com/api/quote/' + encodeURIComponent(T) + '/info?assetclass=stocks');
    var p = parseNum(info && info.data && info.data.primaryData && info.data.primaryData.lastSalePrice);
    if (isNum(p)) return p;
  } catch (e) {}
  var d = await fetchStock(T);
  return d.price;
}

/* ---- watchlist valuation scores + sorting ---- */
var WLVAL_KEY = 'sr_wlval_v1';
var WLSORT_KEY = 'sr_wlsort_v1';
function getWlSort() {
  try { return localStorage.getItem(WLSORT_KEY) || 'added'; } catch (e) { return 'added'; }
}
/* Best available valuation for a watchlist row, synchronously: a recent
 * full scorecard fetch wins; otherwise the saved Finviz-only score. */
function wlValuationDisplay(T) {
  var cache = lsGet(CACHE_KEY, {});
  var hit = cache[T];
  if (hit && hit.data && (Date.now() - hit.ts) < 24 * 3600 * 1000) {
    var sc = scoreStock(hit.data);
    if (sc.score != null) return { score: sc.score, verdict: sc.verdict, fresh: (Date.now() - hit.ts) < CACHE_TTL };
  }
  var map = lsGet(WLVAL_KEY, {});
  var e = map[T];
  if (e && isNum(e.score)) return { score: e.score, verdict: e.verdict, fresh: (Date.now() - (e.at || 0)) < 24 * 3600 * 1000 };
  return null;
}
/* Finviz-only valuation pass for the watchlist (one fetch per ticker). */
async function fetchWlValuation(T) {
  var d = { ticker: T, sources: [], errors: [] };
  try {
    var fvHtml = await relayFetch('https://finviz.com/stock?t=' + encodeURIComponent(T), {
      validate: function (t) { return t.indexOf('snapshot-td-label') !== -1; }
    });
    fillFromFinviz(d, fvHtml);
  } catch (e) {}
  var sc = scoreStock(d);
  return sc.score != null ? { score: sc.score, verdict: sc.verdict } : null;
}

async function renderWatchlist(refresh) {
  var wl = getWatchlist();
  var box = $('wl-list');
  if (!wl.length) {
    box.innerHTML = '<div class="empty-note"><h2>Nothing here yet</h2><p>Add a ticker and the buy price you\'re waiting for. Prices refresh live; the list lives only on this device.</p></div>';
    return;
  }
  if (refresh) $('wl-status').innerHTML = '<span class="spinner"></span>Refreshing\u2026';
  // Gather prices first so the list can be sorted on real numbers.
  var rows = [];
  for (var i = 0; i < wl.length; i++) {
    var item = wl[i];
    var price = null, err = null;
    try { price = await fetchLightPrice(item.ticker); } catch (e) { err = e.message; }
    rows.push({ item: item, price: price, err: err, val: wlValuationDisplay(item.ticker) });
  }
  // On an explicit refresh, fill in missing or stale valuation scores
  // with a Finviz-only pass (a fresh full scorecard score wins as-is).
  if (refresh) {
    var vmap = lsGet(WLVAL_KEY, {});
    var dirty = false;
    await Promise.all(rows.map(async function (r) {
      if (r.val && r.val.fresh) return;
      var v = await fetchWlValuation(r.item.ticker);
      if (v) {
        vmap[r.item.ticker] = { score: v.score, verdict: v.verdict, at: Date.now() };
        r.val = { score: v.score, verdict: v.verdict, fresh: true };
        dirty = true;
      }
    }));
    if (dirty) lsSet(WLVAL_KEY, vmap);
  }
  var mode = getWlSort();
  rows.sort(function (a, b) {
    if (mode === 'valuation') {
      var sa = a.val ? a.val.score : -1, sb = b.val ? b.val.score : -1;
      return sb - sa;
    }
    if (mode === 'target') {
      var da = (isNum(a.price) && isNum(a.item.target) && a.item.target > 0) ? (a.price / a.item.target - 1) : Infinity;
      var db = (isNum(b.price) && isNum(b.item.target) && b.item.target > 0) ? (b.price / b.item.target - 1) : Infinity;
      return da - db;
    }
    if (mode === 'ticker') return a.item.ticker.localeCompare(b.item.ticker);
    return (a.item.addedAt || 0) - (b.item.addedAt || 0);
  });
  var html = '';
  rows.forEach(function (r) {
    var item = r.item, price = r.price;
    var distHtml = '<span class="pill far">no target set</span>';
    if (isNum(price) && isNum(item.target) && item.target > 0) {
      var above = (price / item.target - 1) * 100;
      if (price <= item.target) distHtml = '<span class="pill hit">\u2713 AT / BELOW TARGET</span>';
      else if (above <= 10) distHtml = '<span class="pill near">' + fmtNum(above, 1) + '% above target</span>';
      else distHtml = '<span class="pill far">' + fmtNum(above, 1) + '% above target</span>';
    }
    html += '<div class="wl-row"><div><span class="wl-t">' + esc(item.ticker) + '</span>' +
      '<div class="wl-meta">Target buy: ' + (isNum(item.target) ? fmtMoney(item.target) : '\u2014') + '</div>' +
      (r.val ? '<div class="wl-meta wl-val">Valuation <b>' + r.val.score + '</b> \u00b7 ' + esc(r.val.verdict) + '</div>' : '') +
      '</div>' +
      '<div><div class="wl-price">' + (isNum(price) ? fmtMoney(price) : '\u2014') + '</div>' +
      '<div style="text-align:right">' + (r.err ? '<span class="factor-note">price unavailable</span>' : distHtml) + '</div>' +
      '<div class="wl-actions"><button class="link-btn" data-research="' + esc(item.ticker) + '">Research</button>' +
      '<button class="link-btn" data-wl-edit="' + esc(item.ticker) + '">Edit target</button>' +
      '<button class="link-btn danger" data-wl-del="' + esc(item.ticker) + '">Remove</button></div></div></div>';
  });
  $('wl-status').textContent = '';
  box.innerHTML = html;
  box.querySelectorAll('[data-research]').forEach(function (b) {
    b.addEventListener('click', function () { switchTab('scorecard'); $('search-input').value = b.getAttribute('data-research'); runSearch(b.getAttribute('data-research')); });
  });
  box.querySelectorAll('[data-wl-del]').forEach(function (b) {
    b.addEventListener('click', function () {
      setWatchlist(getWatchlist().filter(function (x) { return x.ticker !== b.getAttribute('data-wl-del'); }));
      renderWatchlist(false);
    });
  });
  box.querySelectorAll('[data-wl-edit]').forEach(function (b) {
    b.addEventListener('click', function () {
      var T = b.getAttribute('data-wl-edit');
      var cur = getWatchlist().filter(function (x) { return x.ticker === T; })[0];
      var v = window.prompt('Target buy price for ' + T + ' ($):', cur && isNum(cur.target) ? cur.target : '');
      if (v === null) return;
      var n = parseFloat(v);
      var wl2 = getWatchlist();
      wl2.forEach(function (x) { if (x.ticker === T) x.target = isNum(n) ? n : null; });
      setWatchlist(wl2);
      renderWatchlist(false);
    });
  });
}


/* ============================== journal ============================== */
var J_KEY = 'sr_journal_v1';
function getJournal() { return lsGet(J_KEY, {}); }
function setJournal(j) { lsSet(J_KEY, j); }
var editingTicker = null;
function startJournalEdit(T) {
  var j = getJournal();
  var e = j[T] || {};
  editingTicker = T;
  $('journal-editor-title').textContent = 'Entry — ' + T;
  $('j-ticker').value = T;
  $('j-ticker').readOnly = true;
  $('j-thesis').value = e.thesis || '';
  $('j-catalysts').value = e.catalysts || '';
  $('j-bull').value = e.bull || '';
  $('j-base').value = e.base || '';
  $('j-bear').value = e.bear || '';
  $('j-review').value = e.review || '';
  $('j-cancel').hidden = false;
  $('journal-editor-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function resetJournalForm() {
  editingTicker = null;
  $('journal-editor-title').textContent = 'New entry';
  $('j-ticker').readOnly = false;
  $('j-cancel').hidden = true;
  $('journal-form').reset();
}
function renderJournal() {
  var j = getJournal();
  var tickers = Object.keys(j).sort();
  var box = $('journal-list');
  if (!tickers.length) {
    box.innerHTML = '<div class="empty-note"><h2>No journal entries yet</h2><p>Write down your thesis before you buy — future you will want to know what past you was thinking. Entries live only on this device.</p></div>';
    return;
  }
  var html = '';
  tickers.forEach(function (T) {
    var e = j[T];
    html += '<div class="j-row"><h4>' + esc(T) + '</h4><div class="j-meta">' +
      (e.review ? 'Review by ' + esc(e.review) + ' · ' : '') + 'Updated ' + new Date(e.updatedAt || Date.now()).toLocaleDateString() + '</div>';
    if (e.thesis) html += '<p><span class="j-lab">Thesis</span><br>' + esc(e.thesis) + '</p>';
    if (e.catalysts) html += '<p><span class="j-lab">Catalysts</span><br>' + esc(e.catalysts) + '</p>';
    if (e.bull) html += '<p><span class="j-lab">Bull</span><br>' + esc(e.bull) + '</p>';
    if (e.base) html += '<p><span class="j-lab">Base</span><br>' + esc(e.base) + '</p>';
    if (e.bear) html += '<p><span class="j-lab">Bear</span><br>' + esc(e.bear) + '</p>';
    html += '<div><button class="link-btn" data-research="' + esc(T) + '">Research</button>' +
      '<button class="link-btn" data-j-edit="' + esc(T) + '">Edit</button>' +
      '<button class="link-btn danger" data-j-del="' + esc(T) + '">Delete</button></div></div>';
  });
  box.innerHTML = html;
  box.querySelectorAll('[data-research]').forEach(function (b) {
    b.addEventListener('click', function () { switchTab('scorecard'); $('search-input').value = b.getAttribute('data-research'); runSearch(b.getAttribute('data-research')); });
  });
  box.querySelectorAll('[data-j-edit]').forEach(function (b) {
    b.addEventListener('click', function () { startJournalEdit(b.getAttribute('data-j-edit')); });
  });
  box.querySelectorAll('[data-j-del]').forEach(function (b) {
    b.addEventListener('click', function () {
      var j2 = getJournal();
      delete j2[b.getAttribute('data-j-del')];
      setJournal(j2);
      renderJournal();
    });
  });
}

/* ============================== glossary ============================== */
var GLOSSARY = [
  ['P/E ratio', 'Price divided by earnings per share. What you pay for $1 of yearly profit. 20× means $20 per $1 of earnings.'],
  ['Forward P/E', 'Price divided by next year\'s expected earnings per share. Uses analyst estimates, so it\'s a guess about the future — cheaper-looking, but the estimate can be wrong.'],
  ['PEG ratio', 'P/E divided by the expected earnings growth rate. Tries to answer "am I overpaying for this growth?" Under 1 is traditionally "fair", under 0.5 is unusually cheap — or a warning that growth is about to fall off a cliff.'],
  ['Market cap', 'Share price × shares outstanding. The total price tag on the whole company. Your screen only looks at companies over $5B (large enough to be established).'],
  ['52-week high', 'The highest price in the last year. A stock 30% below it is on sale relative to recent sentiment — or something broke. Your screen wants 25%+ below, then the research decides which.'],
  ['EPS (earnings per share)', 'Company profit divided by shares. The single number most valuation math is built on. "TTM" = trailing twelve months (actual past). "Consensus" = the average of analyst estimates (guessed future).'],
  ['Earnings cliff', 'When a cyclical company\'s earnings peak, then fall hard — memory chips, miners, commodities. The stock looks cheapest (lowest P/E) exactly at the peak, right before earnings collapse. The most common value trap there is.'],
  ['Gross margin', 'Revenue minus the direct cost of what was sold, as a % of revenue. High gross margin usually means pricing power — customers can\'t easily go elsewhere.'],
  ['Operating margin', 'Profit from the core business (after running costs, before interest and tax) as a % of revenue. Shows whether the business itself makes money.'],
  ['Profit margin', 'Final net profit as a % of revenue. What\'s left for shareholders after everything.'],
  ['Debt / Equity', 'Total debt divided by shareholder equity. Above ~2 means the company leans heavily on borrowed money — fine in good times, dangerous in bad ones.'],
  ['ROE (return on equity)', 'Profit divided by shareholder equity. How hard the owners\' money is working. Consistently above 15% is strong.'],
  ['Free cash flow', 'Cash left after running the business and maintaining it. The hardest number to fake — earnings are an opinion, cash is a fact.'],
  ['Beta', 'How much a stock moves versus the market. Beta 2 = roughly twice the market\'s swings, both ways. High beta + small position size, or hold on tight.'],
  ['Moat', 'A durable advantage that keeps competitors from eating the business — brand, network effects, patents, switching costs. Wide moat = pricing power that lasts.'],
  ['CAGR', 'Compound annual growth rate: the smooth yearly rate that gets you from start to finish. Used for earnings growth assumptions and investment returns.'],
  ['Dividend yield', 'Yearly dividends divided by price. A 3% yield pays you 3% of your money back each year, before any price movement.'],
  ['Analyst target', 'The average price analysts expect within ~12 months. Treat as a sentiment gauge, not a promise — targets chase prices as often as they predict them.'],
  ['TTM (trailing twelve months)', 'The last four reported quarters added together. TTM numbers are actual results, not estimates — but they blend old and new quarters, so they react slowly when a business speeds up or slows down.'],
  ['YoY (year over year)', 'This quarter (or year) compared with the same one a year earlier. The standard way growth is quoted, because it cancels out seasonal patterns like holiday sales.'],
  ['Consensus estimate', 'The average of all analysts\' forecasts for a number like EPS or revenue. It is the bar a company has to clear on earnings day — the stock often moves on whether the report beat or missed this, not on the raw number.'],
  ['Earnings surprise', 'Reported EPS minus the consensus estimate, usually as a %. Positive = a "beat", negative = a "miss". The app\'s miss and beat rates count how often each happened over the last several quarters.'],
  ['Adjusted (non-GAAP) EPS', 'Earnings with one-time items (lawsuits, restructuring, big write-downs) stripped out. This is the EPS analysts estimate and headlines quote. GAAP EPS follows the strict accounting rules and can look very different in a messy quarter.'],
  ['Guidance', 'The company\'s own forecast for the coming quarter or year, given by management. Stocks often move more on guidance than on the results just reported — the market trades the future, not the past.'],
  ['Fiscal year', 'A company\'s own 12-month reporting calendar. It often matches the calendar year, but not always — Walmart\'s fiscal 2026 ends in January 2026, for example. The FY labels in the Projection Builder refer to it.'],
  ['Cyclical', 'A business whose earnings rise and fall with an economic cycle — memory chips, steel, airlines, hotels. Cyclicals look cheapest at peak earnings, which is exactly when they are most dangerous.'],
  ['Value trap', 'A stock that looks cheap (low P/E, big drop from its high) because the business or its earnings are about to get worse. The discount is the market being right, not wrong.'],
  ['Margin of safety', 'The gap between what you pay and what you think a stock is worth. The wider it is, the more wrong you can afford to be. Your value screen hunts for it; it does not guarantee it.'],
  ['SWOT analysis', 'A four-box check of a business. Strengths and Weaknesses are INTERNAL — what the company itself excels at or falls short on: a strong brand, a loyal customer base, a strong balance sheet, unique technology; or high debt, a weak supply chain, a lack of capital. Opportunities and Threats are EXTERNAL — outside factors that could help or harm: a country cutting tariffs opens a new market (opportunity); rising material costs, tougher competition or tight labor supply squeeze the business (threats).'],
  ['Exit P/E (exit multiple)', 'The P/E you assume the market will pay for a stock when you sell it in the future. The Projection Builder multiplies future EPS by this to get the implied price — small changes here swing the answer a lot.'],
  ['Bear / Base / Bull case', 'Three versions of the same forecast: pessimistic, most likely, optimistic. In the Projection Builder they are your EPS path with growth shifted down 5 points, as-is, and up 5 points (plus a small exit P/E adjustment).'],
  ['Implied price', 'The future price a projection works out to: future EPS × exit P/E. It is an "if these assumptions hold" number, not a prediction.'],
  ['Enterprise value', 'Market cap plus total debt minus cash. The cost of buying the whole business outright, debts and all. Better than market cap for comparing companies with very different borrowing.'],
  ['Buyback', 'When a company repurchases its own shares. Fewer shares means each remaining share owns a bigger slice of the profit, so EPS rises even if total profit doesn\'t.'],
  ['Dilution', 'The opposite of a buyback: the company issues more shares (often to pay employees in stock), so each share owns a smaller slice. Profit can grow while EPS shrinks.'],
  ['Drawdown', 'The fall from a peak. A stock 43.6% below its 52-week high is in a 43.6% drawdown from that high — deep enough to be opportunity or warning, which is what the research is for.']
];
function renderGlossary(filter) {
  var f = (filter || '').toLowerCase();
  var html = '';
  GLOSSARY.forEach(function (g) {
    if (f && g[0].toLowerCase().indexOf(f) === -1 && g[1].toLowerCase().indexOf(f) === -1) return;
    html += '<div class="g-item"><div class="g-term">' + esc(g[0]) + '</div><div class="g-def">' + esc(g[1]) + '</div></div>';
  });
  $('gloss-list').innerHTML = html || '<p class="fineprint">No terms match that search.</p>';
}

/* ============================== data backup ============================== */
function collectBackup() {
  return { app: 'stock-research', version: 1, exportedAt: new Date().toISOString(),
           watchlist: getWatchlist(), journal: getJournal(), aiSwots: lsGet(AI_SWOT_KEY, {}) };
}
function doExport() {
  var json = JSON.stringify(collectBackup(), null, 2);
  $('backup-text').value = json;
  var status = $('backup-status');
  status.className = 'status';
  try {
    var blob = new Blob([json], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'stock-research-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    status.textContent = 'Backup downloaded — it is also in the box below, in case you would rather copy it as text.';
  } catch (e) {
    status.textContent = 'Your backup is in the box below — select it and copy it somewhere safe.';
  }
}
function importBackupText(text) {
  var status = $('backup-status');
  var obj;
  try { obj = JSON.parse(String(text || '')); } catch (e) {
    status.className = 'status err'; status.textContent = 'That does not look like a backup (could not read it).'; return;
  }
  var wl = obj && Array.isArray(obj.watchlist) ? obj.watchlist : null;
  var j = obj && obj.journal && typeof obj.journal === 'object' && !Array.isArray(obj.journal) ? obj.journal : null;
  var ai = obj && obj.aiSwots && typeof obj.aiSwots === 'object' && !Array.isArray(obj.aiSwots) ? obj.aiSwots : null;
  if (!wl && !j && !ai) {
    status.className = 'status err';
    status.textContent = 'That file has no watchlist, journal or AI SWOTs in it — not a Stock Research backup.';
    return;
  }
  if (!window.confirm('Replace your current watchlist, journal and saved AI SWOTs with this backup?')) return;
  if (wl) setWatchlist(wl);
  if (j) setJournal(j);
  if (ai) lsSet(AI_SWOT_KEY, ai);
  renderWatchlist(false);
  renderJournal();
  if (lastStock) renderScorecard(lastStock);
  status.className = 'status';
  status.textContent = 'Backup restored: ' + (wl ? wl.length : 0) + ' watchlist item(s), ' + (j ? Object.keys(j).length : 0) + ' journal entr(ies)' + (ai ? ', ' + Object.keys(ai).length + ' AI SWOT(s)' : '') + '.';
}

/* ============================== theme & settings ============================== */
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('sr_theme', t); } catch (e) {}
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#0d0d0f' : '#ffffff');
  var dBtn = $('theme-dark'), lBtn = $('theme-light');
  if (dBtn && lBtn) {
    dBtn.classList.toggle('active', t === 'dark');
    lBtn.classList.toggle('active', t === 'light');
  }
}

/* ============================== tabs & init ============================== */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function (s) { s.classList.toggle('active', s.id === 'tab-' + name); });
  document.querySelectorAll('.tabbar button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === name); });
  window.scrollTo(0, 0);
}
function initApp() {
  document.querySelectorAll('.tabbar button').forEach(function (b) {
    b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
  });
  $('search-form').addEventListener('submit', function (e) {
    e.preventDefault();
    runSearch($('search-input').value);
    $('search-input').blur();
  });
  $('compare-form').addEventListener('submit', function (e) { e.preventDefault(); runCompare(); });
  $('pj-run').addEventListener('click', runProjection);
  $('pj-path').addEventListener('change', onPjPathEdit);
  $('pj-years').addEventListener('change', function () { renderPjPath(); });
  $('pj-growth').addEventListener('change', function () { if (!pjPathFromForecast) pjSynthPath(); renderPjPath(); });
  $('pj-eps').addEventListener('change', function () { if (!pjPathFromForecast) pjSynthPath(); renderPjPath(); });
  renderPjPath();
  $('pj-load-form').addEventListener('submit', function (e) {
    e.preventDefault();
    loadProjectionTicker();
    $('pj-ticker').blur();
  });
  $('cc-run').addEventListener('click', runCompound);
  runCompound();
  $('wl-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var t = $('wl-ticker').value, target = parseFloat($('wl-target').value);
    if (!t.trim()) return;
    addToWatchlist(t, isNum(target) ? target : null);
    $('wl-ticker').value = ''; $('wl-target').value = '';
  });
  $('wl-refresh').addEventListener('click', function () { renderWatchlist(true); });
  var wlSortSel = $('wl-sort');
  if (wlSortSel) {
    wlSortSel.value = getWlSort();
    wlSortSel.addEventListener('change', function () {
      try { localStorage.setItem(WLSORT_KEY, wlSortSel.value); } catch (e) {}
      renderWatchlist(false);
    });
  }
  $('btn-export').addEventListener('click', doExport);
  $('btn-import').addEventListener('click', function () { $('import-file').click(); });
  $('import-file').addEventListener('change', function () {
    var f = $('import-file').files && $('import-file').files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () { importBackupText(String(r.result || '')); };
    r.readAsText(f);
    $('import-file').value = '';
  });
  $('btn-import-text').addEventListener('click', function () { importBackupText($('backup-text').value); });
  // Settings menu + theme (dark is the default).
  var savedTheme = null;
  try { savedTheme = localStorage.getItem('sr_theme'); } catch (e) {}
  applyTheme(savedTheme === 'light' ? 'light' : 'dark');
  $('theme-dark').addEventListener('click', function () { applyTheme('dark'); });
  $('theme-light').addEventListener('click', function () { applyTheme('light'); });
  var settingsMenu = $('settings-menu');
  $('btn-settings').addEventListener('click', function (e) {
    e.stopPropagation();
    var willOpen = settingsMenu.hidden;
    settingsMenu.hidden = !willOpen;
    $('btn-settings').setAttribute('aria-expanded', String(willOpen));
  });
  document.addEventListener('click', function (e) {
    if (!settingsMenu.hidden && !settingsMenu.contains(e.target)) {
      settingsMenu.hidden = true;
      $('btn-settings').setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      settingsMenu.hidden = true;
      $('btn-settings').setAttribute('aria-expanded', 'false');
    }
  });
  $('set-clear-ai').addEventListener('click', function () {
    try { localStorage.removeItem(AI_SWOT_KEY); } catch (e) {}
    $('settings-note').textContent = 'Saved AI SWOTs cleared — regenerate any of them from a scorecard.';
    if (lastStock) renderScorecard(lastStock);
  });
  $('set-clear-cache').addEventListener('click', function () {
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
    $('settings-note').textContent = 'Price cache cleared — the next lookups fetch fresh data.';
  });
  $('set-reload').addEventListener('click', function () { location.reload(); });
  $('journal-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var T = ($('j-ticker').value || '').trim().toUpperCase();
    if (!T) return;
    var j = getJournal();
    j[T] = {
      thesis: $('j-thesis').value.trim(), catalysts: $('j-catalysts').value.trim(),
      bull: $('j-bull').value.trim(), base: $('j-base').value.trim(), bear: $('j-bear').value.trim(),
      review: $('j-review').value || '', updatedAt: Date.now()
    };
    setJournal(j);
    resetJournalForm();
    renderJournal();
  });
  $('j-cancel').addEventListener('click', resetJournalForm);
  $('gloss-search').addEventListener('input', function (e) { renderGlossary(e.target.value); });
  renderGlossary('');
  renderJournal();
  renderWatchlist(true);
}
if (typeof document !== 'undefined' && document.getElementById) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
  else initApp();
}
/* Node export for offline pipeline tests (ignored in the browser). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseFinviz: parseFinviz, scoreStock: scoreStock, valueScreen: valueScreen, epsTrajectory: epsTrajectory, parseNum: parseNum, parseCapStr: parseCapStr, fetchStock: fetchStock, relayFetch: relayFetch, relayJSON: relayJSON, fillProjection: fillProjection, pjGrowths: pjGrowths, pjCaseEps: pjCaseEps, parseMBEarnings: parseMBEarnings, epsRecordStats: epsRecordStats, parseRevStr: parseRevStr, buildSwot: buildSwot };
}
