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
/* Compact form for huge finite values (2026-11-07): toLocaleString
 * on something like 5.3e39 prints all 40 digits and blows out the
 * layout (Justin's compound-calculator screenshot: a 1,000,000%
 * return typed in by hand). The compact branches only engage at a
 * trillion or beyond — past any per-share price, portfolio total
 * or return the app legitimately shows — so real data is untouched. */
function fmtHugeAbs(a) {
  if (a >= 1e18) {
    var e = Math.floor(Math.log10(a));
    return (a / Math.pow(10, e)).toFixed(2) + 'e' + e;
  }
  if (a >= 1e15) return (a / 1e15).toFixed(2) + 'Q';
  return (a / 1e12).toFixed(2) + 'T';
}

function fmtMoney(n, dec) {
  if (!isNum(n)) return '—';
  if (Math.abs(n) >= 1e12) return '$' + (n < 0 ? '-' : '') + fmtHugeAbs(Math.abs(n));
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: dec == null ? 2 : dec, maximumFractionDigits: dec == null ? 2 : dec });
}
function fmtNum(n, dec) {
  if (!isNum(n)) return '—';
  if (Math.abs(n) >= 1e12) return (n < 0 ? '-' : '') + fmtHugeAbs(Math.abs(n));
  return n.toLocaleString('en-US', { minimumFractionDigits: dec == null ? 2 : dec, maximumFractionDigits: dec == null ? 2 : dec });
}
function fmtPct(n, dec) {
  if (!isNum(n)) return '—';
  var a = Math.abs(n);
  if (a >= 1e12) return (n > 0 ? '+' : '-') + fmtHugeAbs(a) + '%';
  if (a >= 1e6) return (n > 0 ? '+' : '-') + (a / 1e6).toFixed(2) + 'M%';
  return (n > 0 ? '+' : '') + n.toFixed(dec == null ? 1 : dec) + '%';
}
function fmtCap(n) { // dollars -> $969.1B
  if (!isNum(n)) return '—';
  if (n >= 1e15) return '$' + fmtHugeAbs(n);
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
  function (u) { return 'https://api.cors.lol/?url=' + encodeURIComponent(u); }
  /* codetabs and corsproxy.io were dropped 2026-11-10: codetabs
   * returned origin-error 522s after ~20 s on every probe, and
   * corsproxy.io sits behind a 401 auth wall -- both were dead weight
   * in the race, stretching every failure out to the full timeout. */
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
/* Next-earnings date from the Finviz snapshot's Earnings cell
 * ("Nov 02 AMC" / "Jan 29 BMO"): month + day + timing, no year. Year =
 * this year, rolling to next when the date is over a week past (a
 * just-reported date inside the week stays, so the UI can say so). */
var EARN_MONS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function earnIso(dt) {
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}
function earnAddMonths(dt, n) {
  var target = new Date(dt.getFullYear(), dt.getMonth() + n, 1);
  var last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(dt.getDate(), last));
}
/* The Finviz Earnings cell ("Oct 15 BMO") carries no year, and right
 * after a report it often still shows the quarter just reported.
 * Companies report every quarter, so (Justin's ruling, 2026-11-07):
 * a cell date in the future — or within the past week, i.e. the
 * report that just landed — is the real date (est=false). A cell
 * date further past is stale: roll it forward one quarter at a
 * time until it is upcoming and mark it estimated (est=true). The
 * old code rolled a full YEAR, which put SCHW's next earnings at
 * Oct 15, 2027 instead of the January 2027 quarter. */
function earnDateFromFinviz(str, now) {
  if (!str) return null;
  var m = String(str).match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:\s+(AMC|BMO))?/);
  if (!m || !(m[1] in EARN_MONS)) return null;
  now = now || new Date();
  var day = parseInt(m[2], 10);
  var dt = new Date(now.getFullYear(), EARN_MONS[m[1]], day);
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if ((dt - today) / 864e5 >= -7) return { iso: earnIso(dt), timing: m[3] || null, est: false };
  var guard = 0;
  while (dt < today && guard++ < 8) dt = earnAddMonths(dt, 3);
  /* 1-3 quarter-rolls = we projected the cadence past a stale cell
   * (estimated). 4 rolls lands exactly on next year's same date:
   * that is the cell pointing at next year's quarter — the normal
   * forward state for e.g. a January reporter read in November —
   * so the date is the source's own, not our estimate. */
  return { iso: earnIso(dt), timing: m[3] || null, est: guard < 4 };
}
/* The "next earnings" line for the stock pages (Apple-Stocks style):
 * gold and explicit when the report lands today. */
/* Recompute the earnings date from the raw Finviz cell on every
 * render (2026-11-07): records cached by older builds carry the old
 * +1-year roll (SCHW sat at Oct 15, 2027 with no est flag, so the
 * line printed both inside More and outside it, looking doubled).
 * Recomputing from the cell — or, for legacy records, from the
 * stored date's own month/day — repairs them in place. Idempotent. */
var EARN_MON_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function earnRefresh(d) {
  if (!d) return;
  var str = d.earnCell || null;
  if (!str && d.earnNext) {
    var p = String(d.earnNext).split('-');
    if (p.length === 3) str = EARN_MON_NAMES[parseInt(p[1], 10) - 1] + ' ' + parseInt(p[2], 10) + (d.earnTiming ? ' ' + d.earnTiming : '');
  }
  if (!str) return;
  var e = earnDateFromFinviz(str);
  if (e) { d.earnNext = e.iso; d.earnTiming = e.timing; d.earnEst = e.est; }
}
function earnLineHtml(d) {
  earnRefresh(d);
  if (!d.earnNext) return '';
  var dt = new Date(d.earnNext + 'T12:00:00');
  if (isNaN(dt)) return '';
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var diff = Math.round((new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()) - today) / 864e5);
  var MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var md = MONS[dt.getMonth()] + ' ' + dt.getDate();
  var full = DAYS[dt.getDay()] + ', ' + md + ', ' + dt.getFullYear();
  var tim = d.earnTiming === 'AMC' ? ' \u00b7 after close' : d.earnTiming === 'BMO' ? ' \u00b7 before the open' : '';
  var txt, cls = 'earn-line';
  if (d.earnEst) {
    if (diff === 0) txt = 'Earnings expected today \u00b7 ' + md + tim;
    else if (diff === 1) txt = 'Earnings expected tomorrow \u00b7 ' + md + tim;
    else txt = 'Next earnings (est.) \u00b7 ' + full + (diff <= 21 ? ' \u00b7 in ' + diff + ' days' : '') + tim;
  }
  else if (diff === 0) { txt = 'Earnings today \u00b7 ' + md + tim; cls += ' today'; }
  else if (diff === 1) txt = 'Earnings tomorrow \u00b7 ' + md + tim;
  else if (diff > 1) txt = 'Next earnings \u00b7 ' + full + (diff <= 21 ? ' \u00b7 in ' + diff + ' days' : '') + tim;
  else if (diff === -1) txt = 'Earnings yesterday \u00b7 ' + md + tim;
  else txt = 'Last earnings \u00b7 ' + full;
  return '<div class="' + cls + '">' + esc(txt) + '</div>';
}
function fillFromFinviz(d, fvHtml) {
  var p = parseFinviz(fvHtml);
  if (!p['Price'] && !p['Market Cap']) throw new Error('no snapshot');
  d.sourceFinviz = p;
  d.name = d.name || null;
  d.price = parseNum(p['Price']);
  d.marketCap = parseCapStr(p['Market Cap']);
  d.pe = parseNum(p['P/E']);
  d.forwardPE = parseNum(p['Forward P/E']);
  if (isNum(d.forwardPE)) d.forwardPECalc = false;
  d.peg = parseNum(p['PEG']);
  if (isNum(d.peg)) d.pegCalc = false;
  d.ps = parseNum(p['P/S']);
  d.pb = parseNum(p['P/B']);
  d.pfcf = parseNum(p['P/FCF']);
  d.epsTTM = parseNum(p['EPS (ttm)']);
  d.epsNextY = parseNum(p['EPS next Y']);
  d.epsThisY = parseNum(p['EPS this Y']);
  var g5 = p['EPS next 5Y'] || '';
  d.epsGrowth5Y = parseNum(g5);
  d.epsGrowthTTM = parseNum(p['EPS Y/Y TTM']);
  d.salesGrowthTTM = parseNum(p['Sales Y/Y TTM']);
  d.grossMargin = parseNum(p['Gross Margin']);
  d.operMargin = parseNum(p['Oper. Margin']);
  d.profitMargin = parseNum(p['Profit Margin']);
  d.debtEq = parseNum(p['Debt/Eq']);
  d.beta = parseNum(p['Beta']);
  d.currentRatio = parseNum(p['Current Ratio']);
  d.roe = parseNum(p['ROE']);
  // Finviz renamed "Dividend %" away: the yield now rides in parens in
  // "Dividend TTM" / "Dividend Est." — e.g. "2.10 (2.27%)". "-" when the
  // stock pays no dividend.
  var divRaw = p['Dividend TTM'] || p['Dividend Est.'] || '';
  var divM = divRaw.match(/\(([\d.]+)%\)/);
  if (divM) d.divYield = parseFloat(divM[1]);
  else if (isNum(parseNum(p['Dividend %']))) d.divYield = parseNum(p['Dividend %']);
  // The number before the parens in "Dividend TTM"/"Dividend Est." is
  // the annual cash dividend per share ("1.06 (0.31%)" -> $1.06).
  var divCashM = divRaw.match(/([\d.]+)\s*\(/);
  if (divCashM) d.divCash = parseFloat(divCashM[1]);
  // Ownership, payout and analyst target ride the same snapshot table
  // (keys verified against a live AAPL page, 2026-10-30).
  d.insiderOwn = parseNum(p['Insider Own']);
  d.instOwn = parseNum(p['Inst Own']);
  d.payout = parseNum(p['Payout']);
  d.targetPrice = parseNum(p['Target Price']);
  var exDiv = p['Dividend Ex-Date'];
  d.exDivDate = (exDiv && exDiv !== '-') ? exDiv : null;
  var earn = earnDateFromFinviz(p['Earnings']);
  if (p['Earnings']) d.earnCell = p['Earnings'];
  if (earn) { d.earnNext = earn.iso; d.earnTiming = earn.timing; d.earnEst = earn.est; }
  // Insider transactions table: rows classed fv-insider-row follow the
  // "Insider Trading" heading; 9 cells per row (name, relationship,
  // date, transaction, cost, #shares, value $, #shares total, SEC).
  try {
    var itIdx = fvHtml.indexOf('Insider Trading');
    if (itIdx !== -1) {
      var itSeg = fvHtml.slice(itIdx, itIdx + 40000);
      var itRows = [], itRe = /<tr class="fv-insider-row[^"]*"[^>]*>([\s\S]*?)<\/tr>/g, itM;
      while ((itM = itRe.exec(itSeg)) !== null && itRows.length < 8) {
        var itCells = [], tdRe2 = /<td[^>]*>([\s\S]*?)<\/td>/g, tdM2;
        while ((tdM2 = tdRe2.exec(itM[1])) !== null) itCells.push(stripTags(tdM2[1]));
        if (itCells.length >= 7 && itCells[0]) {
          itRows.push({ name: itCells[0], rel: itCells[1], date: itCells[2], type: itCells[3],
            shares: parseNum(itCells[5]), value: parseNum(itCells[6]) });
        }
      }
      if (itRows.length) d.insiderTx = itRows;
    }
  } catch (e) { /* insider table is a bonus — never break the snapshot */ }
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
  // --- StockAnalysis forecast page: annual revenue, actual + estimated,
  // --- by fiscal year. Feeds the boom-bust risk factor. ---
  var srcRevPath = async function () { try {
    var html = await relayFetch('https://stockanalysis.com/stocks/' + encodeURIComponent(T) + '/forecast/', {
      timeout: 20000,
      validate: function (t) { return t.indexOf('Fiscal Year') !== -1 && t.indexOf('Revenue') !== -1; }
    });
    var rp = parseSAForecast(html);
    if (rp.length >= 3) { d.revPath = rp; d.sources.push('StockAnalysis'); }
  } catch (e) { d.errors.push('Revenue path: ' + e.message); } };

  // --- StockAnalysis annual statements: yearly EPS + margins for
  // --- the cyclical severity overlay (day-cached via cycLoadYearly,
  // --- shared with the scan enrichment and the watchlist).
  /* --- Business model: 10-K segment revenue split + the Worker's
   * plain-English one-liner (shared KV cache there, 7-day local
   * cache here). --- */
  var srcBiz = async function () { try {
    var seg = await fetchSegmentsApp(T);
    if (seg) d.bizSegs = segShares(seg);
    var cache = lsGet(BIZ_KEY, {});
    var hit = cache[T];
    if (hit && hit.line && (Date.now() - hit.ts) < 7 * 864e5) { d.bizLine = hit.line; return; }
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 60000) : null;
    var resp = await fetch(BIZ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker: T,
        name: d.companyName || T,
        industry: d.industry || '',
        about: d.about || '',
        segments: (d.bizSegs || []).map(function (sg) { return { name: sg.name, pct: sg.pct }; })
      }),
      signal: ctrl ? ctrl.signal : undefined
    });
    if (timer) clearTimeout(timer);
    var data = await resp.json();
    if (resp.ok && data && data.line) {
      d.bizLine = data.line;
      cache[T] = { line: data.line, ts: Date.now() };
      lsSet(BIZ_KEY, cache);
    }
  } catch (e) { d.errors.push('Biz: ' + e.message); } };

  var srcYearly = async function () { try {
    var cycData = await cycLoadYearly(T);
    if (cycData) {
      d.yearly = cycData.yearly;
      if (!d.revPath && cycData.revPath) d.revPath = cycData.revPath;
      if (cycData.bs) {
        d.bsCash = cycData.bs.cash;
        d.bsDebt = cycData.bs.debt;
        d.bsNet = cycData.bs.net;
        d.bsPeriod = cycData.bs.period;
      }
      d.sources.push('StockAnalysis');
    }
  } catch (e) { d.errors.push('Yearly statements: ' + e.message); } };

  // --- StockAnalysis main page: the "About" company description ---
  var srcAbout = async function () { try {
    var html = await relayFetch('https://stockanalysis.com/stocks/' + encodeURIComponent(T) + '/', {
      timeout: 20000,
      validate: function (t) { return t.indexOf('About ' + T + '</h2>') !== -1; }
    });
    var about = parseSAAbout(html);
    if (about) { d.about = about; d.sources.push('StockAnalysis'); }
  } catch (e) { d.errors.push('About: ' + e.message); } };

  // --- StockAnalysis company profile + Wikipedia: CEO, tenure, background ---
  var srcCeo = async function () { try {
    var html = await relayFetch('https://stockanalysis.com/stocks/' + encodeURIComponent(T) + '/company/', {
      timeout: 20000,
      validate: function (t) { return t.indexOf('>CEO</td>') !== -1 || t.indexOf('Chief Executive Officer') !== -1; }
    });
    var name = parseSACeo(html);
    if (!name) return;
    d.ceo = name;
    var fmatch = String(html).match(/>Founded<\/td>\s*<td[^>]*>(\d{4})</);
    var foundedYear = fmatch ? parseInt(fmatch[1], 10) : null;
    var key = T + '|' + name;

    /* The full tenure hunt: Wikipedia lead (name-matched article),
     * then the company's Wikidata statement, then a strict-pattern
     * pass over the article body. Co-CEO pages ("A & B") have no
     * single person to look up, so their names stand alone. */
    var gatherFacts = async function () {
      var facts = { since: null, founder: false, bio: '', prevRole: null, prevGrowth: null };
      if (name.indexOf(' & ') !== -1) return facts;
      var queries = ceoWikiQueries(name, d.companyName || T);
      var pickedPage = null;
      for (var qi = 0; qi < queries.length; qi++) {
        try {
          var wurl = 'https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrlimit=3&prop=extracts&explaintext=1&exintro=1&redirects=1&gsrsearch=' + encodeURIComponent(queries[qi]);
          var wj = await relayFetch(wurl, { timeout: 20000, validate: function (t) { return t.indexOf('"extract"') !== -1; } });
          pickedPage = ceoPickPage(((JSON.parse(wj).query || {}).pages) || {}, name);
          if (pickedPage && pickedPage.extract) { facts = ceoFacts(pickedPage.extract, foundedYear); break; }
          pickedPage = null;
        } catch (e) { d.errors.push('CEO bio: ' + e.message); }
      }
      if (!facts.since) {
        var wd = await ceoSinceFromWikidata(d.companyName || T, name);
        if (wd) facts.since = wd;
      }
      /* The article body serves two hunts: the strict tenure pass
       * (only when the lead gave no date — some leads never date the
       * tenure while the body does; strict patterns only, every one
       * anchored to the CEO role) and the previous-experience
       * extraction, whose facts live in the career sections further
       * down. A pre-IPO start year is fine: the start-bar label
       * falls back to the first traded month. */
      var bodyExtract = '';
      if (pickedPage && pickedPage.title) {
        try {
          /* No exchars: with it set, this API returns the intro
           * only (verified live 2026-11-07 — the old exchars=6000
           * deep pass was silently re-reading the lead). Fetch the
           * full article and trim here instead. */
          var burl = 'https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&explaintext=1&redirects=1&titles=' + encodeURIComponent(pickedPage.title);
          var bj = await relayFetch(burl, { timeout: 25000, validate: function (t) { return t.indexOf('"extract"') !== -1; } });
          var bpages = ((JSON.parse(bj).query || {}).pages) || {};
          Object.keys(bpages).forEach(function (k) { if (bpages[k].extract) bodyExtract = bpages[k].extract.slice(0, 12000); });
          if (bodyExtract && !facts.since) {
            var bodyClean = ceoCleanLead(bodyExtract);
            var bs = ceoSinceFrom(bodyClean, true);
            if (bs) facts.since = bs;
            else if (foundedYear && ceoBodyFounder(bodyClean, name)) { facts.founder = true; facts.since = { y: foundedYear, m: null }; }
          }
        } catch (e) { d.errors.push('CEO deep: ' + e.message); }
      }
      var prevText = bodyExtract || (pickedPage && pickedPage.extract) || '';
      if (prevText) {
        var pv = await ceoPrevFor(name, d.companyName || T, prevText);
        if (pv) { facts.prevRole = pv.pr; facts.prevGrowth = pv.pg; }
      }
      return facts;
    };
    var applyBundle = function (b) {
      d.ceoSince = b.since; d.ceoFounder = b.founder; d.ceoBio = b.bio;
      d.ceoStartClose = b.sc; d.ceoStartLabel = b.sl; d.ceoStartTs = b.st;
      d.ceoPrevRole = b.pr; d.ceoPrevGrowth = b.pg;
    };

    var hit = ceoCacheGet(key);
    if (hit) {
      /* A bundle cached without its performance numbers (the price
       * fetch failed that day) refills them now instead of riding
       * the 30-day cache empty. */
      if (hit.since && (!isNum(hit.sc) || !isNum(hit.st))) {
        var refill = await ceoPerfFor(T, hit.since);
        if (refill) { hit.sc = refill.sc; hit.sl = refill.sl; hit.st = refill.st; ceoCacheSet(key, hit); }
      }
      /* A bundle with no start date at all (a brand-new CEO whose
       * sources had not caught up) re-runs the hunt every few days,
       * so the performance line appears once the date is published
       * anywhere — no 30-day wait. */
      if ((!hit.since || (hit.pr === undefined)) && Date.now() - (hit.ts || 0) > 3 * 86400000) {
        var facts2 = await gatherFacts();
        hit.ts = Date.now();
        if (facts2.prevRole || facts2.prevGrowth) { hit.pr = facts2.prevRole; hit.pg = facts2.prevGrowth; }
        if (facts2.since) {
          hit.since = facts2.since; hit.founder = facts2.founder;
          if (facts2.bio) hit.bio = facts2.bio;
          var perf2 = await ceoPerfFor(T, facts2.since);
          if (perf2) { hit.sc = perf2.sc; hit.sl = perf2.sl; hit.st = perf2.st; }
        }
        ceoCacheSet(key, hit);
      }
      applyBundle(hit);
      return;
    }
    var facts = await gatherFacts();
    var perf = facts.since ? await ceoPerfFor(T, facts.since) : null;
    var bundle = { since: facts.since, founder: facts.founder, bio: facts.bio, sc: perf ? perf.sc : null, sl: perf ? perf.sl : '', st: perf ? perf.st : null, pr: facts.prevRole, pg: facts.prevGrowth, ts: Date.now() };
    applyBundle(bundle);
    /* Cache only a bundle that actually found something. Caching an
     * empty result (a failed lookup) used to stick for the whole
     * 30-day TTL — that is what kept NVDA's CEO block empty. */
    if (bundle.since || bundle.bio || bundle.sc || bundle.pr) ceoCacheSet(key, bundle);
  } catch (e) { d.errors.push('CEO: ' + e.message); } };

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
        relayFetch(u, { timeout: 8000, validate: function (t) { return t.indexOf('Reported EPS') !== -1 && t.indexOf('Consensus Estimate') !== -1; } })
          .then(function (text) { if (!done) { done = true; resolve(text); } })
          .catch(function (e) { pending--; if (pending === 0 && !done) reject(e || new Error('no earnings history')); });
      });
    });
    var rows = parseMBEarnings(html);
    if (rows.length >= 4) {
      d.epsRecord = epsRecordStats(rows);
      d.epsHistQ = rows;
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
      var rawCloses = (res.indicators && res.indicators.quote && res.indicators.quote[0].close) || [];
      var rawTs = res.timestamp || [];
      var closes = [], tsArr = [];
      rawCloses.forEach(function (c, i) { if (isNum(c)) { closes.push(c); tsArr.push(rawTs[i] || null); } });
      d.history = closes;
      d.historyTs = tsArr;
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
  await Promise.all([srcFinviz(), srcSurprise(), srcRevPath(), srcAbout(), srcCeo(), srcYearly(), srcBiz()]);
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
  // EPS growth: next fiscal year vs this fiscal year (consensus,
  // fiscal-year over fiscal-year). Deliberately NOT vs trailing TTM:
  // a trailing window straddling weak reported quarters distorts the
  // base and inflates the figure (Justin's call, 2026-10-25).
  var nextFY = (d.epsForecasts && d.epsForecasts[0]) || null;
  var f1 = (d.epsForecasts && d.epsForecasts[1]) || null;
  if (nextFY && f1 && isNum(nextFY.eps) && isNum(f1.eps) && nextFY.eps > 0) {
    d.epsGrowthNextY = (f1.eps / nextFY.eps - 1) * 100;
  } else if (isNum(d.epsNextY) && isNum(d.epsThisY) && d.epsThisY > 0) {
    d.epsGrowthNextY = (d.epsNextY / d.epsThisY - 1) * 100;
  } else {
    d.epsGrowthNextY = null;
  }
  // Forward P/E fallback: price / next fiscal year's consensus EPS
  // (labelled calc.) -- the Nasdaq FY pair, same source as the EPS
  // growth factor above, so the calculated values tie out. Finviz's
  // own EPS-next-Y figure is the last resort.
  if (!isNum(d.forwardPE) && isNum(d.price)) {
    var fyEps = (f1 && isNum(f1.eps)) ? f1.eps : (nextFY ? nextFY.eps : (isNum(d.epsNextY) ? d.epsNextY : null));
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
/* The cheap-P/E trap, shared by the valuation score and the value
 * screen (so the page can never contradict itself): a single-digit
 * forward P/E on earnings that just exploded is usually peak
 * earnings, not a bargain. */
function cheapPeTrap(d) {
  return isNum(d.forwardPE) && d.forwardPE > 0 && d.forwardPE < 8 && isNum(d.epsGrowthTTM) && d.epsGrowthTTM > 200;
}

/* ====================== scoring weights ======================
 * The bands inside each factor never change — they are the
 * measuring stick. How much each factor COUNTS is the user's call:
 * scoreStock / riskScore take an optional weights argument. Omit it
 * for the user's weights; pass STD_W for the standard rubric (the
 * daily scans, the SWOT generators — anything shared or comparable
 * across users). Scores always renormalize over the weights of the
 * factors that have data, so any weight set still reads 0-100. */
var SCORE_WEIGHTS_KEY = 'sr_weights_v1';
var VAL_FACTOR_DEFS = [
  { name: 'Forward P/E', def: 25 },
  { name: 'PEG ratio', def: 20 },
  { name: 'Below 52-wk high', def: 15 },
  { name: 'EPS growth, next yr', def: 15 },
  { name: 'Profit margin', def: 10 },
  { name: 'Gross margin', def: 5 },
  { name: 'Debt / Equity', def: 10 }
];
var RISK_FACTOR_DEFS = [
  { name: 'Beta (volatility)', def: 10 },
  { name: 'Debt / Equity', def: 25 },
  { name: 'Profit margin', def: 20 },
  { name: 'Company size', def: 15 },
  { name: 'EPS trend, next yr', def: 20 },
  { name: 'Current ratio', def: 10 }
];
function stdWeights() {
  var v = {}, r = {};
  VAL_FACTOR_DEFS.forEach(function (f) { v[f.name] = f.def; });
  RISK_FACTOR_DEFS.forEach(function (f) { r[f.name] = f.def; });
  return { val: v, risk: r };
}
var STD_W = stdWeights();
var SCORE_PRESETS = {
  balanced: stdWeights(),
  deepvalue: {
    val: { 'Forward P/E': 35, 'PEG ratio': 25, 'Below 52-wk high': 20, 'EPS growth, next yr': 5, 'Profit margin': 5, 'Gross margin': 5, 'Debt / Equity': 5 },
    risk: { 'Beta (volatility)': 5, 'Debt / Equity': 30, 'Profit margin': 20, 'Company size': 10, 'EPS trend, next yr': 20, 'Current ratio': 15 }
  },
  safety: {
    val: { 'Forward P/E': 15, 'PEG ratio': 10, 'Below 52-wk high': 10, 'EPS growth, next yr': 10, 'Profit margin': 20, 'Gross margin': 10, 'Debt / Equity': 25 },
    risk: { 'Beta (volatility)': 15, 'Debt / Equity': 35, 'Profit margin': 20, 'Company size': 10, 'EPS trend, next yr': 5, 'Current ratio': 15 }
  },
  growth: {
    val: { 'Forward P/E': 10, 'PEG ratio': 20, 'Below 52-wk high': 10, 'EPS growth, next yr': 35, 'Profit margin': 10, 'Gross margin': 10, 'Debt / Equity': 5 },
    risk: { 'Beta (volatility)': 15, 'Debt / Equity': 10, 'Profit margin': 15, 'Company size': 5, 'EPS trend, next yr': 40, 'Current ratio': 15 }
  },
  /* Beta and company size switched off entirely: risk is judged
   * only on the balance sheet, profitability, earnings trend and
   * bill-paying ability (Justin's requirement, 2026-11-08). */
  fundamentals: {
    val: { 'Forward P/E': 20, 'PEG ratio': 15, 'Below 52-wk high': 10, 'EPS growth, next yr': 15, 'Profit margin': 20, 'Gross margin': 10, 'Debt / Equity': 10 },
    risk: { 'Beta (volatility)': 0, 'Debt / Equity': 40, 'Profit margin': 25, 'Company size': 0, 'EPS trend, next yr': 20, 'Current ratio': 15 }
  }
};
var SCORE_PRESET_LABELS = { balanced: 'Balanced', deepvalue: 'Deep Value', safety: 'Safety First', growth: 'Growth', fundamentals: 'Fundamentals Only' };
function getScoreWeights() {
  var stored = lsGet(SCORE_WEIGHTS_KEY, null);
  var out = stdWeights();
  if (stored) {
    ['val', 'risk'].forEach(function (side) {
      var defs = side === 'val' ? VAL_FACTOR_DEFS : RISK_FACTOR_DEFS;
      defs.forEach(function (f) {
        var v = stored[side] && stored[side][f.name];
        if (isNum(v)) out[side][f.name] = Math.max(0, Math.min(60, v));
      });
    });
  }
  return out;
}
function setScoreWeights(w) { lsSet(SCORE_WEIGHTS_KEY, w); }
function weightsAreCustom() {
  return JSON.stringify(getScoreWeights()) !== JSON.stringify(STD_W);
}
function resolveWeights(w) { return w || getScoreWeights(); }
/* Rescale built factors from the standard rubric to the given
 * weights: each factor keeps the FRACTION of its max that it
 * earned, applied to the user's max for that factor. A weight of 0
 * switches the factor off — it stays visible, counts for nothing. */
function applyWeights(factors, map) {
  if (!map) return;
  factors.forEach(function (f) {
    var w = map[f.name];
    if (w == null || w === f.max) return;
    var frac = f.max > 0 ? f.pts / f.max : 0;
    f.pts = Math.round(frac * w * 10) / 10;
    f.math += w === 0
      ? ' \u2192 switched off by your scoring weights, so it counts for nothing'
      : ' \u2192 your weights count this factor as ' + f.pts + ' of ' + w + ' pts';
    f.max = w;
  });
}

function scoreStock(d, w) {
  var factors = [];
  /* pick(): first matching band wins. 'le' tables ascend (v <= limit);
   * 'ge' tables descend (v >= limit, or v > limit on a 'gt' row).
   * Returns the points AND which band matched, so the UI can show
   * the exact math behind every factor's points. mathFor() renders
   * that band as a sentence from the same table -- the words can
   * never drift from the numbers. */
  function pick(v, bands, ge) {
    for (var i = 0; i < bands.length; i++) {
      var hit = bands[i][2] === 'gt' ? v > bands[i][0] : (ge ? v >= bands[i][0] : v <= bands[i][0]);
      if (hit) return { pts: bands[i][1], idx: i };
    }
    return { pts: bands[bands.length - 1][1], idx: bands.length - 1 };
  }
  function limFmt(x) { return String(Math.round(x * 100) / 100); }
  function mathFor(display, bands, idx, ge, max, fmtL) {
    fmtL = fmtL || limFmt;
    var L = bands[idx][0], P = idx > 0 ? bands[idx - 1][0] : null, range;
    /* Plain words, no jargon (Justin's call, 2026-11-01): users do
     * not know what a "band" is, so the math reads as a sentence. */
    if (!ge) {
      if (idx === 0) range = fmtL(L) + ' or less';
      else if (!isFinite(L)) range = 'more than ' + fmtL(P);
      else range = 'more than ' + fmtL(P) + ', up to ' + fmtL(L);
    } else {
      var excl = bands[idx][2] === 'gt', pExcl = idx > 0 && bands[idx - 1][2] === 'gt';
      if (idx === 0) range = excl ? 'more than ' + fmtL(L) : fmtL(L) + ' or more';
      else if (!isFinite(L)) range = pExcl ? fmtL(P) + ' or less' : 'under ' + fmtL(P);
      else range = (excl ? 'more than ' + fmtL(L) : fmtL(L) + ' or more') + (pExcl ? ', up to ' : ', under ') + fmtL(P);
    }
    return display + ' \u2192 ' + range + ' \u2192 ' + bands[idx][1] + ' of ' + max + ' pts';
  }
  function add(name, value, display, max, pk, note, bands, ge, fmtL) {
    factors.push({ name: name, value: value, display: display, max: max, pts: pk.pts, note: note || '', math: mathFor(display, bands, pk.idx, ge, max, fmtL) });
  }
  function pctL(x) { return limFmt(x) + '%'; }
  if (isNum(d.forwardPE) && d.forwardPE > 0) {
    var bFpe = [[6, 25], [8, 22], [10, 19], [13, 15], [18, 11], [25, 7], [35, 3], [Infinity, 0]];
    add('Forward P/E', d.forwardPE, fmtNum(d.forwardPE, 2) + (d.forwardPECalc ? ' (calc.)' : ''), 25,
      pick(d.forwardPE, bFpe, false), 'Cheaper earnings = more points', bFpe, false);
  }
  if (isNum(d.peg) && d.peg > 0) {
    var bPeg = [[0.3, 20], [0.5, 18], [0.75, 15], [1, 12], [1.5, 8], [2, 4], [Infinity, 0]];
    add('PEG ratio', d.peg, fmtNum(d.peg, 2) + (d.pegCalc ? ' (calc.)' : ''), 20,
      pick(d.peg, bPeg, false), 'Price vs growth \u2014 under 0.75 is rare air', bPeg, false);
  }
  if (isNum(d.pctBelowHigh)) {
    var bBh = [[40, 15], [30, 13], [25, 11], [15, 8], [5, 4], [-Infinity, 1]];
    add('Below 52-wk high', d.pctBelowHigh, fmtNum(d.pctBelowHigh, 1) + '%', 15,
      pick(d.pctBelowHigh, bBh, true), 'Bigger discount to the high = more points', bBh, true, pctL);
  }
  if (isNum(d.epsGrowthNextY)) {
    var bGr = [[50, 15], [25, 13], [15, 10], [8, 7], [0, 3], [-Infinity, 0]];
    add('EPS growth, next yr', d.epsGrowthNextY, fmtPct(d.epsGrowthNextY), 15,
      pick(d.epsGrowthNextY, bGr, true), 'Consensus EPS, next fiscal year vs this fiscal year', bGr, true, pctL);
  }
  if (isNum(d.profitMargin)) {
    var bPm = [[25, 10], [15, 8], [10, 6], [5, 4], [0, 2, 'gt'], [-Infinity, 0]];
    add('Profit margin', d.profitMargin, fmtNum(d.profitMargin, 1) + '%', 10,
      pick(d.profitMargin, bPm, true), 'Net margin, trailing', bPm, true, pctL);
  }
  if (isNum(d.grossMargin)) {
    var bGm = [[60, 5], [45, 4], [30, 3], [15, 1], [-Infinity, 0]];
    add('Gross margin', d.grossMargin, fmtNum(d.grossMargin, 1) + '%', 5,
      pick(d.grossMargin, bGm, true), 'Pricing power proxy', bGm, true, pctL);
  }
  if (isNum(d.debtEq)) {
    var bDe = [[0.1, 10], [0.4, 8], [0.8, 6], [1.5, 3], [3, 1], [Infinity, 0]];
    add('Debt / Equity', d.debtEq, fmtNum(d.debtEq, 2), 10,
      pick(d.debtEq, bDe, false), 'Lower leverage = more points', bDe, false);
  }
  // Cyclical overlays (Justin's spec, 2026-11-01). Cheap-P/E trap:
  // Forward P/E under 8 with TTM EPS growth over 200% means the
  // multiple is printed on peak earnings, so the Forward P/E and PEG
  // factors earn at most half their max. The trap stands on its own
  // two conditions (it is also the scan's cheap rule, applied to
  // every scanned stock); the verdict cap below stays gated on
  // severity >= 0.5.
  var cyc = cyclicalSeverity(d);
  var trap = cheapPeTrap(d);
  if (trap) {
    factors.forEach(function (f) {
      if (f.name === 'Forward P/E' || f.name === 'PEG ratio') {
        var capPts = f.max / 2;
        if (f.pts > capPts) { f.pts = capPts; f.note += ' \u2014 capped at half: cheap-P/E trap (peak earnings)'; f.math += ' \u2192 capped at half by the cheap-P/E trap (forward P/E under 8, EPS up over 200% in a year) \u2192 ' + capPts + ' pts'; }
      }
    });
  }
  applyWeights(factors, resolveWeights(w).val);
  var got = factors.reduce(function (s, f) { return s + f.pts; }, 0);
  var maxAvailable = factors.reduce(function (s, f) { return s + f.max; }, 0);
  var score = maxAvailable > 0 ? Math.round(got / maxAvailable * 100) : null;
  var verdict = null;
  if (score != null) verdict = score >= 70 ? 'Undervalued' : score >= 45 ? 'Fairly valued' : 'Overpriced';
  var rawScore = score, cycCapped = false;
  if (score != null && cyc.severity >= 0.5 && score > 70) {
    score = 70; verdict = 'Value (cyclical peak risk)'; cycCapped = true;
  }
  return { factors: factors, got: got, maxAvailable: maxAvailable, score: score, verdict: verdict, rawScore: rawScore, cycCapped: cycCapped, trap: trap, severity: cyc.severity };
}

/* Risk score: the mirror image of the valuation score. Same 0-100
 * scale and same normalize-over-available-factors rule, but the points
 * measure danger, not cheapness — higher = riskier. Factors: how hard
 * the stock swings (beta), how much debt it carries (debt/equity),
 * whether it earns money (profit margin), how big it is (market cap),
 * whether earnings are heading down (next-year EPS trend), and whether
 * it can pay its near-term bills (current ratio). */
/* Parse the StockAnalysis forecast page's annual table into a revenue
 * path: [{label:'FY2027', rev:<dollars>, est:<bool>}] ascending by year.
 * Values there use B/M suffixes ('20.25B'); 'Upgrade' cells are the
 * site's paywall and are skipped. A year counts as estimated when its
 * period-end date is still in the future. */
function parseBMV(s) {
  if (s == null) return null;
  var t = String(s).replace(/[$,]/g, '').trim();
  var m = t.match(/^(-?[\d.]+)\s*([BMTK])?$/i);
  if (!m) return null;
  var v = parseFloat(m[1]);
  if (!isFinite(v)) return null;
  var suf = (m[2] || '').toUpperCase();
  if (suf === 'B') v *= 1e9; else if (suf === 'M') v *= 1e6;
  else if (suf === 'T') v *= 1e12; else if (suf === 'K') v *= 1e3;
  return v;
}

function saTables(html) {
  var tables = [];
  var tRe = /<table[\s\S]*?<\/table>/gi, tm;
  while ((tm = tRe.exec(html))) {
    var rows = [];
    var rRe = /<tr[\s\S]*?<\/tr>/gi, rm;
    while ((rm = rRe.exec(tm[0]))) {
      var cells = [];
      var cRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, cm;
      while ((cm = cRe.exec(rm[0]))) cells.push(cm[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

function parseSAForecast(html) {
  var out = [];
  saTables(html).forEach(function (rows) {
    var fyRow = null, revRow = null, endRow = null;
    rows.forEach(function (r) {
      if (r[0] === 'Fiscal Year') fyRow = r;
      else if (r[0] === 'Revenue' && !revRow) revRow = r;
      else if (r[0] === 'Period Ending') endRow = r;
    });
    if (!fyRow || !revRow) return;
    var now = Date.now();
    for (var i = 1; i < fyRow.length; i++) {
      var rev = parseBMV(revRow[i]);
      if (!isNum(rev) || rev <= 0) continue;
      var end = endRow ? Date.parse(endRow[i]) : NaN;
      out.push({ label: fyRow[i].replace(/\s+/g, ' '), rev: rev, est: isNum(end) ? end > now : false });
    }
  });
  out.sort(function (a, b) { return a.label.localeCompare(b.label); });
  return out;
}

/* Company description: the "About" paragraph on the StockAnalysis main
 * page, trimmed to what a reader needs (Justin's rule, 2026-10-30):
 * sentence 1 always (it carries the business), sentence 2 only when
 * the pair stays under ~320 chars. Abbreviations are protected so the
 * splitter never cuts inside "Inc." or "U.S.". */
var ABOUT_ABBR = ['Inc.', 'Corp.', 'Co.', 'Ltd.', 'U.S.', 'No.', 'St.', 'e.g.', 'i.e.', 'Dr.'];
function aboutGuard(t, un) {
  ABOUT_ABBR.forEach(function (a, i) {
    var g = a.slice(0, -1) + '\u0001' + i + '\u0002';
    t = un ? t.split(g).join(a) : t.split(a).join(g);
  });
  return t;
}
function aboutTrim(text) {
  var t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  var parts = aboutGuard(t, false).split(/(?<=[.!?])\s+(?=[A-Z0-9"\u201c])/).map(function (p) {
    return aboutGuard(p, true);
  }).filter(Boolean);
  if (!parts.length) return '';
  var s1 = parts[0];
  if (parts.length > 1 && (s1 + ' ' + parts[1]).length <= 320) return s1 + ' ' + parts[1];
  if (s1.length > 340) {
    var cut = s1.slice(0, 340);
    var at = Math.max(cut.lastIndexOf('; '), cut.lastIndexOf(', '));
    if (at > 120) return cut.slice(0, at) + ' \u2026';
    return cut.slice(0, cut.lastIndexOf(' ')) + '\u2026';
  }
  return s1;
}
function parseSACeo(html) {
  if (!html) return '';
  var text = String(html);
  var m = text.match(/>CEO<\/td>\s*<td[^>]*>([^<]+)</);
  if (m) return m[1].replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").trim();
  /* Some pages (Netflix) have no profile CEO row; their executives
   * table pairs a name cell with a title cell instead. Collect every
   * top-level chief-executive title (co-CEOs included), skipping
   * divisional "Chief Executive Officer of ..." rows. */
  var names = [];
  var re = /<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]+)<\/td>/g, mm;
  while ((mm = re.exec(text)) !== null) {
    var title = mm[2].replace(/\s+/g, ' ').trim();
    if (/^(Co-)?Chief Executive Officer\b/.test(title) && title.indexOf(' Officer of ') === -1) {
      var nm = mm[1].replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
      if (nm && names.indexOf(nm) === -1) names.push(nm);
    }
  }
  return names.slice(0, 2).join(' & ');
}
var CEO_MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
var CEO_MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function ceoCleanLead(lead) {
  return String(lead || '')
    .replace(/\((?:[^()]*?(?:born|pronunciation)[^()]*?)\)/gi, '')
    .replace(/\s+([,.;])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
function ceoSinceFrom(clean, strict) {
  var M = '(January|February|March|April|May|June|July|August|September|October|November|December)';
  var pats = [
    new RegExp('succeeding [^.;]+? in (?:' + M + ' (?:\\d{1,2}, )?)?(\\d{4}) as (?:CEO|chief executive)', 'i'),
    new RegExp('(?:became|appointed|named) [^.;]{0,70}?(?:CEO|chief executive)[^.;]{0,40}? in (?:' + M + ' (?:\\d{1,2}, )?)?(\\d{4})', 'i'),
    new RegExp('(?:CEO|chief executive)[^.;]{0,70}? since (?:' + M + ' (?:\\d{1,2}, )?)?(\\d{4})', 'i'),
    new RegExp('has been [^.;]{0,60}? since (?:' + M + ' (?:\\d{1,2}, )?)?(\\d{4})', 'i'),
    new RegExp('since (?:' + M + ' (?:\\d{1,2}, )?)?(\\d{4})', 'i')
  ];
  var use = strict ? pats.slice(0, 3) : pats;
  for (var i = 0; i < use.length; i++) {
    var m = clean.match(use[i]);
    if (m) {
      var y = parseInt(m[2], 10);
      if (y >= 1950 && y <= new Date().getFullYear()) {
        return { y: y, m: (m[1] && CEO_MONTHS[m[1].toLowerCase()] !== undefined) ? CEO_MONTHS[m[1].toLowerCase()] : null };
      }
    }
  }
  return null;
}
function ceoBioFromLead(clean) {
  var guarded = aboutGuard(clean, false).replace(/(\b[A-Z])\./g, '$1\u0003');
  var parts = guarded.split(/(?<=[.!?])\s+(?=[A-Z0-9\u201c"])/).map(function (p) {
    return aboutGuard(p.split('\u0003').join('.'), true);
  }).filter(Boolean);
  var KEYS = ['joined', 'co-found', 'founded', 'became', 'appoint', 'succeed', 'previous', 'served', 'oversaw', 'credited', 'senior vice', 'executive vice', 'president', 'chairman', 'worked', 'engineer', 'led the', 'ran the'];
  var picked = [];
  for (var i = 0; i < parts.length && picked.length < 2; i++) {
    var low = ' ' + parts[i].toLowerCase() + ' ';
    var score = 0;
    KEYS.forEach(function (k) { if (low.indexOf(k) !== -1) score++; });
    if (score >= 1 && (picked.join(' ') + ' ' + parts[i]).length <= 340) picked.push(parts[i]);
  }
  if (!picked.length) return aboutTrim(clean);
  var bio = picked.join(' ');
  if (bio.length > 340) {
    var cut = bio.slice(0, 340);
    var at = Math.max(cut.lastIndexOf('; '), cut.lastIndexOf(', '));
    bio = (at > 120 ? cut.slice(0, at) : cut.slice(0, cut.lastIndexOf(' '))) + ' \u2026';
  }
  return bio;
}
/* Wikipedia lookups for the CEO bio. Two traps, both hit live
 * (2026-11-07, NVDA): (1) the company-qualified search can rank
 * the COMPANY's own article first — "Jen-Hsun Huang NVIDIA Corp"
 * returns the Nvidia article, whose lead fails the CEO check —
 * so fall back to the bare CEO name; (2) trusting a single search
 * hit is fragile, so scan the top few results for a lead that
 * actually talks about a CEO. */
function ceoWikiQueries(name, company) {
  var qs = [];
  if (company && name) qs.push(name + ' ' + company);
  if (name) qs.push(name);
  return qs;
}
function ceoNameScore(page, name) {
  if (!page) return 0;
  var parts = String(name || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!parts.length) return 0;
  var first = parts[0], last = parts[parts.length - 1];
  var title = String(page.title || '').toLowerCase();
  var lead = String(page.extract || '').toLowerCase();
  if (title === parts.join(' ')) return 4;
  var head = lead.slice(0, 300);
  if (head.indexOf(last) !== -1 && head.indexOf(first) !== -1) return 3;
  if (title.indexOf(last) !== -1) return 2;
  if (lead.slice(0, 600).indexOf(last) !== -1) return 1;
  return 0;
}
function ceoPickPage(pages, name) {
  var arr = Object.keys(pages || {}).map(function (k) { return pages[k]; });
  arr.sort(function (a, b) { return (a.index || 99) - (b.index || 99); });
  var passing = [];
  for (var i = 0; i < arr.length; i++) {
    var ex = arr[i].extract || '';
    if (/chief executive|\bCEO\b/.test(ex.slice(0, 600))) passing.push(arr[i]);
  }
  if (!passing.length) return null;
  /* A search for the new CEO also surfaces the predecessor's article
   * (Tim Cook outranks John Ternus) — prefer the hit that is actually
   * about this person whenever one clearly is. */
  var best = null, bestScore = -1;
  passing.forEach(function (p) { var sc = ceoNameScore(p, name); if (sc > bestScore) { bestScore = sc; best = p; } });
  if (bestScore >= 2) return best;
  return passing[0];
}
function ceoPickLead(pages, name) {
  var p = ceoPickPage(pages, name);
  return p ? (p.extract || '') : '';
}

/* Body-text founder test for the deep pass: the person's surname
 * tied to a founding verb inside one sentence ("Foroughi
 * co-founded AppLovin"). */
function ceoBodyFounder(clean, name) {
  var parts = String(name || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  var surname = parts[parts.length - 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(surname + '[^.;]{0,60}?(co-)?found', 'i').test(clean) ||
    new RegExp('(co-)?found[a-z]*[^.;]{0,40}?' + surname, 'i').test(clean);
}
function ceoFacts(lead, foundedYear) {
  var clean = ceoCleanLead(lead);
  var founder = /co-?found/i.test(clean) || /founded (?:the |a )?company/i.test(clean);
  var since = ceoSinceFrom(clean);
  if (!since && founder && foundedYear) since = { y: foundedYear, m: null };
  return { since: since, founder: founder, bio: ceoBioFromLead(clean) };
}
function ceoStartFromBars(bars, since) {
  var target = Date.UTC(since.y, since.m || 0, 1) / 1000;
  var pick = null;
  for (var i = 0; i < bars.length; i++) { if (bars[i].ts + 32 * 86400 > target) { pick = bars[i]; break; } }
  if (!pick) return null;
  var label;
  if (pick.ts > target + 32 * 86400) {
    var bd = new Date(pick.ts * 1000);
    label = CEO_MON_SHORT[bd.getUTCMonth()] + ' ' + bd.getUTCFullYear();
  } else if (since.m != null) label = CEO_MON_SHORT[since.m] + ' ' + since.y;
  else label = String(since.y);
  return { close: pick.c, label: label, ts: pick.ts };
}

/* Yahoo monthly bars -> the CEO-era start close/label/date. */
async function ceoPerfFor(T, since) {
  try {
    var cj = await relayFetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(T) + '?range=max&interval=1mo', {
      timeout: 20000,
      validate: function (t) { return t.indexOf('"chart"') !== -1; }
    });
    var res = JSON.parse(cj).chart.result[0];
    var tsArr = res.timestamp || [];
    var closes = (((res.indicators || {}).quote || [])[0] || {}).close || [];
    var bars = [];
    for (var bi = 0; bi < tsArr.length; bi++) { if (isNum(closes[bi]) && closes[bi] > 0) bars.push({ ts: tsArr[bi], c: closes[bi] }); }
    var sb = ceoStartFromBars(bars, since);
    return sb ? { sc: sb.close, sl: sb.label, st: sb.ts } : null;
  } catch (e) { return null; }
}

/* Tenure fallback when the Wikipedia lead never states a start date
 * (John Furner, Mark Widmar): the company's Wikidata item carries a
 * chief-executive (P169) statement whose start-time qualifier is the
 * appointment date. The statement's person label must match the
 * CEO's surname, so a stale item naming the predecessor is ignored. */
async function ceoSinceFromWikidata(companyName, ceoName) {
  try {
    if (!companyName || !ceoName) return null;
    var wurl = 'https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrlimit=1&prop=pageprops&ppprop=wikibase_item&gsrsearch=' + encodeURIComponent(companyName);
    var wj = await relayFetch(wurl, { timeout: 20000, validate: function (t) { return t.indexOf('wikibase_item') !== -1; } });
    var pages = ((JSON.parse(wj).query || {}).pages) || {};
    var qid = null;
    Object.keys(pages).forEach(function (k) { if (pages[k].pageprops && pages[k].pageprops.wikibase_item) qid = pages[k].pageprops.wikibase_item; });
    if (!qid) return null;
    var curl = 'https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&entity=' + qid + '&property=P169';
    var cj = await relayFetch(curl, { timeout: 20000, validate: function (t) { return t.indexOf('P169') !== -1; } });
    var claims = ((JSON.parse(cj).claims || {}).P169) || [];
    var cands = [];
    claims.forEach(function (cl) {
      var snak = cl.mainsnak;
      if (!snak || !snak.datavalue || !snak.datavalue.value || !snak.datavalue.value.id) return;
      var quals = cl.qualifiers || {};
      function qTime(prop) {
        var q = quals[prop] && quals[prop][0];
        return (q && q.datavalue && q.datavalue.value && q.datavalue.value.time) || null;
      }
      cands.push({ pid: snak.datavalue.value.id, start: qTime('P580'), ended: !!qTime('P582') });
    });
    if (!cands.length) return null;
    var ids = cands.map(function (c) { return c.pid; }).join('|');
    var ej = await relayFetch('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels&languages=en&ids=' + ids, { timeout: 20000, validate: function (t) { return t.indexOf('"labels"') !== -1; } });
    var ents = (JSON.parse(ej).entities) || {};
    var surname = String(ceoName).toLowerCase().split(/\s+/).pop();
    var mine = cands.filter(function (c) {
      var e = ents[c.pid];
      var lab = e && e.labels && e.labels.en && e.labels.en.value;
      return lab && lab.toLowerCase().indexOf(surname) !== -1 && c.start;
    });
    if (!mine.length) return null;
    var active = mine.filter(function (c) { return !c.ended; });
    var pool = active.length ? active : mine;
    pool.sort(function (a, b) { return a.start < b.start ? 1 : -1; });
    var mm = /^\+(\d{4})-(\d{2})/.exec(pool[0].start);
    if (!mm) return null;
    var mon = parseInt(mm[2], 10);
    return { y: parseInt(mm[1], 10), m: (mon >= 1 && mon <= 12) ? mon - 1 : null };
  } catch (e) { return null; }
}
function ceoCacheGet(key) {
  try {
    var all = JSON.parse(localStorage.getItem('sr_ceo_v3') || '{}');
    var e = all[key];
    /* An all-empty entry is a cached failure from the old build —
     * treat it as a miss so the lookup retries instead of waiting
     * out the TTL. */
    if (e && (Date.now() - e.ts) < 30 * 864e5 && (e.since || e.bio || e.sc || e.pr)) return e;
  } catch (err) {}
  return null;
}
function ceoCacheSet(key, e) {
  try {
    var all = JSON.parse(localStorage.getItem('sr_ceo_v3') || '{}');
    all[key] = e;
    localStorage.setItem('sr_ceo_v3', JSON.stringify(all));
  } catch (err) {}
}
/* Latest-year revenue share per business segment, from the 10-K
 * segment data (fetchSegmentsApp). Accounting leftover rows
 * (Corporate & other / balance rows) are not businesses, so they
 * are skipped; whatever they held lands in "Everything else". */
function segShares(seg) {
  if (!seg || !seg.ok || !seg.revenue || !seg.years || !seg.years.length) return [];
  var li = seg.years.length - 1;
  var total = seg.total && seg.total.rev ? seg.total.rev[li] : null;
  if (!isNum(total) || total <= 0) return [];
  var rows = [];
  (seg.segments || []).forEach(function (sg) {
    if (sg.balance || sg.corporate || /corporate/i.test(sg.name || '')) return;
    var v = sg.rev ? sg.rev[li] : null;
    if (!isNum(v) || v <= 0) return;
    var pct = v / total * 100;
    if (pct < 2) return;
    var row = { name: sg.name, pct: pct };
    /* Depth from the same filings (2026-11-07): the segment's own
     * profit margin where the 10-K splits profit, and how its share
     * of revenue has shifted vs ~3 years earlier. */
    var op = sg.op ? sg.op[li] : null;
    if (isNum(op)) row.margin = op / v * 100;
    var ei = li >= 3 ? li - 3 : 0;
    var totPrev = seg.total && seg.total.rev ? seg.total.rev[ei] : null;
    var vPrev = sg.rev ? sg.rev[ei] : null;
    if (ei !== li && isNum(totPrev) && totPrev > 0 && isNum(vPrev)) {
      var pctPrev = vPrev / totPrev * 100;
      if (Math.abs(pct - pctPrev) >= 3) { row.pctPrev = pctPrev; row.yearPrev = seg.years[ei]; }
    }
    rows.push(row);
  });
  rows.sort(function (a, b) { return b.pct - a.pct; });
  rows = rows.slice(0, 5);
  if (rows.length < 2) return [];
  var sum = rows.reduce(function (a, r) { return a + r.pct; }, 0);
  if (sum < 97) rows.push({ name: 'Everything else', pct: 100 - sum });
  return rows;
}

/* "How it makes money" (Justin's ask, 2026-11-07): one plain-English
 * sentence (AI-written from the company's public description and
 * filings, numbers-free by construction) over the real revenue
 * split from its 10-K segments. Renders only when at least one of
 * the two exists — never a guessed split. */
function bizInnerHtml(d) {
  if (!d) return '';
  var segs = d.bizSegs || [];
  if (!d.bizLine && segs.length < 2) return '';
  var inner = '';
  if (d.bizLine) inner += '<p class="biz-line">' + esc(d.bizLine) + '</p>';
  if (segs.length >= 2) {
    inner += segs.map(function (sg) {
      var mgn = (isNum(sg.margin) && sg.margin >= -50 && sg.margin <= 100)
        ? '<span class="biz-mgn"> \u00b7 ' + fmtNum(sg.margin, 0) + '% margin</span>' : '';
      return '<div class="biz-row"><div class="biz-row-top"><span>' + esc(sg.name) + '</span><span><span class="gold-text">' + fmtNum(sg.pct, 0) + '%</span>' + mgn + '</span></div>' +
        '<div class="biz-bar"><div style="width:' + Math.max(2, Math.min(100, sg.pct)).toFixed(0) + '%"></div></div></div>';
    }).join('');
    var top = segs[0];
    if (top && isNum(top.pctPrev)) {
      inner += '<p class="fineprint">' + esc(top.name) + ' was ' + fmtNum(top.pctPrev, 0) + '% of revenue in ' + top.yearPrev + ' \u2014 now ' + fmtNum(top.pct, 0) + '%.</p>';
    }
    inner += '<p class="fineprint">Share of revenue, latest fiscal year (company filings).</p>';
  }
  return inner;
}
function bizBlockHtml(d) {
  var inner = bizInnerHtml(d);
  if (!inner) return '';
  return '<button type="button" class="ceo-toggle" data-biztoggle aria-expanded="false"><span class="earn-line ceo-line">How it makes money</span><span class="ceo-chev">\u25be</span></button>' +
    '<div class="ceo-body biz-body" hidden>' + inner + '</div>';
}
function ceoHeadHtml(d) { return 'CEO \u00b7 <b>' + esc(d.ceo) + '</b>'; }
function ceoInnerHtml(d) {
  var inner = '';
  var meta = [];
  if (d.ceoSince) meta.push('Since ' + (d.ceoSince.m != null ? CEO_MON_SHORT[d.ceoSince.m] + ' ' : '') + d.ceoSince.y);
  if (d.ceoFounder) meta.push('<span class="gold-text">Founder</span>');
  if (meta.length) inner += '<p class="ceo-meta">' + meta.join(' \u00b7 ') + '</p>';
  if (d.ceoBio) inner += '<p class="ceo-bio">' + esc(d.ceoBio) + '</p>';
  if (isNum(d.ceoStartClose) && d.ceoStartClose > 0 && isNum(d.price) && d.ceoStartLabel) {
    var pct = (d.price / d.ceoStartClose - 1) * 100;
    var ptxt = (pct >= 0 ? '+' : '') + (Math.abs(pct) >= 100 ? fmtNum(pct, 0) : fmtNum(pct, 1)) + '%';
    var cagrTxt = '';
    if (isNum(d.ceoStartTs)) {
      var yrs = (Date.now() / 1000 - d.ceoStartTs) / 31557600;
      if (yrs >= 1) {
        var cagr = (Math.pow(d.price / d.ceoStartClose, 1 / yrs) - 1) * 100;
        if (isFinite(cagr)) cagrTxt = ' \u00b7 ' + fmtPct(cagr) + ' CAGR';
      }
    }
    inner += '<p class="ceo-perf">Stock <span class="' + (pct >= 0 ? 'up' : 'down') + '">' + ptxt + '</span> since ' + esc(d.ceoStartLabel) + cagrTxt + '</p>';
  }
  if (d.ceoPrevRole) inner += '<p class="ceo-prev">Previously \u00b7 ' + esc(d.ceoPrevRole) + '</p>';
  if (d.ceoPrevGrowth) inner += '<p class="ceo-prev">Track record \u00b7 ' + esc(d.ceoPrevGrowth) + '</p>';
  return inner;
}
function ceoBlockHtml(d) {
  if (!d || !d.ceo) return '';
  var inner = ceoInnerHtml(d);
  if (!inner) return '<p class="earn-line ceo-line">' + ceoHeadHtml(d) + '</p>';
  return '<button type="button" class="ceo-toggle" data-ceotoggle aria-expanded="false"><span class="earn-line ceo-line">' + ceoHeadHtml(d) + '</span><span class="ceo-chev">\u25be</span></button>' +
    '<div class="ceo-body" hidden>' + inner + '</div>';
}

/* "More" (Justin's ask, 2026-11-07): on the scorecard, the CEO block,
 * How it makes money, and the next-earnings line live under ONE
 * dropdown named More, contents always expanded inside it. The
 * earnings line additionally appears OUTSIDE the dropdown when its
 * date is known for sure (earnEst false) — see renderScorecard. */
function moreBlockHtml(d) {
  if (!d) return '';
  var secs = '';
  if (d.ceo) secs += '<div class="more-sec"><p class="earn-line ceo-line">' + ceoHeadHtml(d) + '</p>' + ceoInnerHtml(d) + '</div>';
  var bi = bizInnerHtml(d);
  if (bi) secs += '<div class="more-sec"><p class="earn-line ceo-line">How it makes money</p>' + bi + '</div>';
  var el = earnLineHtml(d);
  if (el) secs += '<div class="more-sec">' + el + '</div>';
  if (!secs) return '';
  return '<button type="button" class="ceo-toggle" data-moretoggle aria-expanded="false"><span class="earn-line ceo-line">More</span><span class="ceo-chev">\u25be</span></button>' +
    '<div class="ceo-body more-body" hidden>' + secs + '</div>';
}
function parseSAAbout(html) {
  if (!html) return '';
  var m = String(html).match(/About\s+[A-Z][A-Z.\-]*<\/h2>\s*<p>([\s\S]*?)<\/p>/);
  if (!m) return '';
  var text = m[1].replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
  return aboutTrim(text);
}

/* Estimate columns of the StockAnalysis forecast table (annual):
 * every metric the Quarterly Metrics tool charts gets the current
 * fiscal year's consensus where the free page exposes it (later
 * years are paywalled). Margins come straight off the page or are
 * derived from the same columns' $ rows. */
function parseSAForecastMetrics(html) {
  var est = {};
  if (!html) return est;
  saTables(html).forEach(function (rows) {
    if (!rows.length || rows[0][0] !== 'Fiscal Year') return;
    var byLabel = {};
    rows.forEach(function (r) { if (r[0] && byLabel[r[0]] === undefined) byLabel[r[0]] = r; });
    var endRow = byLabel['Period Ending'], hdr = rows[0];
    if (!endRow) return;
    var now = Date.now(), cols = [];
    for (var i = 1; i < hdr.length; i++) {
      var end = Date.parse(endRow[i]);
      if (isNum(end) && end > now) cols.push(i);
    }
    if (!cols.length) return;
    function valAt(rowLabel, i) {
      var r = byLabel[rowLabel];
      return r ? parseBMV(r[i]) : null;
    }
    cols.forEach(function (i) {
      var rev = valAt('Revenue', i);
      if (!isNum(rev)) rev = valAt('Total Revenue', i);
      if (!isNum(rev)) rev = valAt('Revenue as Reported', i);
      function push(key, v) { if (isNum(v)) (est[key] = est[key] || []).push({ plabel: hdr[i], value: v }); }
      push('revenue', rev);
      push('netIncome', valAt('Net Income', i));
      push('fcf', valAt('Free Cash Flow', i));
      var gmRow = byLabel['Gross Margin'];
      var gm = gmRow ? parseNum(gmRow[i]) : null;
      if (!isNum(gm)) { var gp = valAt('Gross Profit', i); gm = (isNum(gp) && isNum(rev) && rev !== 0) ? gp / rev * 100 : null; }
      push('grossMargin', gm);
      var oi = valAt('Operating Income', i);
      push('operMargin', (isNum(oi) && isNum(rev) && rev !== 0) ? oi / rev * 100 : null);
      var ni = valAt('Net Income', i);
      push('netMargin', (isNum(ni) && isNum(rev) && rev !== 0) ? ni / rev * 100 : null);
    });
  });
  var rs = parseSARevSummary(html);
  if (rs) est.revFcst = rs;
  return est;
}

/* The forecast page's summary sentences carry the two growth rates
 * the exit-P/E growth factor is keyed to -- "Revenue This Year XB
 * from YB Increased by Z%" and the same for Next Year. The table
 * itself only exposes one forecast year for free, so the pair has
 * to come from the text. Returns signed growth percentages. */
function parseSARevSummary(html) {
  if (!html) return null;
  var txt = String(html).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  function grab(which) {
    var m = txt.match(new RegExp('Revenue ' + which + ' Year\\s+[\\d.,]+[BM]\\s+from\\s+[\\d.,]+[BM]\\s+(Increased|Decreased) by\\s+([\\d.]+)%'));
    if (!m) return null;
    var v = parseFloat(m[2]);
    return m[1] === 'Decreased' ? -v : v;
  }
  var gT = grab('This'), gN = grab('Next');
  return (isNum(gT) && isNum(gN)) ? { gThis: gT, gNext: gN } : null;
}

/* The StockAnalysis ratios page carries a 'PE Ratio' row across the
 * last five fiscal years (plus a Current column). Its average is the
 * Projection Builder's exit-P/E anchor (Justin's ask, 2026-10-26):
 * what the market has actually paid for this stock's earnings over a
 * full cycle, instead of today's possibly-stretched multiple. */
function parseSAPeHistory(html) {
  var vals = [];
  if (!html) return null;
  saTables(html).forEach(function (rows) {
    if (!rows.length || rows[0][0] !== 'Fiscal Year' || vals.length) return;
    var peRow = null;
    rows.forEach(function (r) { if (r[0] === 'PE Ratio') peRow = r; });
    if (!peRow) return;
    for (var i = 1; i < rows[0].length && vals.length < 5; i++) {
      if (rows[0][i] === 'Current') continue;
      var v = parseNum(peRow[i]);
      if (isNum(v) && v > 0 && v < 1000) vals.push(v);
    }
  });
  if (vals.length < 3) return null;
  var avg = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
  return { avg: avg, years: vals.length };
}

/* Same ratios table, but keeps each fiscal year's P/E: the raw
 * material for the EPS-matched exit P/E (pair each year's P/E with
 * that year's EPS). */
function parseSAPeByYear(html) {
  var out = [];
  if (!html) return out;
  saTables(html).forEach(function (rows) {
    if (!rows.length || rows[0][0] !== 'Fiscal Year' || out.length) return;
    var peRow = null;
    rows.forEach(function (r) { if (r[0] === 'PE Ratio') peRow = r; });
    if (!peRow) return;
    for (var i = 1; i < rows[0].length; i++) {
      if (rows[0][i] === 'Current') continue;
      var ym = String(rows[0][i]).match(/(\d{4})/);
      var v = parseNum(peRow[i]);
      if (ym && isNum(v) && v > 0 && v < 1000) out.push({ fy: parseInt(ym[1], 10), pe: v });
    }
  });
  out.sort(function (a, b) { return a.fy - b.fy; });
  return out;
}

var PE5Y_KEY = 'sr_pe5y_v2';
async function fetchPe5yAvg(T) {
  var cache = lsGet(PE5Y_KEY, {});
  var day = new Date().toDateString();
  if (cache[T] && cache[T].day === day) return cache[T].data;
  var html = await relayFetch('https://stockanalysis.com/stocks/' + encodeURIComponent(T) + '/financials/ratios/', {
    timeout: 25000,
    validate: function (t) { return t.indexOf('PE Ratio') !== -1; }
  });
  var byYear = parseSAPeByYear(html);
  var data = null;
  if (byYear.length >= 3) {
    var recent = byYear.slice(-5);
    data = { avg: recent.reduce(function (a, p) { return a + p.pe; }, 0) / recent.length, years: recent.length, byYear: byYear };
  }
  cache[T] = { day: day, data: data };
  lsSet(PE5Y_KEY, cache);
  return data;
}

/* Attach the 5Y average to a stock record (best-effort: any failure
 * leaves the record untouched and the builder falls back to the
 * current P/E). */
async function pjEnsurePe5y(d) {
  if (!d || !d.ticker || isNum(d.pe5yAvg)) return d;
  try {
    var pe = await fetchPe5yAvg(d.ticker);
    if (pe) { d.pe5yAvg = pe.avg; d.pe5yYears = pe.years; d.peByYear = pe.byYear; }
  } catch (e) {}
  return d;
}

/* ---- Exit P/E v2 (Justin's spec, locked 2026-11-10; replaces the
 * 2026-11-01 EPS-matched rule) ----
 * Exit P/E = base x growth factor x margin factor.
 * BASE: exponential-weighted average of the earnings yield (1 / P/E)
 * over the current P/E (age 0) and each fiscal year's P/E, half-life
 * 1.5 years, inverted back to a P/E -- recent years count most, like
 * a 50-day moving average next to a 200-day. Two caps keep broken
 * years out: a healthy year's P/E counts at most 1.5x the stock's own
 * median P/E, and a DEPRESSED year -- EPS fell vs the year before, or
 * a first small profit after a loss when earnings once ran at 2x+
 * that level -- counts at most the median of the healthy years.
 * GROWTH factor (0.65-1.15): forecast revenue deceleration dominates
 * -- (next-year revenue growth - this-year growth) x 0.004 from the
 * forecast page's summary pair, falling back to the revenue path's
 * forecast years (last reported year's growth standing in when only
 * one forecast year exists); recent quarterly revenue acceleration
 * adds a small bonus (point change clamped to +/-20, x 0.0015); if
 * consensus EPS falls in any forecast year, x 0.85. The 0.65-1.15
 * bound is applied, then re-applied after the 0.85.
 * MARGIN factor (0.85-1.10): direction = average point change in
 * gross + operating margin, expected next year vs the latest reported
 * year, x 0.01. Peak rule: when the expected gross margin sits in the
 * stock's peak zone (>= 95% of its own 5-yr max), a positive direction
 * earns nothing and a normalization haircut applies instead -- -0.01
 * per point the expected margin sits above its own 5-yr average,
 * capped at -0.10; a ratio penalty (0 at <=1.5x the average, up to
 * -0.20 at >=2.5x) takes the larger of the two, never stacked. Net
 * margin is excluded (tax / deal noise). Missing data leaves a
 * factor at 1 rather than guessing. */
var pjExitDetail = null;
function pjMedian(vals) {
  var s = vals.slice().sort(function (a, b) { return a - b; });
  var n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function pjComputeExitPe(d) {
  if (!d) return null;
  var pts = [];
  if (isNum(d.pe) && d.pe > 0 && d.pe < 1000) pts.push({ pe: d.pe, fy: null, cur: true });
  (d.peByYear || []).filter(function (p) { return p && isNum(p.pe) && p.pe > 0 && p.pe < 1000; })
    .slice().sort(function (a, b) { return b.fy - a.fy; })
    .forEach(function (p) { pts.push({ pe: p.pe, fy: p.fy, cur: false }); });
  /* Sector-median fallback (Justin's call, 2026-11-13): the exit
   * P/E must always calculate. d.peMed is the median trailing P/E of
   * the stock's industry across the whole market, resolved by the
   * caller (scan finalize on the server, pjEnsurePeMed in the app).
   * The base is the LOWER of the stock's own multiple and the
   * industry median whenever history is thin (Justin's refinement,
   * 2026-11-13): no P/E points at all -> the median is the base; a
   * thin blend (today plus fewer than 3 past years) above the median
   * is pulled down to it, and one below it stays -- a short, rich
   * history does not earn an above-market exit multiple, and a cheap
   * one is never lifted to the median. The stock's own growth and
   * margin factors still apply on top either way. */
  var peMed = isNum(d.peMed) && d.peMed > 0 && d.peMed < 1000 ? d.peMed : null;
  var peSrc = 'history';
  if (pts.length === 0) {
    if (!peMed) return null;
    peSrc = 'sector';
  }
  var medAll = pts.length ? pjMedian(pts.map(function (p) { return p.pe; })) : peMed;
  var epsMap = d.epsByYear || {};
  function epsAt(fy) { var v = epsMap[fy]; return isNum(v) ? v : null; }
  pts.forEach(function (p) {
    p.depressed = false;
    if (p.cur) {
      /* Today's P/E is depressed only on a clear earnings fall:
       * TTM EPS well under the last fiscal year's EPS. */
      var fys = Object.keys(epsMap).map(function (k) { return parseInt(k, 10); }).filter(isNum).sort(function (a, b) { return a - b; });
      var lastEps = fys.length ? epsAt(fys[fys.length - 1]) : null;
      if (isNum(d.epsTTM) && isNum(lastEps) && lastEps > 0 && d.epsTTM < 0.85 * lastEps) p.depressed = true;
    } else {
      var e = epsAt(p.fy), prev = epsAt(p.fy - 1);
      if (isNum(e) && e > 0 && isNum(prev)) {
        if (prev > 0 && e < prev) p.depressed = true;
        else if (prev <= 0) {
          var maxBefore = null;
          Object.keys(epsMap).forEach(function (k) {
            var fy2 = parseInt(k, 10), v = epsMap[k];
            if (isNum(fy2) && fy2 < p.fy && isNum(v) && v > 0 && (maxBefore === null || v > maxBefore)) maxBefore = v;
          });
          if (isNum(maxBefore) && maxBefore >= 2 * e) p.depressed = true;
        }
      }
    }
  });
  var healthy = pts.filter(function (p) { return !p.depressed; });
  var medClean = healthy.length >= 2 ? pjMedian(healthy.map(function (p) { return p.pe; })) : medAll;
  var capRel = 1.5 * medAll;
  var wSum = 0, ySum = 0;
  pts.forEach(function (p, i) {
    var capped = p.depressed ? Math.min(p.pe, medClean) : Math.min(p.pe, capRel);
    var w = Math.pow(0.5, i / 1.5);
    wSum += w; ySum += w / capped;
  });
  var base = peSrc === 'sector' ? peMed : wSum / ySum;
  if (peSrc === 'history' && pts.length < 4 && peMed && base > peMed) { base = peMed; peSrc = 'capped'; }
  /* --- growth factor --- */
  var decel = 0, accelPts = 0;
  var rp = (d.revPath || []).filter(function (r) { return r && isNum(r.rev) && r.rev > 0; });
  if (d.revFcst && isNum(d.revFcst.gThis) && isNum(d.revFcst.gNext)) decel = (d.revFcst.gNext - d.revFcst.gThis) * 0.004;
  var estIdx = [];
  rp.forEach(function (r, i) { if (r.est) estIdx.push(i); });
  function rpGrowth(k) { return (k >= 1 && rp[k - 1].rev > 0) ? (rp[k].rev / rp[k - 1].rev - 1) * 100 : null; }
  if (!d.revFcst && estIdx.length >= 2) {
    var gF = rpGrowth(estIdx[0]), gL = rpGrowth(estIdx[estIdx.length - 1]);
    if (isNum(gF) && isNum(gL)) decel = (gL - gF) * 0.004;
  } else if (!d.revFcst && estIdx.length === 1 && estIdx[0] >= 2) {
    var gP = rpGrowth(estIdx[0] - 1), gO = rpGrowth(estIdx[0]);
    if (isNum(gP) && isNum(gO)) decel = (gO - gP) * 0.004;
  }
  var rq = d.revQ || [], yoy = [];
  for (var qi = 4; qi < rq.length; qi++) {
    if (isNum(rq[qi]) && isNum(rq[qi - 4]) && rq[qi - 4] > 0) yoy.push((rq[qi] / rq[qi - 4] - 1) * 100);
  }
  if (yoy.length >= 4) {
    var l2 = (yoy[yoy.length - 1] + yoy[yoy.length - 2]) / 2;
    var p2 = (yoy[yoy.length - 3] + yoy[yoy.length - 4]) / 2;
    accelPts = Math.max(-20, Math.min(20, l2 - p2));
  }
  var fcEps = (d.epsForecasts || []).filter(function (r) { return r && isNum(r.eps); }).map(function (r) {
    var m = String(r.fiscalEnd || '').match(/(\d{4})/);
    return { y: m ? parseInt(m[1], 10) : 0, eps: r.eps };
  }).sort(function (a, b) { return a.y - b.y; }).map(function (r) { return r.eps; });
  var epsFall = false;
  for (var fi = 1; fi < fcEps.length; fi++) { if (fcEps[fi] < fcEps[fi - 1]) { epsFall = true; break; } }
  var growth = Math.max(0.65, Math.min(1.15, 1 + decel + accelPts * 0.0015));
  if (epsFall) growth = Math.max(0.65, Math.min(1.15, growth * 0.85));
  /* --- margin factor --- */
  var margin = 1;
  var yrs = (d.yearly || []).filter(function (y) { return y && isNum(y.gm); });
  var lastY = (d.yearly && d.yearly.length) ? d.yearly[d.yearly.length - 1] : null;
  if (isNum(d.estGmExp) && yrs.length >= 3 && lastY && isNum(lastY.gm)) {
    var win = yrs.slice(-5);
    var avgGm = win.reduce(function (a, y) { return a + y.gm; }, 0) / win.length;
    var maxGm = Math.max.apply(null, win.map(function (y) { return y.gm; }));
    var deltas = [d.estGmExp - lastY.gm];
    if (isNum(d.estOmExp) && isNum(lastY.om)) deltas.push(d.estOmExp - lastY.om);
    var dir = (deltas.reduce(function (a, b) { return a + b; }, 0) / deltas.length) * 0.01;
    var inPeak = d.estGmExp >= 0.95 * maxGm;
    var ratioPen = avgGm > 0 ? Math.max(0, Math.min(0.20, (d.estGmExp / avgGm - 1.5) * 0.20)) : 0;
    var ptsPen = inPeak ? Math.min(0.10, Math.max(0, d.estGmExp - avgGm) * 0.01) : 0;
    var pen = Math.max(ratioPen, ptsPen);
    var dirApplied = (dir > 0 && inPeak) ? 0 : dir;
    margin = Math.max(0.85, Math.min(1.10, 1 + dirApplied - pen));
  }
  var mult = base * growth * margin;
  if (!isNum(mult) || mult <= 0) return null;
  return { mult: mult, base: base, growth: growth, margin: margin, src: peSrc, peMed: peMed };
}
/* Industry-median P/E for the exit-P/E fallback: the Worker computes
 * the median trailing P/E of every StockAnalysis industry from the
 * Total Market scan (GET /sector-pe; ?t= resolves one ticker's
 * industry). Day-cached on device. Sets d.peMed (and d.peMedInd), or
 * d.peMedTried when the ticker's industry has no usable median, so
 * thin-history names still get an exit P/E and rich thin bases get
 * capped -- see pjComputeExitPe. */
var PEMED_KEY = 'sr_pemed_v1';
async function pjEnsurePeMed(d) {
  if (!d || isNum(d.peMed) || d.peMedTried) return;
  var today = new Date().toDateString();
  var c = lsGet(PEMED_KEY, null);
  if (!c || typeof c !== 'object' || c.day !== today) c = { day: today, map: null, byT: {} };
  if (!c.byT) c.byT = {};
  var T = d.ticker ? String(d.ticker).toUpperCase() : '';
  function save() { try { lsSet(PEMED_KEY, c); } catch (e) {} }
  if (d.industry && c.map && isNum(c.map[d.industry])) { d.peMed = c.map[d.industry]; d.peMedInd = d.industry; return; }
  if (T && c.byT[T]) {
    if (isNum(c.byT[T].med)) { d.peMed = c.byT[T].med; d.peMedInd = c.byT[T].ind || ''; }
    else d.peMedTried = true;
    return;
  }
  if (!c.map) {
    try {
      var r = await fetch(RELAYS[0] + '/sector-pe');
      if (r && r.ok) { var j = await r.json(); if (j && j.ind) { c.map = j.ind; save(); } }
    } catch (e) {}
    if (d.industry && c.map && isNum(c.map[d.industry])) { d.peMed = c.map[d.industry]; d.peMedInd = d.industry; return; }
  }
  if (T) {
    try {
      var r2 = await fetch(RELAYS[0] + '/sector-pe?t=' + encodeURIComponent(T));
      if (r2 && r2.ok) {
        var j2 = await r2.json();
        var bt = j2 && j2.byTicker ? j2.byTicker[T] : null;
        if (bt && isNum(bt.med)) { c.byT[T] = { ind: bt.ind || '', med: bt.med }; d.peMed = bt.med; d.peMedInd = bt.ind || ''; }
        else { c.byT[T] = { ind: bt && bt.ind ? bt.ind : '', med: null }; d.peMedTried = true; }
        save();
        return;
      }
    } catch (e) {}
  }
  /* Lookup failed (offline / medians not ready): leave peMed unset
   * and un-tried so a later load can retry; the older fallbacks in
   * pjApplyAuto / wlProjectCagr still apply in the meantime. */
}

function pjExitNote(res) {
  var baseTxt = res.src === 'sector'
    ? 'industry median ' + fmtNum(res.base, 1) + '\u00d7 (not enough P/E history of its own)'
    : res.src === 'capped'
      ? 'industry median ' + fmtNum(res.base, 1) + '\u00d7 caps it (thin P/E history)'
      : 'recent-weighted avg ' + fmtNum(res.base, 1) + '\u00d7';
  return 'exit P/E = ' + fmtNum(res.mult, 1) + '\u00d7 \u2014 ' + baseTxt + ' \u00d7 growth ' + fmtNum(res.growth, 2) + ' \u00d7 margins ' + fmtNum(res.margin, 2);
}
/* Set the exit-P/E box from the v2 math, falling back to the plain
 * 5-yr average, then today's P/E, when history is too thin. Always
 * refreshes pjMultAuto / pjPeNote / pjExitDetail together. */
function pjApplyAuto(d) {
  var res = pjComputeExitPe(d);
  if (res) {
    $('pj-mult').value = Math.round(res.mult * 10) / 10;
    pjMultAuto = $('pj-mult').value;
    pjExitDetail = res;
    pjPeNote = pjExitNote(res);
    return true;
  }
  pjExitDetail = null;
  if (isNum(d.pe5yAvg) && d.pe5yAvg > 0) {
    $('pj-mult').value = Math.round(d.pe5yAvg * 10) / 10;
    pjMultAuto = $('pj-mult').value;
    pjPeNote = 'exit P/E = ' + (d.pe5yYears >= 5 ? '5-yr' : d.pe5yYears + '-yr') + ' avg P/E ' + fmtNum(d.pe5yAvg, 1) + '\u00d7';
    return true;
  }
  if (isNum(d.pe) && d.pe > 0) {
    $('pj-mult').value = Math.round(d.pe * 10) / 10;
    pjMultAuto = $('pj-mult').value;
    pjPeNote = 'exit P/E = current P/E ' + fmtNum(d.pe, 1) + '\u00d7 (no 5-yr history)';
    return true;
  }
  return false;
}

/* The stock record behind the builder, kept so the auto exit P/E can
 * be recomputed when fresher inputs land. Null for saved-projection
 * restores: those keep their exact saved assumptions. */
var pjLoaded = null;

/* Recompute the auto exit P/E from the loaded record. Only ever
 * touches the box while it still holds the auto value -- a manual
 * override is his and stays. */
function pjRefreshAutoMult() {
  if (!pjLoaded) return;
  var T = ($('pj-ticker').value || '').trim().toUpperCase();
  if (!T || pjLoaded.ticker !== T) return;
  if (String($('pj-mult').value) !== String(pjMultAuto)) return;
  var before = pjPeNote;
  if (!pjApplyAuto(pjLoaded)) return;
  if (pjPeNote && pjPeNote !== before) {
    if (pjStatusBits && pjStatusBits.length) { pjStatusBits[0] = pjPeNote; pjRenderLoadedStatus(); }
    else pjSetLoadedStatus('Loaded ' + T + ' \u2014 ' + pjPeNote + '.');
  }
}


/* Attach yearly revenue + EPS, the expected next-year margins and
 * (from the same annual statements) the yearly margin history to a
 * stock record, best-effort. EPS feeds the depressed-year test in
 * the exit-P/E math; the margins feed its margin factor. */
async function pjEnsureRevByYear(d) {
  if (!d || !d.ticker || d.pjQmDone) return d;
  try {
    var qm = await fetchQMetrics(d.ticker, 'y');
    if (qm && qm.revenue) {
      var map = {};
      qm.periods.forEach(function (p, i) {
        var m = String(p).match(/(\d{4})/);
        if (m && isNum(qm.revenue[i])) map[parseInt(m[1], 10)] = qm.revenue[i];
      });
      if (Object.keys(map).length) d.revByYear = map;
    }
    if (qm && qm.eps) {
      var emap = {};
      qm.periods.forEach(function (p, i) {
        var m = String(p).match(/(\d{4})/);
        if (m && isNum(qm.eps[i])) emap[parseInt(m[1], 10)] = qm.eps[i];
      });
      if (Object.keys(emap).length) d.epsByYear = emap;
    }
    if (qm && qm.est) {
      if (!isNum(d.estGmExp) && qm.est.grossMargin && qm.est.grossMargin.length) d.estGmExp = qm.est.grossMargin[0].value;
      if (!isNum(d.estOmExp) && qm.est.operMargin && qm.est.operMargin.length) d.estOmExp = qm.est.operMargin[0].value;
      if (!d.revFcst && qm.est.revFcst) d.revFcst = qm.est.revFcst;
    }
    if (qm && !d.yearly) buildYearly(d, qm);
    d.pjQmDone = true;
  } catch (e) {}
  return d;
}

/* Everything the exit-P/E v2 math reads, attached best-effort:
 * P/E by year, EPS by year, expected margins, yearly margins and
 * quarterly revenue (for the acceleration bonus). */
async function pjEnsureExitData(d) {
  if (!d || !d.ticker) return d;
  await pjEnsurePe5y(d);
  await pjEnsureRevByYear(d);
  if (!d.yearly) {
    try { var cy = await cycLoadYearly(d.ticker); if (cy && cy.yearly) d.yearly = cy.yearly; } catch (e) {}
  }
  if (!d.revQ) {
    try { var qq = await fetchQMetrics(d.ticker, 'q'); if (qq && qq.revenue) d.revQ = qq.revenue.slice(); } catch (e) {}
  }
  await pjEnsurePeMed(d);
  return d;
}

/* The EPS peak-cliff, same detection as the trajectory chart: a later
 * consensus year falls 10%+ below the running peak. */
function epsCliffInfo(d) {
  var pts = epsTrajectory(d).points;
  var peak = -Infinity, peakLabel = '';
  for (var i = 0; i < pts.length; i++) {
    // Justin's rule (2026-10-30): a cliff must be in the FUTURE. The
    // peak has to be a forecast year -- a fall from TTM into the first
    // estimate is a down year already in motion, not a cliff, so the
    // TTM point can never be the peak (and drops only count after a
    // forecast peak exists).
    if (pts[i].kind !== 'est') continue;
    if (pts[i].eps > peak) { peak = pts[i].eps; peakLabel = pts[i].label; }
    else if (peak > 0 && pts[i].eps < peak * 0.90) {
      return { peakLabel: peakLabel, dropLabel: pts[i].label, dropPct: (pts[i].eps / peak - 1) * 100 };
    }
  }
  return null;
}

/* The EPS points alone (TTM actual + up to 4 consensus years, with a
 * next-year fallback), split out of epsTrajectory so other checks can
 * use the points without re-running the warning logic. */
function epsPoints(d) {
  var pts = [];
  if (isNum(d.epsTTM)) pts.push({ label: 'TTM', eps: d.epsTTM, kind: 'actual' });
  (d.epsForecasts || []).slice(0, 4).forEach(function (f) {
    var yr = String(f.fiscalEnd || '').replace(/^[A-Za-z]+\s+/, '');
    pts.push({ label: 'FY' + yr, eps: f.eps, kind: 'est', n: f.n });
  });
  if (pts.length < 2 && isNum(d.epsNextY)) {
    pts.push({ label: 'Next yr est', eps: d.epsNextY, kind: 'est' });
  }
  return pts;
}

/* EPS levels 1-2 years ago, rebuilt from the quarterly reported EPS
 * (MarketBeat, newest first): the TTM that ended 4 quarters back
 * (needs 8 quarters of history) and the one that ended 8 quarters
 * back (needs 12). Non-positive or unbuildable bases drop out. */
function epsHistBases(d) {
  var rows = d.epsHistQ || [], out = [];
  function ttmEndingAt(idx) {
    var sum = 0;
    for (var i = idx; i < idx + 4; i++) {
      if (!rows[i] || !isNum(rows[i].reported)) return null;
      sum += rows[i].reported;
    }
    return sum;
  }
  var b2 = rows.length >= 12 ? ttmEndingAt(8) : null;
  if (isNum(b2) && b2 > 0) out.push({ base: b2, label: '2 yrs ago' });
  var b1 = rows.length >= 8 ? ttmEndingAt(4) : null;
  if (isNum(b1) && b1 > 0) out.push({ base: b1, label: '1 yr ago' });
  return out;
}

/* Possible cliff (Justin's rule, 2026-10-27; lookback added
 * 2026-11-01): with ONLY 2 projected years, an explosive run-up
 * followed by a hard growth deceleration is the classic pre-cliff
 * shape — the peak likely sits just past the forecast window, so it
 * counts as a cliff even though no fall is visible inside the
 * window. Fires only when ALL hold: exactly 2 projected years beyond
 * TTM; TTM EPS > 0; FY2 growth rate <= half the FY1 growth rate; and
 * an explosion of >= +75% measured EITHER as FY1 growth vs TTM or as
 * TTM growth vs the TTM of up to 2 years ago (the explosion may
 * already have happened into the current TTM). */
function epsPossibleCliff(d) {
  var pts = epsPoints(d);
  if (pts.length !== 3) return null;
  if (pts[0].kind !== 'actual' || pts[1].kind !== 'est' || pts[2].kind !== 'est') return null;
  var ttm = pts[0].eps, f1 = pts[1].eps, f2 = pts[2].eps;
  if (!isNum(ttm) || !isNum(f1) || !isNum(f2) || ttm <= 0 || f1 <= 0) return null;
  var g1 = (f1 / ttm - 1) * 100;
  var g2 = (f2 / f1 - 1) * 100;
  if (g2 > g1 * 0.5) return null;
  if (g1 >= 75) return { fy1Label: pts[1].label, fy2Label: pts[2].label, g1: g1, g2: g2 };
  var bases = epsHistBases(d);
  for (var bi = 0; bi < bases.length; bi++) {
    var gB = (ttm / bases[bi].base - 1) * 100;
    if (gB >= 75) return { fy1Label: pts[1].label, fy2Label: pts[2].label, g1: g1, g2: g2, lookback: bases[bi].label, gB: gB };
  }
  return null;
}

/* No-profit warning (Justin's rule, 2026-10-27): a company losing money
 * today (TTM EPS <= 0) that analysts don't project to turn profitable
 * for at least 4 more years gets a warning on the scorecard. Reads the
 * FULL consensus path (d.epsForecasts, up to 5 years), not the 4-year
 * slice the trajectory chart draws; fiscal labels come from the data.
 * EPS of exactly 0 counts as not profitable. Fires when the first
 * profitable projected year is the 5th or later, or when no projected
 * year is profitable in any available forecast path containing at
 * least one projected year — including paths covering under 4 years.
 * No forecast data stays silent, and an already-profitable company
 * never fires (a later dip is the cliff check's job). Display only —
 * no score reads this. */
function epsProfitWarning(d) {
  if (!isNum(d.epsTTM) || d.epsTTM > 0) return null;
  var fc = (d.epsForecasts || []).filter(function (f) { return f && isNum(f.eps); });
  var label = function (f) { return 'FY' + String(f.fiscalEnd || '').replace(/^[A-Za-z]+\s+/, ''); };
  var firstProfit = -1;
  for (var i = 0; i < fc.length; i++) { if (fc[i].eps > 0) { firstProfit = i; break; } }
  if (firstProfit >= 4) {
    return 'Not projected to be profitable for at least 4 more years — consensus EPS stays negative through ' +
      label(fc[firstProfit - 1]) + '; first profit projected ' + label(fc[firstProfit]) + '.';
  }
  if (firstProfit === -1 && fc.length >= 1) {
    return 'Not projected to be profitable in any year analysts cover — consensus EPS stays negative through ' +
      label(fc[fc.length - 1]) + ', the last year forecast.';
  }
  return null;
}

/* Justin's boom-bust rule (2026-10-26): when the EPS cliff check fires
 * AND revenue doubled (actual or projected) within the 2 years leading
 * up to the revenue top, the name carries peak-cycle risk — the classic
 * value trap. Returns null when the pattern can't be tested. */
function boomBust(d) {
  var rp = d.revPath || [];
  if (rp.length < 3) return null;
  var top = 0;
  for (var i = 1; i < rp.length; i++) { if (rp[i].rev > rp[top].rev) top = i; }
  if (top < 2) return { testable: true, fires: false, ratio: null, topLabel: rp[top].label };
  var ratio = rp[top].rev / rp[top - 2].rev;
  var cliff = epsCliffInfo(d);
  var possibleCliff = cliff ? null : epsPossibleCliff(d);
  return {
    testable: true,
    fires: !!((cliff || possibleCliff) && ratio >= 2),
    ratio: ratio,
    topLabel: rp[top].label,
    projected: rp[top].est,
    cliff: cliff,
    possibleCliff: possibleCliff
  };
}

/* Yearly fundamentals on the record, from the Charts tool's annual
 * statements (day-cached): one entry per fiscal year, ascending, with
 * EPS and gross/operating margin derived from the statements. Feeds
 * the cyclical severity overlay. */
function buildYearly(d, qm) {
  if (!qm || !qm.periods) return;
  var byYear = {};
  qm.periods.forEach(function (p, i) {
    var m = String(p).match(/(\d{4})/);
    if (!m) return;
    var rev = qm.revenue ? qm.revenue[i] : null;
    var yr = parseInt(m[1], 10);
    byYear[yr] = {
      year: yr, rev: rev,
      eps: qm.eps ? qm.eps[i] : null,
      gm: (qm.grossProfit && isNum(qm.grossProfit[i]) && isNum(rev) && rev > 0) ? qm.grossProfit[i] / rev * 100 : null,
      om: (qm.operIncome && isNum(qm.operIncome[i]) && isNum(rev) && rev > 0) ? qm.operIncome[i] / rev * 100 : null
    };
  });
  var yrs = Object.keys(byYear).map(function (k) { return byYear[k]; }).sort(function (a, b) { return a.year - b.year; });
  if (yrs.length) d.yearly = yrs;
}

/* Cyclical-overlay data cache (2026-11-01): yearly statements are
 * the one expensive input to the severity overlay, so each ticker's
 * built yearly series + revenue path is cached for the day and
 * shared by the scorecard, the watchlist and the scan enrichment.
 * fetchQMetrics has its own day cache underneath; this layer caches
 * the BUILT shapes so repeat readers skip the network entirely. */
var CYC_KEY = 'sr_cyc_v1';
/* Revenue path from the annual-statements payload: reported years
 * from the statements plus StockAnalysis' forecast years, shaped
 * like parseSAForecast's output ({label, rev, est}); a reported
 * year wins over a forecast for the same label. */
function revPathFromQm(qm) {
  if (!qm || !qm.periods) return null;
  var byLabel = {};
  qm.periods.forEach(function (p, i) {
    var m = String(p).match(/(\d{4})/);
    if (!m) return;
    var rev = qm.revenue ? qm.revenue[i] : null;
    if (isNum(rev) && rev > 0) byLabel['FY' + m[1]] = { label: 'FY' + m[1], rev: rev, est: false };
  });
  var est = (qm.est && qm.est.revenue) || [];
  est.forEach(function (e) {
    var m = String(e.plabel || '').match(/(\d{4})/);
    if (!m) return;
    var label = 'FY' + m[1];
    if (!byLabel[label] && isNum(e.value) && e.value > 0) byLabel[label] = { label: label, rev: e.value, est: true };
  });
  var out = Object.keys(byLabel).map(function (k) { return byLabel[k]; });
  out.sort(function (a, b) { return a.label < b.label ? -1 : a.label > b.label ? 1 : 0; });
  return out.length >= 3 ? out : null;
}
function cycCachePeek(T) {
  var all = lsGet(CYC_KEY, {});
  var hit = all && all[T];
  if (hit && hit.day === new Date().toDateString() && hit.yearly) return hit;
  return null;
}
/* Latest balance-sheet snapshot from a yearly metrics pull: cash &
 * investments, total debt and net cash (debt) at the most recent
 * reported period, for the scorecard's Cash & debt section. Net
 * falls back to cash - debt when StockAnalysis' own net row is
 * missing at that period. */
function bsLatestFromQm(qm) {
  if (!qm || !qm.periods) return null;
  for (var i = qm.periods.length - 1; i >= 0; i--) {
    var cash = qm.bsCash ? qm.bsCash[i] : null;
    var debt = qm.bsDebt ? qm.bsDebt[i] : null;
    if (!isNum(cash) && !isNum(debt)) continue;
    var net = qm.bsNet ? qm.bsNet[i] : null;
    if (!isNum(net) && isNum(cash) && isNum(debt)) net = cash - debt;
    return { cash: isNum(cash) ? cash : null, debt: isNum(debt) ? debt : null,
      net: isNum(net) ? net : null, period: qm.periods[i] || '' };
  }
  return null;
}

async function cycLoadYearly(T) {
  var hit = cycCachePeek(T);
  if (hit && hit.bs) return { yearly: hit.yearly, revPath: hit.revPath || null, bs: hit.bs };
  try {
    var qm = await fetchQMetrics(T, 'y');
    if (!qm) return null;
    var tmp = {};
    buildYearly(tmp, qm);
    if (!tmp.yearly) return null;
    var rp = revPathFromQm(qm);
    var bs = bsLatestFromQm(qm);
    var all = lsGet(CYC_KEY, {});
    all[T] = { day: new Date().toDateString(), yearly: tmp.yearly, revPath: rp, bs: bs };
    lsSet(CYC_KEY, all);
    return { yearly: tmp.yearly, revPath: rp, bs: bs };
  } catch (e) { return null; }
}

/* True trailing EPS growth (the Finviz stock page's 'EPS Y/Y TTM')
 * for the scan's top-25 enrichment (Justin's call, 2026-11-01): the
 * screener's epsYoY is current-fiscal-year growth -- a different,
 * much smaller number -- while the severity growth signal and the
 * cheap-P/E trap are calibrated to the TTM figure the scorecard
 * uses. Fetching it for the 25 finalists makes the list and the
 * scorecard agree. Day-cached in the same sr_cyc_v1 entry. */
async function cycLoadTtmGrowth(T) {
  var all0 = lsGet(CYC_KEY, {});
  var hit = all0 && all0[T];
  if (hit && hit.day === new Date().toDateString() && isNum(hit.epsG)) return hit.epsG;
  try {
    var html = await relayFetch('https://finviz.com/stock?t=' + encodeURIComponent(T), {
      timeout: 20000,
      validate: function (t) { return t.indexOf('snapshot-td-label') !== -1; }
    });
    var g = parseNum(parseFinviz(html)['EPS Y/Y TTM']);
    if (!isNum(g)) return null;
    var all = lsGet(CYC_KEY, {});
    var cur = all[T] || { day: new Date().toDateString() };
    cur.epsG = g;
    all[T] = cur;
    lsSet(CYC_KEY, all);
    return g;
  } catch (e) { return null; }
}

/* Fresh EPS growth outlook for a scan finalist (2026-11-07, Justin's
 * ask after the Allstate miss): the same Nasdaq consensus FY pair the
 * scorecard uses (next fiscal year vs this fiscal year). The morning
 * re-rank re-scores the stored dataset, whose screener growth figure
 * can be days old; an earnings print in between flips it (Allstate's
 * went from strongly positive to -24% after its Nov 4 report), and
 * because the figure feeds BOTH scores (15 pts of Value, 20 pts of
 * Risk), one stale input swung its list score by 18 points. Day-
 * cached in the same sr_cyc_v1 entry as the TTM growth. */
/* The StockAnalysis forecast page's summary sentences carry an EPS
 * pair -- "EPS This Year 0.22 from 5.66 ..." / "EPS Next Year 3.75
 * from 0.22 ..." -- the same fiscal-year-over-fiscal-year definition
 * as the Nasdaq pair. Fallback outlook source when Nasdaq publishes
 * no yearly forecast (added 2026-11-10). */
function parseSAEpsSummary(html) {
  if (!html) return null;
  var txt = String(html).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  function grab(which) {
    var m = txt.match(new RegExp('EPS ' + which + ' Year\\s+(-?[\\d.]+)\\s+from\\s+-?[\\d.]+'));
    return m ? parseFloat(m[1]) : null;
  }
  var cur = grab('This'), nxt = grab('Next');
  return (isNum(cur) && isNum(nxt) && cur > 0) ? { cur: cur, nxt: nxt } : null;
}

async function cycLoadGrowthOutlook(T) {
  var all0 = lsGet(CYC_KEY, {});
  var hit = all0 && all0[T];
  if (hit && hit.epsNDay === new Date().toDateString() && isNum(hit.epsN)) return hit.epsN;
  try {
    var fc = await relayJSON('https://api.nasdaq.com/api/analyst/' + encodeURIComponent(T) + '/earnings-forecast?assetclass=stocks');
    var rows = ((fc && fc.data && fc.data.yearlyForecast && fc.data.yearlyForecast.rows) || [])
      .map(function (r) {
        return typeof r.consensusEPSForecast === 'number' ? r.consensusEPSForecast : parseNum(r.consensusEPSForecast);
      }).filter(function (v) { return isNum(v); });
    if (rows.length >= 2 && rows[0] > 0) {
      var g = (rows[1] / rows[0] - 1) * 100;
      var all = lsGet(CYC_KEY, {});
      var cur = all[T] || { day: new Date().toDateString() };
      cur.epsN = g;
      cur.epsNDay = new Date().toDateString();
      all[T] = cur;
      lsSet(CYC_KEY, all);
      return g;
    }
  } catch (e) { /* fall through to the StockAnalysis pair */ }
  try {
    var html = await relayFetch('https://stockanalysis.com/stocks/' + encodeURIComponent(T) + '/forecast/');
    var pair = parseSAEpsSummary(html);
    if (pair) {
      var g2 = (pair.nxt / pair.cur - 1) * 100;
      var all2 = lsGet(CYC_KEY, {});
      var cur2 = all2[T] || { day: new Date().toDateString() };
      cur2.epsN = g2;
      cur2.epsNDay = new Date().toDateString();
      all2[T] = cur2;
      lsSet(CYC_KEY, all2);
      return g2;
    }
  } catch (e) {}
  return null;
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/* Cyclical severity overlay (Justin's spec, 2026-11-01): how
 * peak-cycle the current numbers look versus the company's own
 * history. Four 0-1 signals, averaged over those with data:
 * (a) current gross (or operating) margin vs its 5-10yr average --
 *     0 at <=1.5x, 1 at >=2.5x;
 * (b) worst peak-to-trough annual EPS drawdown -- 0 at none, 1 at
 *     >=50% (down-year count kept for display);
 * (c) trailing EPS growth -- 0 at <=100%, 1 at >=300%;
 * (d) revenue surge -- path top vs 2 years before it, 0 at <=1.5x,
 *     1 at >=2x (replaces the old boom-bust revenue test).
 * GATE: severity counts only when at least two signals are >= 0.25.
 * A cyclical-sector industry (memory, semicap, energy, materials,
 * shipping, autos) multiplies a gated severity by 1.15 (cap 1); the
 * sector flag alone never creates severity. Under 5 years of EPS
 * history drops signals (a) and (b) and flags limited history. */
var CYC_SECTOR_RE = /memory|semiconductor equipment|oil|petroleum|energy|coal|shipping|marine|automotive|auto manufacturers|auto parts|steel|metals|metal|mining|chemical|materials|aluminum|copper|gold|silver/;
function cyclicalSeverity(d) {
  var yrs = d.yearly || [];
  var epsYrs = yrs.filter(function (y) { return isNum(y.eps); });
  var limited = epsYrs.length < 5;
  var sig = { margin: null, epsDD: null, epsGrowth: null, revSurge: null };
  var det = { limitedHistory: limited, histYears: epsYrs.length };
  if (!limited) {
    var gmS = yrs.filter(function (y) { return isNum(y.gm); }).map(function (y) { return y.gm; });
    var cur = isNum(d.grossMargin) ? d.grossMargin : (gmS.length ? gmS[gmS.length - 1] : null);
    var series = gmS, kind = 'gross';
    if (series.length < 3 || !isNum(cur)) {
      var omS = yrs.filter(function (y) { return isNum(y.om); }).map(function (y) { return y.om; });
      if (omS.length >= 3) { series = omS; cur = omS[omS.length - 1]; kind = 'operating'; }
    }
    if (series.length >= 3 && isNum(cur)) {
      var win = series.slice(-10);
      var avg = win.reduce(function (a, b) { return a + b; }, 0) / win.length;
      if (avg > 0) {
        det.marginRatio = cur / avg; det.marginCur = cur; det.marginAvg = avg; det.marginKind = kind;
        sig.margin = clamp01((det.marginRatio - 1.5) / 1.0);
      }
    }
    if (epsYrs.length >= 3) {
      var peak = -Infinity, worst = 0, down = 0;
      epsYrs.forEach(function (y, i) {
        if (i > 0 && y.eps < epsYrs[i - 1].eps) down++;
        if (y.eps > peak) peak = y.eps;
        else if (peak > 0) worst = Math.max(worst, (peak - y.eps) / peak);
      });
      det.ddPct = worst * 100; det.downYears = down;
      sig.epsDD = clamp01(worst / 0.5);
    }
  }
  if (isNum(d.epsGrowthTTM)) { det.epsG = d.epsGrowthTTM; sig.epsGrowth = clamp01((d.epsGrowthTTM - 100) / 200); }
  var rp = d.revPath || [];
  if (rp.length >= 3) {
    var top = 0;
    for (var ti = 1; ti < rp.length; ti++) { if (rp[ti].rev > rp[top].rev) top = ti; }
    if (top >= 2 && rp[top - 2].rev > 0) {
      det.revRatio = rp[top].rev / rp[top - 2].rev;
      sig.revSurge = clamp01((det.revRatio - 1.5) / 0.5);
    }
  }
  var avail = [sig.margin, sig.epsDD, sig.epsGrowth, sig.revSurge].filter(isNum);
  var out = { signals: sig, detail: det, severity: 0, raw: null, gatePassed: false, sectorBoost: false, limitedHistory: limited, sigCount: 0, capped: false };
  if (!avail.length) return out;
  out.raw = avail.reduce(function (a, b) { return a + b; }, 0) / avail.length;
  if (avail.filter(function (v) { return v >= 0.25; }).length < 2) return out;
  out.gatePassed = true;
  var sev = out.raw;
  var txt = ((d.industry || '') + ' ' + (d.sector || '')).toLowerCase();
  if (CYC_SECTOR_RE.test(txt)) { sev = Math.min(1, sev * 1.15); out.sectorBoost = true; }
  /* Thin evidence caps confidence (Justin's call, 2026-11-01): with
   * fewer than three signals carrying data, severity cannot max out
   * -- it caps at 0.80. Two screaming signals on a short history
   * (SNDK: +786% growth and a revenue surge, with no margin or
   * drawdown record) still flag and cap the verdict, just not at a
   * perfect 1.00. */
  out.sigCount = avail.length;
  if (avail.length < 3 && sev > 0.8) { sev = 0.8; out.capped = true; }
  out.severity = sev;
  return out;
}

function riskScore(d, w) {
  var factors = [];
  /* pick(): first matching band wins. 'le' tables ascend (v <= limit);
   * 'ge' tables descend (v >= limit, or v > limit on a 'gt' row).
   * Returns the points AND which band matched, so the UI can show
   * the exact math behind every factor's points. mathFor() renders
   * that band as a sentence from the same table -- the words can
   * never drift from the numbers. */
  function pick(v, bands, ge) {
    for (var i = 0; i < bands.length; i++) {
      var hit = bands[i][2] === 'gt' ? v > bands[i][0] : (ge ? v >= bands[i][0] : v <= bands[i][0]);
      if (hit) return { pts: bands[i][1], idx: i };
    }
    return { pts: bands[bands.length - 1][1], idx: bands.length - 1 };
  }
  function limFmt(x) { return String(Math.round(x * 100) / 100); }
  function mathFor(display, bands, idx, ge, max, fmtL) {
    fmtL = fmtL || limFmt;
    var L = bands[idx][0], P = idx > 0 ? bands[idx - 1][0] : null, range;
    /* Plain words, no jargon (Justin's call, 2026-11-01): users do
     * not know what a "band" is, so the math reads as a sentence. */
    if (!ge) {
      if (idx === 0) range = fmtL(L) + ' or less';
      else if (!isFinite(L)) range = 'more than ' + fmtL(P);
      else range = 'more than ' + fmtL(P) + ', up to ' + fmtL(L);
    } else {
      var excl = bands[idx][2] === 'gt', pExcl = idx > 0 && bands[idx - 1][2] === 'gt';
      if (idx === 0) range = excl ? 'more than ' + fmtL(L) : fmtL(L) + ' or more';
      else if (!isFinite(L)) range = pExcl ? fmtL(P) + ' or less' : 'under ' + fmtL(P);
      else range = (excl ? 'more than ' + fmtL(L) : fmtL(L) + ' or more') + (pExcl ? ', up to ' : ', under ') + fmtL(P);
    }
    return display + ' \u2192 ' + range + ' \u2192 ' + bands[idx][1] + ' of ' + max + ' pts';
  }
  function add(name, value, display, max, pk, note, bands, ge, fmtL) {
    factors.push({ name: name, value: value, display: display, max: max, pts: pk.pts, note: note || '', math: mathFor(display, bands, pk.idx, ge, max, fmtL) });
  }
  function pctL(x) { return limFmt(x) + '%'; }
  if (isNum(d.beta) && d.beta > 0) {
    var bBeta = [[0.5, 1], [0.8, 3], [1, 4], [1.3, 6], [1.6, 8], [2, 9], [Infinity, 10]];
    add('Beta (volatility)', d.beta, fmtNum(d.beta, 2), 10,
      pick(d.beta, bBeta, false), 'How hard the stock swings vs the market', bBeta, false);
  }
  if (isNum(d.debtEq) && d.debtEq >= 0) {
    var bDe = [[0.1, 0], [0.4, 5], [0.8, 10], [1.5, 15], [3, 19], [Infinity, 25]];
    add('Debt / Equity', d.debtEq, fmtNum(d.debtEq, 2), 25,
      pick(d.debtEq, bDe, false), 'More debt = less room when things go wrong', bDe, false);
  }
  if (isNum(d.profitMargin)) {
    var bPm = [[-10, 20], [0, 17], [5, 13], [10, 9], [15, 4], [25, 3], [Infinity, 0]];
    add('Profit margin', d.profitMargin, fmtNum(d.profitMargin, 1) + '%', 20,
      pick(d.profitMargin, bPm, false), 'Loss-making means no cushion', bPm, false, pctL);
  }
  if (isNum(d.marketCap) && d.marketCap > 0) {
    var bSize = [[2e9, 15], [1e10, 12], [5e10, 8], [2e11, 3], [Infinity, 0]];
    add('Company size', d.marketCap, fmtCap(d.marketCap), 15,
      pick(d.marketCap, bSize, false), 'Small companies fail more often than giants', bSize, false, fmtCap);
  }
  if (isNum(d.epsGrowthNextY)) {
    var bEps = [[-25, 20], [-10, 16], [0, 11], [10, 4], [25, 1], [Infinity, 0]];
    add('EPS trend, next yr', d.epsGrowthNextY, fmtPct(d.epsGrowthNextY), 20,
      pick(d.epsGrowthNextY, bEps, false), 'Falling earnings are where the danger starts', bEps, false, pctL);
  }
  if (isNum(d.currentRatio) && d.currentRatio > 0) {
    var bCr = [[0.8, 10], [1, 8], [1.5, 5], [2, 3], [Infinity, 0]];
    add('Current ratio', d.currentRatio, fmtNum(d.currentRatio, 2), 10,
      pick(d.currentRatio, bCr, false), 'Can it pay its near-term bills?', bCr, false);
  }
  applyWeights(factors, resolveWeights(w).risk);
  var got = factors.reduce(function (s, f) { return s + f.pts; }, 0);
  var maxAvailable = factors.reduce(function (s, f) { return s + f.max; }, 0);
  // The six factors' weights sum to a true 100 (Justin's call,
  // 2026-11-01, superseding the morning's keep-the-dead-20 choice):
  // Beta 10, Debt/Equity 25, Profit margin 20, Company size 15,
  // EPS trend 20, Current ratio 10. The denominator is simply the
  // points available from the factors that have data.
  var base = maxAvailable > 0 ? Math.round(got / maxAvailable * 100) : null;
  // Cyclical overlay (2026-11-01): final = base + (100 - base) x
  // severity x 0.6. Severity 0 leaves the base untouched, exactly.
  var cyc = cyclicalSeverity(d);
  var score = base;
  if (base != null && cyc.severity > 0) score = Math.round(base + (100 - base) * cyc.severity * 0.6);
  var verdict = null;
  if (score != null) verdict = score <= 25 ? 'Low risk' : score <= 45 ? 'Moderate risk' : score <= 65 ? 'Elevated risk' : 'High risk';
  return { factors: factors, got: got, maxAvailable: maxAvailable, base: base, score: score, verdict: verdict, cyc: cyc, cycAdj: base != null ? score - base : null };
}

function valueScreen(d) {
  return [
    { label: 'Market cap over $5B', test: isNum(d.marketCap) ? (d.marketCap > 5e9) : null, value: fmtCap(d.marketCap) },
    { label: 'Forward P/E under 10', test: isNum(d.forwardPE) ? (d.forwardPE < 10) : null, value: isNum(d.forwardPE) ? fmtNum(d.forwardPE, 2) : '—' },
    { label: 'PEG under 0.75', test: isNum(d.peg) ? (d.peg < 0.75) : null, value: isNum(d.peg) ? fmtNum(d.peg, 2) : '—' },
    { label: '25%+ below 52-wk high', test: isNum(d.pctBelowHigh) ? (d.pctBelowHigh >= 25) : null, value: isNum(d.pctBelowHigh) ? fmtNum(d.pctBelowHigh, 1) + '% below' : '—' },
    { label: 'Not a cheap-P/E trap', test: (isNum(d.forwardPE) && isNum(d.epsGrowthTTM)) ? !cheapPeTrap(d) : null, value: cheapPeTrap(d) ? 'Fwd P/E ' + fmtNum(d.forwardPE, 1) + ' \u00b7 EPS +' + fmtNum(d.epsGrowthTTM, 0) + '% \u2014 peak earnings?' : ((isNum(d.forwardPE) && isNum(d.epsGrowthTTM)) ? 'No trap pattern' : '—') }
  ];
}

/* Risk screen: the mirror of the value screen — binary safety checks
 * where a pass means the check is CLEAR. Same chip treatment; unknown
 * data shows '?' and never guesses. (Justin's ask, 2026-10-26.) */
function riskScreen(d) {
  var cyc = cyclicalSeverity(d);
  var cycTestable = !!(cyc && cyc.raw !== null && cyc.raw !== undefined);
  return [
    { label: 'Debt / Equity at or under 1', test: isNum(d.debtEq) ? (d.debtEq <= 1) : null, value: isNum(d.debtEq) ? fmtNum(d.debtEq, 2) : '\u2014' },
    { label: 'Profitable (margin above 0)', test: isNum(d.profitMargin) ? (d.profitMargin > 0) : null, value: isNum(d.profitMargin) ? fmtNum(d.profitMargin, 1) + '%' : '\u2014' },
    { label: 'Current ratio at or above 1', test: isNum(d.currentRatio) ? (d.currentRatio >= 1) : null, value: isNum(d.currentRatio) ? fmtNum(d.currentRatio, 2) : '\u2014' },
    { label: 'Beta at or under 1.5', test: isNum(d.beta) ? (d.beta <= 1.5) : null, value: isNum(d.beta) ? fmtNum(d.beta, 2) : '\u2014' },
    { label: 'EPS growing next year', test: isNum(d.epsGrowthNextY) ? (d.epsGrowthNextY >= 0) : null, value: isNum(d.epsGrowthNextY) ? fmtPct(d.epsGrowthNextY) : '\u2014' },
    { label: 'No cyclical earnings peak', test: cycTestable ? (cyc.severity < 0.5) : null, value: cycTestable ? 'Severity ' + fmtNum(cyc.severity, 2) + ' of 1' : '\u2014' }
  ];
}

/* EPS trajectory: TTM actual + consensus forecasts; cliff = a later year
 * falls 10%+ below the running peak, or next year drops vs TTM. */
function epsTrajectory(d) {
  var pts = epsPoints(d);
  var warning = null;
  if (pts.length >= 2) {
    var peak = -Infinity, peakLabel = '';
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].kind !== 'est') continue; // future peaks only -- see epsCliffInfo
      if (pts[i].eps > peak) { peak = pts[i].eps; peakLabel = pts[i].label; }
      else if (peak > 0 && pts[i].eps < peak * 0.90) {
        warning = 'Earnings cliff in consensus: EPS peaks at ' + fmtNum(peak) + ' (' + peakLabel +
          ') then falls to ' + fmtNum(pts[i].eps) + ' by ' + pts[i].label + ' (' +
          fmtPct((pts[i].eps / peak - 1) * 100) + '). Cheap multiples on peak earnings are how value traps happen — check whether the peak is cyclical.';
        break;
      }
    }
    if (!warning) {
      var pc = epsPossibleCliff(d);
      if (pc) {
        warning = pc.lookback
          ? 'Possible cliff — only 2 years of estimates. EPS already exploded ' + fmtPct(pc.gB, 0) + ' vs ' + pc.lookback + ', and growth inside the window is fading (' + fmtPct(pc.g1, 0) + ' next year, then ' + fmtPct(pc.g2, 0) + '). The peak may sit just past the forecast window, so this counts as a cliff.'
          : 'Possible cliff — only 2 years of estimates. EPS explodes ' + fmtPct(pc.g1, 0) + ' next year (' + pc.fy1Label +
            '), then growth slows to ' + fmtPct(pc.g2, 0) + ' (' + pc.fy2Label + '). The peak may sit just past the forecast window, so this counts as a cliff.';
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
  if (min < 0) padB = 38;
  var bw = (w - padX * 2) / pts.length;
  var zeroY = padT + (max / span) * (h - padT - padB);
  // The TTM (actual) bar and the value labels use CSS variables
  // (--chart-actual / --chart-val) rather than baked-in hex: variables
  // follow the live theme, so switching dark/light after the chart is
  // drawn can never strand pale-on-white (or dark-on-black) paint. 
  var out = '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="EPS trajectory chart">';
  out += '<line x1="' + padX + '" y1="' + zeroY + '" x2="' + (w - padX) + '" y2="' + zeroY + '" stroke="#d8c98f" stroke-width="1"/>';
  pts.forEach(function (p, i) {
    var bh = Math.abs(p.eps) / span * (h - padT - padB);
    var x = padX + i * bw + bw * 0.16, bwid = bw * 0.68;
    var y = p.eps >= 0 ? zeroY - bh : zeroY;
    var fillAttr = p.kind === 'actual' ? 'style="fill:var(--chart-actual)"' : 'fill="url(#goldGrad)"';
    out += '<rect x="' + x + '" y="' + y + '" width="' + bwid + '" height="' + Math.max(bh, 1.5) + '" rx="4" ' + fillAttr + '/>';
    var vy = p.eps >= 0 ? y - 5 : y + bh + 13;
    out += '<text x="' + (x + bwid / 2) + '" y="' + vy + '" text-anchor="middle" font-size="12.5" font-weight="800" style="fill:var(--chart-val)">' + fmtNum(p.eps, Math.abs(p.eps) >= 100 ? 0 : 2) + '</text>';
    out += '<text x="' + (x + bwid / 2) + '" y="' + (h - 8) + '" text-anchor="middle" font-size="11.5" font-weight="700" fill="#77705f">' + esc(p.label) + (p.kind === 'est' ? ' est' : '') + '</text>';
  });
  out += '<defs><linearGradient id="goldGrad" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0%" stop-color="#B46A11"/><stop offset="33%" stop-color="#D68D15"/>' +
    '<stop offset="68%" stop-color="#E7AC18"/><stop offset="99%" stop-color="#F8C73D"/></linearGradient></defs>';
  out += '</svg>';
  return out;
}
/* ================= price chart: pinch-zoom time window =================
 * Justin's ask (2026-11-07): pinch to zoom in and out on TIME and get
 * rid of the static 1Y / 5Y / 10Y / ALL buttons. The chart now shows a
 * time window over a ladder of series -- daily bars for the last year,
 * weekly for 5 years, monthly for all time. The finest tier covering
 * the window draws it; a coarser tier stands in until a finer one has
 * loaded. One finger still scrubs; two fingers pinch (and drag) the
 * window; the mouse wheel zooms on desktop; double-tap resets to the
 * default 1-year view. The window never extends past the data that
 * has actually loaded -- the ladder fetches run in the background, so
 * zooming out unlocks as the longer history lands. */
var PX_MIN_SPAN = 10 * 86400; // seconds: never zoom past ~10 days
var PX_TIERS = [ // finest first; wantSpan = the widest window this tier should draw
  { key: 'histD', tsKey: 'histDTs', range: '1y', interval: '1d', wantSpan: 370 * 86400 },
  { key: 'history', tsKey: 'historyTs', range: null, interval: null, wantSpan: 370 * 86400 },
  { key: 'hist5w', tsKey: 'hist5wTs', range: '5y', interval: '1wk', wantSpan: 5 * 366 * 86400 },
  { key: 'histMax', tsKey: 'histMaxTs', range: 'max', interval: '1mo', wantSpan: Infinity }
];
var PX_MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var scWin = null;       // {start, end} epoch seconds; null = default window
var scWinTicker = null; // the ticker scWin belongs to

function pxTierSeries(d, tier) {
  var closes = d[tier.key], ts = d[tier.tsKey];
  if (!closes || !ts || closes.length < 2 || ts.length !== closes.length) return null;
  return { tier: tier, closes: closes, ts: ts };
}
function pxDesiredTier(span) {
  for (var i = 0; i < PX_TIERS.length; i++) { if (span <= PX_TIERS[i].wantSpan) return PX_TIERS[i]; }
  return PX_TIERS[PX_TIERS.length - 1];
}
function pxBounds(d) {
  var start = null, end = null;
  PX_TIERS.forEach(function (tier) {
    var s = pxTierSeries(d, tier);
    if (!s) return;
    if (start == null || s.ts[0] < start) start = s.ts[0];
    if (end == null || s.ts[s.ts.length - 1] > end) end = s.ts[s.ts.length - 1];
  });
  return start == null ? null : { start: start, end: end };
}
function pxPickSeries(d, win) {
  var longest = null;
  for (var i = 0; i < PX_TIERS.length; i++) {
    var s = pxTierSeries(d, PX_TIERS[i]);
    if (!s) continue;
    var span = s.ts[s.ts.length - 1] - s.ts[0];
    if (!longest || span > longest.span) longest = { s: s, span: span };
    if (s.ts[0] <= win.start + 172800 && s.ts[s.ts.length - 1] >= win.end - 172800) return s;
  }
  return longest ? longest.s : null;
}
function pxDefaultWin(d) {
  var b = pxBounds(d);
  if (!b) return null;
  return { start: Math.max(b.start, b.end - 365 * 86400), end: b.end };
}
function pxClampWin(d, win) {
  var b = pxBounds(d);
  if (!b || !win) return win;
  var maxSpan = Math.max(b.end - b.start, PX_MIN_SPAN);
  var span = Math.min(Math.max(win.end - win.start, PX_MIN_SPAN), maxSpan);
  var start = win.start, end = start + span;
  if (start < b.start) { start = b.start; end = start + span; }
  if (end > b.end) { end = b.end; start = end - span; }
  if (start < b.start) start = b.start;
  return { start: start, end: end };
}
function pxSpanLabel(win, d) {
  var span = win.end - win.start;
  /* "All time" only when the window covers the full-history series
   * itself -- with just the 1-year series loaded, the plain bounds
   * would mislabel the default view as all time. */
  var full = pxTierSeries(d, PX_TIERS[PX_TIERS.length - 1]);
  if (full && win.start <= full.ts[0] + 172800 && win.end >= full.ts[full.ts.length - 1] - 172800) return 'All time';
  var days = span / 86400;
  if (days >= 350 && days <= 380) return '1 year';
  if (days >= 730) { var yrs = Math.round(days / 365.25 * 10) / 10; return (yrs % 1 === 0 ? String(Math.round(yrs)) : String(yrs)) + ' years'; }
  if (days >= 60) return Math.round(days / 30.44) + ' months';
  if (days >= 14) return Math.round(days / 7) + ' weeks';
  return Math.max(1, Math.round(days)) + ' days';
}
function pxDateLabel(ts, spanDays) {
  var dt = new Date(ts * 1000);
  if (spanDays > 400) return PX_MONS[dt.getMonth()] + ' ' + dt.getFullYear();
  return PX_MONS[dt.getMonth()] + ' ' + dt.getDate() + ', ' + dt.getFullYear();
}
/* Slice the picked series to the window, keeping one point just
 * outside each edge so the line always spans the full width. */
function pxSlice(d, win) {
  var s = pxPickSeries(d, win);
  if (!s) return null;
  var before = null, after = null, inside = [];
  for (var i = 0; i < s.closes.length; i++) {
    var ts = s.ts[i];
    if (ts < win.start) { before = { ts: ts, c: s.closes[i] }; continue; }
    if (ts > win.end) { after = { ts: ts, c: s.closes[i] }; break; }
    inside.push({ ts: ts, c: s.closes[i] });
  }
  var pts = (before ? [before] : []).concat(inside, after ? [after] : []);
  return { tier: s.tier, pts: pts, inside: inside, series: s };
}
/* Fetch one ladder tier from Yahoo (mirrors the old ensureRangeHist:
 * stored on the record and written through to the quote cache).
 * Concurrent calls share one flight; a settled flight clears its key
 * so a failure can be retried by the next gesture. */
function pxEnsureTier(d, tier) {
  if (!tier.range) return Promise.resolve(!!pxTierSeries(d, tier));
  if (pxTierSeries(d, tier)) return Promise.resolve(true);
  d._pxLoad = d._pxLoad || {};
  if (d._pxLoad[tier.key]) return d._pxLoad[tier.key];
  var p = (async function () {
    try {
      var ch = await relayJSON('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(d.ticker) + '?range=' + tier.range + '&interval=' + tier.interval);
      var res = ch && ch.chart && ch.chart.result && ch.chart.result[0];
      if (!res) return false;
      var rawCloses = (res.indicators && res.indicators.quote && res.indicators.quote[0].close) || [];
      var rawTs = res.timestamp || [];
      var closes = [], tsArr = [];
      rawCloses.forEach(function (c, i) { if (isNum(c)) { closes.push(c); tsArr.push(rawTs[i] || null); } });
      if (closes.length < 2 || tsArr.some(function (t) { return !isNum(t); })) return false;
      d[tier.key] = closes;
      d[tier.tsKey] = tsArr;
      try {
        var cache = lsGet(CACHE_KEY, {});
        if (cache[d.ticker] && cache[d.ticker].data) {
          cache[d.ticker].data[tier.key] = closes;
          cache[d.ticker].data[tier.tsKey] = tsArr;
          lsSet(CACHE_KEY, cache);
        }
      } catch (e) {}
      return true;
    } catch (e) { return false; }
  })();
  d._pxLoad[tier.key] = p;
  p.then(function () { if (d._pxLoad) delete d._pxLoad[tier.key]; });
  return p;
}
function pxRightLabel(d, win, slice) {
  var b = pxBounds(d);
  var spanDays = (win.end - win.start) / 86400;
  var lastPt = slice.pts[slice.pts.length - 1];
  if (b && win.end >= b.end - 3600) {
    var sc = slice.series.closes;
    return 'now \u00b7 ' + fmtNum(sc[sc.length - 1]);
  }
  var near = slice.inside.length ? slice.inside[slice.inside.length - 1] : lastPt;
  return pxDateLabel(win.end, spanDays) + (near ? ' \u00b7 ' + fmtNum(near.c) : '');
}
function pxChartSVG(d, win, slice) {
  var W = 640, H = 343, padT = 16, padB = 20, padX = 6; // 30% taller (2026-11-07: 264 -> 343)
  var pts = slice.pts;
  var max = -Infinity, min = Infinity;
  pts.forEach(function (p) { if (p.c > max) max = p.c; if (p.c < min) min = p.c; });
  var spanY = (max - min) || 1;
  var X = function (ts) { return padX + (ts - win.start) / (win.end - win.start) * (W - padX * 2); };
  var Y = function (v) { return padT + (max - v) / spanY * (H - padT - padB); };
  var line = pts.map(function (p) { return X(p.ts).toFixed(1) + ',' + Y(p.c).toFixed(1); }).join(' ');
  var spanDays = (win.end - win.start) / 86400;
  var out = '<svg class="px-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Price chart">';
  if (isNum(d.high52) && spanDays <= 400) {
    var hy = Y(Math.min(d.high52, max));
    out += '<g class="px-hi52"><line class="px-hi-line" x1="' + padX + '" y1="' + hy + '" x2="' + (W - padX) + '" y2="' + hy + '" stroke="#B46A11" stroke-width="1.4" stroke-dasharray="5 4"/>' +
      '<text class="px-hi-lab" x="' + (W - padX) + '" y="' + (hy - 4) + '" text-anchor="end" font-size="11" font-weight="800" fill="#B46A11">52-wk high ' + fmtNum(d.high52, 0) + '</text></g>';
  }
  out += '<polyline class="px-line" points="' + line + '" fill="none" style="stroke:var(--chart-line)" stroke-width="2.2" stroke-linejoin="round"/>';
  out += '<text class="px-lab-l" x="' + padX + '" y="' + (H - 5) + '" font-size="11" font-weight="700" fill="#77705f">' + pxDateLabel(win.start, spanDays) + '</text>' +
    '<text class="px-lab-r" x="' + (W - padX) + '" y="' + (H - 5) + '" text-anchor="end" font-size="11" font-weight="700" fill="#77705f">' + pxRightLabel(d, win, slice) + '</text>';
  out += '<g class="px-scrub" style="display:none"><line class="px-scrub-line" y1="' + padT + '" y2="' + (H - padB) + '" stroke-width="1" stroke-dasharray="4 4" style="stroke:var(--muted)"/>' +
    '<circle class="px-scrub-halo" r="11" style="fill:var(--chart-line)" opacity=".18"/><circle class="px-scrub-dot" r="5.6" style="fill:var(--chart-line)" stroke="#0d0d0f" stroke-width="1.6"/></g>' +
    '<rect class="px-scrub-zone" x="0" y="0" width="' + W + '" height="' + (H - padB + 4) + '" fill="transparent" style="touch-action:none"/>';
  out += '</svg>';
  return out;
}

function renderScChart(d) {
  var box = $('sc-chart-box');
  if (!box) return;
  if (scWinTicker !== d.ticker) { scWin = null; scWinTicker = d.ticker; }
  if (!d.history || d.history.length < 2) {
    box.innerHTML = '<div class="status">Price history is not available for this one.</div>';
    return;
  }
  if (!scWin) scWin = pxDefaultWin(d);
  scWin = pxClampWin(d, scWin);
  var label = $('sc-range-label');
  if (label) label.textContent = pxSpanLabel(scWin, d);
  var slice = pxSlice(d, scWin);
  if (!slice || slice.pts.length < 2) {
    box.innerHTML = '<div class="status">No prices in this window.</div>';
    return;
  }
  box.innerHTML = '<div id="sc-chart-read" class="pf-bench-read">Drag to scrub \u00b7 pinch to zoom the time range.</div>' +
    '<div class="chart-wrap">' + pxChartSVG(d, scWin, slice) + '</div>';
  bindPriceChart(d);
  // Ladder upkeep: fetch the tier this span wants, and the full
  // history (it sets the zoom-out limit), in the background. If a
  // finer tier lands for the current window, redraw with it.
  var drawnTier = slice.tier;
  [pxDesiredTier(scWin.end - scWin.start), PX_TIERS[PX_TIERS.length - 1]].forEach(function (tier) {
    if (!tier.range || pxTierSeries(d, tier)) return;
    pxEnsureTier(d, tier).then(function (ok) {
      if (!ok || lastStock !== d) return;
      scWin = pxClampWin(d, scWin);
      var now = pxPickSeries(d, scWin);
      if (now && now.tier !== drawnTier) renderScChart(d);
    });
  });
}

/* Gestures for the scorecard price chart: one finger scrubs (dashed
 * crosshair + readout), two fingers pinch the time window (spread =
 * zoom in on a shorter span, together = zoom out; the window follows
 * the pinch center, so a two-finger drag pans through time too).
 * During a pinch the existing SVG is updated in place -- rebuilding
 * it would destroy the element holding the pointer capture. A full
 * re-render happens once, when the gesture ends, if a finer data
 * tier is needed. Double-tap resets to the 1-year default. */
/* Haptic feedback for chart gestures. A web app cannot ring the
 * Taptic Engine directly: Android honours navigator.vibrate, while
 * on iOS the only web route is toggling a native switch control,
 * which makes the system emit its selection tick — so a hidden
 * switch input is kept around for that. Best-effort and
 * rate-limited; unsupported platforms simply stay silent. */
var _hapticSw = null, _hapticLast = 0;
function hapticTick() {
  var now = Date.now();
  if (now - _hapticLast < 25) return;
  _hapticLast = now;
  try {
    if (navigator.vibrate) { navigator.vibrate(8); return; }
    if (typeof document === 'undefined' || !document.createElement || !document.body) return;
    if (!_hapticSw) {
      var sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.setAttribute('switch', '');
      sw.setAttribute('aria-hidden', 'true');
      sw.tabIndex = -1;
      sw.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
      document.body.appendChild(sw);
      _hapticSw = sw;
    }
    _hapticSw.click();
  } catch (e) {}
}
function bindPriceChart(d) {
  var wrap = $('score-result');
  if (!wrap) return;
  var svg = wrap.querySelector('.px-chart');
  if (!svg) return;
  var zone = svg.querySelector('.px-scrub-zone');
  var grp = svg.querySelector('.px-scrub');
  var read = $('sc-chart-read');
  if (!zone || !grp || !read) return;
  var poly = svg.querySelector('.px-line');
  var labL = svg.querySelector('.px-lab-l'), labR = svg.querySelector('.px-lab-r');
  var hiG = svg.querySelector('.px-hi52'), hiLine = svg.querySelector('.px-hi-line'), hiLab = svg.querySelector('.px-hi-lab');
  var line = grp.querySelector('.px-scrub-line'), dot = grp.querySelector('.px-scrub-dot'), halo = grp.querySelector('.px-scrub-halo');
  var W = 640, H = 343, padT = 16, padB = 20, padX = 6; // 30% taller (2026-11-07: 264 -> 343)
  var HINT = 'Drag to scrub \u00b7 pinch to zoom the time range.';
  var slice = pxSlice(d, scWin);
  if (!slice) return;
  var pointers = new Map();
  var mode = 'idle'; // 'scrub' | 'pinch'
  var pinch0 = null, downInfo = null, lastTap = 0, wheelTimer = null;
  var pinched = false; // a pinch happened during this touch sequence
  var lastScrubTs = null, lastScrubTick = 0; // haptic ratchet state

  function geom(sl) {
    var max = -Infinity, min = Infinity;
    sl.pts.forEach(function (p) { if (p.c > max) max = p.c; if (p.c < min) min = p.c; });
    var spanY = (max - min) || 1;
    return {
      X: function (ts) { return padX + (ts - scWin.start) / (scWin.end - scWin.start) * (W - padX * 2); },
      Y: function (v) { return padT + (max - v) / spanY * (H - padT - padB); },
      max: max, min: min
    };
  }
  function spanDays() { return (scWin.end - scWin.start) / 86400; }
  function redraw() {
    if (!slice) return;
    var g = geom(slice);
    poly.setAttribute('points', slice.pts.map(function (p) { return g.X(p.ts).toFixed(1) + ',' + g.Y(p.c).toFixed(1); }).join(' '));
    if (labL) labL.textContent = pxDateLabel(scWin.start, spanDays());
    if (labR) labR.textContent = pxRightLabel(d, scWin, slice);
    if (hiG && hiLine && hiLab) {
      if (isNum(d.high52) && spanDays() <= 400) {
        var hy = g.Y(Math.min(d.high52, g.max));
        hiG.style.display = '';
        hiLine.setAttribute('y1', hy); hiLine.setAttribute('y2', hy);
        hiLab.setAttribute('y', hy - 4);
      } else hiG.style.display = 'none';
    }
    var label = $('sc-range-label');
    if (label) label.textContent = pxSpanLabel(scWin, d);
  }
  function applyWin(win) {
    scWin = pxClampWin(d, win);
    slice = pxSlice(d, scWin);
    redraw();
  }
  function pinchRead() {
    if (!slice || !slice.inside.length) return;
    var first = slice.inside[0], last = slice.inside[slice.inside.length - 1];
    var chg = first.c > 0 ? (last.c / first.c - 1) * 100 : 0;
    read.innerHTML = '<b class="pf-read-date">' + pxDateLabel(scWin.start, spanDays()) + ' \u2013 ' + pxDateLabel(scWin.end, spanDays()) + '</b> \u00b7 <b class="' + (chg >= 0 ? 'up' : 'down') + '">' + fmtPct(chg) + '</b> across the window';
  }
  function finishGesture(fromPinch) {
    if (fromPinch) hapticTick(); // one settle tick when a pinch lands
    read.textContent = HINT;
    var want = pxDesiredTier(scWin.end - scWin.start);
    if (want.range && !pxTierSeries(d, want)) {
      pxEnsureTier(d, want).then(function (ok) { if (ok && lastStock === d) renderScChart(d); });
    }
  }
  function dateFor(pt) {
    var dt = new Date(pt.ts * 1000);
    return PX_MONS[dt.getMonth()] + ' ' + dt.getDate() + ', ' + dt.getFullYear();
  }
  function scrubTo(clientX) {
    var rect = svg.getBoundingClientRect();
    if (!rect.width || !slice) return;
    var sx = (clientX - rect.left) / rect.width * W;
    var tsAt = scWin.start + (sx - padX) / (W - padX * 2) * (scWin.end - scWin.start);
    var best = null, bd = Infinity;
    slice.pts.forEach(function (p) { var dd = Math.abs(p.ts - tsAt); if (dd < bd) { bd = dd; best = p; } });
    if (!best) return;
    /* Ratchet haptic: one light tick per new point under the finger,
     * spaced out so a fast swipe rattles gently instead of buzzing. */
    if (best.ts !== lastScrubTs) {
      lastScrubTs = best.ts;
      var stNow = Date.now();
      if (stNow - lastScrubTick >= 45) { lastScrubTick = stNow; hapticTick(); }
    }
    var g = geom(slice);
    var x = g.X(best.ts), y = g.Y(best.c);
    grp.style.display = '';
    line.setAttribute('x1', x); line.setAttribute('x2', x);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    if (halo) { halo.setAttribute('cx', x); halo.setAttribute('cy', y); }
    var base = slice.inside.length ? slice.inside[0] : slice.pts[0];
    var chg = base && base.c > 0 ? (best.c / base.c - 1) * 100 : 0;
    read.innerHTML = '<b class="pf-read-date">' + dateFor(best) + '</b> \u00b7 <b>' + fmtMoney(best.c) + '</b> \u00b7 <b class="' + (chg >= 0 ? 'up' : 'down') + '">' + fmtPct(chg) + '</b> since start';
  }
  function centerFrac(ps) {
    var rect = svg.getBoundingClientRect();
    if (!rect.width) return 0.5;
    var cx = ((ps[0].clientX + ps[1].clientX) / 2 - rect.left) / rect.width * W;
    var f = (cx - padX) / (W - padX * 2);
    return f < 0 ? 0 : (f > 1 ? 1 : f);
  }
  zone.addEventListener('pointerdown', function (e) {
    pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    try { zone.setPointerCapture(e.pointerId); } catch (err) {}
    if (pointers.size === 1) {
      mode = 'scrub';
      downInfo = { t: Date.now(), x: e.clientX, moved: false };
      lastScrubTs = null; // a fresh grab ticks on its first point
      scrubTo(e.clientX);
    } else if (pointers.size === 2) {
      mode = 'pinch';
      pinched = true;
      grp.style.display = 'none';
      var ps = Array.from(pointers.values());
      var frac = centerFrac(ps);
      pinch0 = {
        dist: Math.hypot(ps[0].clientX - ps[1].clientX, ps[0].clientY - ps[1].clientY) || 1,
        span: scWin.end - scWin.start,
        anchorTs: scWin.start + frac * (scWin.end - scWin.start)
      };
    }
    e.preventDefault();
  });
  zone.addEventListener('pointermove', function (e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    if (mode === 'scrub' && pointers.size === 1) {
      if (downInfo && Math.abs(e.clientX - downInfo.x) > 6) downInfo.moved = true;
      scrubTo(e.clientX);
    } else if (mode === 'pinch' && pointers.size === 2 && pinch0) {
      var ps = Array.from(pointers.values());
      var dist = Math.hypot(ps[0].clientX - ps[1].clientX, ps[0].clientY - ps[1].clientY);
      if (dist < 4) return;
      var span = pinch0.span * (pinch0.dist / dist);
      var start = pinch0.anchorTs - centerFrac(ps) * span;
      applyWin({ start: start, end: start + span });
      pinchRead();
      e.preventDefault();
    }
  });
  function endPtr(e) {
    var wasPinch = mode === 'pinch';
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      mode = 'idle';
      grp.style.display = 'none';
      /* finishGesture runs when the LAST finger lifts: lifting one
       * finger first drops into scrub mode, and the pinch's tier
       * fetch + readout reset must still happen at the end. */
      if (pinched) { pinched = false; finishGesture(true); }
      else if (downInfo && !downInfo.moved && Date.now() - downInfo.t < 300) {
        var now = Date.now();
        if (now - lastTap < 320) {
          lastTap = 0;
          hapticTick();
          scWin = pxDefaultWin(d);
          renderScChart(d);
          return;
        }
        lastTap = now;
        read.textContent = HINT;
      }
      downInfo = null;
      pinch0 = null;
    } else if (pointers.size === 1 && wasPinch) {
      mode = 'scrub';
      var p = Array.from(pointers.values())[0];
      downInfo = { t: Date.now(), x: p.clientX, moved: true };
      lastScrubTs = null;
      scrubTo(p.clientX);
    }
  }
  zone.addEventListener('pointerup', endPtr);
  zone.addEventListener('pointercancel', endPtr);
  zone.addEventListener('wheel', function (e) {
    e.preventDefault();
    var rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    var frac = ((e.clientX - rect.left) / rect.width * W - padX) / (W - padX * 2);
    frac = frac < 0 ? 0 : (frac > 1 ? 1 : frac);
    var anchorTs = scWin.start + frac * (scWin.end - scWin.start);
    var span = (scWin.end - scWin.start) * Math.exp(e.deltaY * 0.0016);
    var start = anchorTs - frac * span;
    applyWin({ start: start, end: start + span });
    pinchRead();
    if (wheelTimer) clearTimeout(wheelTimer);
    wheelTimer = setTimeout(finishGesture, 200);
  }, { passive: false });
}

/* ============================== scorecard UI ============================== */
var lastStock = null;
/* Beginner info dots (Justin's ask, 2026-10-29): tap the small i
 * next to a label and a plain-English explainer smoothly unfolds
 * under it. One delegated listener handles every dot. */
var INFO_TEXT = {
  cycsev: 'Severity runs 0 to 1: how peak-cycle today\'s numbers look vs the company\'s own history \u2014 margin vs its long-run average, worst EPS drawdown, trailing EPS growth, revenue surge. 0 = nothing unusual; 1 = textbook cycle peak. Needs 2 strong signals to count; then it lifts the risk score toward 100. With fewer than 3 signals carrying data, severity caps at 0.8.',
  fwpe: 'Forward P/E = today\'s price divided by next year\'s expected earnings per share. It prices the stock against where earnings are heading, not where they have been. Rough guide: under 15 is cheap for most stocks, over 30 is expensive.',
  pe: 'P/E (trailing) = today\'s price divided by the last twelve months\' actual earnings per share. Higher means investors pay more for each $1 of profit the company already makes.',
  peg: 'PEG = the forward P/E divided by the expected earnings growth rate. It checks whether the price is fair for the growth you are getting. Under 1 is the classic \u201cgrowth at a reasonable price\u201d zone; under 0.75 is rare.',
  epsttm: 'Earnings per share over the last twelve months (TTM = trailing twelve months) \u2014 the profit already reported, per share.',
  epsgrowth: 'How much analysts expect earnings per share to grow next fiscal year versus this one. Growing earnings are what ultimately pull a stock\'s price upward.',
  epstrend: 'Whether analysts expect earnings per share to grow or shrink next year. Shrinking earnings are a risk because prices tend to follow earnings down.',
  epsmiss: 'In how many of the last few quarters the company reported EPS below what analysts expected. Frequent misses can mean a business that is hard to predict.',
  epsbeat: 'In how many of the last few quarters reported EPS beat what analysts expected. Companies that regularly beat tend to be conservatively forecast \u2014 or genuinely executing well.',
  revttm: 'How fast total sales grew over the last twelve months versus the year before. Revenue growth is the engine behind future earnings growth.',
  revqtr: 'Sales growth in the most recent reported quarter versus the same quarter a year earlier \u2014 the freshest read on whether growth is speeding up or slowing down.',
  gmargin: 'Gross margin = what is left of each $1 of sales after the direct cost of the product or service, as a %. High margins (50%+) suggest pricing power; thin ones leave little cushion.',
  omargin: 'Operating margin = profit from the core business (before interest and taxes) per $1 of sales, as a %. It shows how well the day-to-day business itself earns, ignoring financing.',
  pmargin: 'Profit margin = the share of each $1 of sales the company actually keeps as profit, as a %. Higher and steadier is healthier; negative means it is losing money.',
  debteq: 'Debt / Equity compares everything the company owes to what belongs to shareholders. Under 1 is comfortable. At 3 or more, interest bills eat a big share of earnings and trouble comes faster in a downturn. (Some industries, like banks, normally run high.)',
  roe: 'ROE = return on equity: profit earned per $1 of shareholders\' money, as a %. Above ~15% suggests an efficient business; very high ROE can also just mean lots of debt, so read it together with Debt / Equity.',
  beta: 'Beta measures how jumpy the stock is versus the whole market. 1.0 moves with the market, 2.0 swings about twice as much, 0.5 about half. High beta = bigger ups AND bigger downs.',
  range52: 'The lowest and highest prices of the last 52 weeks (one year) \u2014 the range the stock has actually traded in recently.',
  belowhigh: 'How far below its one-year high the price sits, as a %. A big gap can be a bargain \u2014 or a warning that something is wrong. It is a starting clue, never proof.',
  divyield: 'Dividend yield = the yearly dividend per share as a % of the price. 2% on a $100 stock means about $2 a year in cash payments while you hold it. 0% means no dividend.',
  payout: 'Payout ratio = the % of earnings paid out as dividends. Under about 60% leaves a comfortable cushion \u2014 the dividend is covered even in a bad year. 60\u201385% uses most of earnings, and above 100% means paying out more than the company earns, which rarely lasts.',
  cashinv: 'Cash & investments = the cash in the bank plus short- and long-term investments the company could sell -- everything it could turn into money to pay its debts.',
  totdebt: 'Total debt = all the money the company owes lenders, short-term and long-term, as StockAnalysis totals it from the balance sheet.',
  netcash: 'Net cash = cash & investments minus total debt. Positive means the company could pay off every debt today and still have cash left over. Negative (net debt) means it owes more than it holds.',
  instown: 'Institutional ownership = the % of the company\u2019s shares held by big professional investors \u2014 mutual funds, pension funds, hedge funds. High means the pros have committed real money after doing their own homework; very high can also mean a crowded trade if they all head for the exit at once.',
  target: 'Analysts who cover this stock each publish a 12-month price target \u2014 where they think the price is headed. The bar shows the average of those targets: the white dot is today\u2019s price, the gold dot is the average target, and the % is the gap between them. Treat it as a sentiment check, not a promise \u2014 targets are opinions, they are often wrong, and they tend to chase the price after it moves rather than predict it.',
  mktcap: 'Market cap = share price \u00d7 total shares \u2014 what the whole company is worth at today\'s price. Big (over $200B) usually means steadier; small (under $2B) usually means swingier.',
  size: 'Company size by market cap (price \u00d7 shares). Smaller companies tend to swing harder, get less analyst coverage, and can be harder to sell in a panic \u2014 so small size adds risk points here.',
  currentratio: 'Current ratio = short-term assets \u00f7 short-term bills. Above 1 means the company can cover what it owes within the year. Below 1 can mean cash stress if business dips.',
  boombust: 'Some businesses boom then bust in cycles (memory chips are the classic case). This flags it when the forecast shows a big earnings peak followed by a cliff, after revenue roughly doubled into the peak \u2014 peak earnings make a stock look deceptively cheap.',
  scanscore: 'Every stock in the index gets two 0\u2013100 scores: a Value score (cheapness \u2014 forward P/E, PEG, distance below its 52-week high, earnings growth, margins, low debt) and a Risk score (debt, volatility, size, earnings trend, boom-bust pattern). The Score starts at 60% Value + 40% safety, where safety = 100 \u2212 Risk. Before the list is final, each top stock is deep-checked, and its Score becomes 75% of that value-and-safety score plus 25% growth points from its projected 4-year CAGR \u2014 the yearly return its forecast earnings path works out to, shown as the estimated return at the top of the stock\u2019s page when you tap it (\u221220%/yr earns 0 points, +40%/yr earns 100). A stock with no analyst forecast keeps its value-and-safety score. Only stocks with enough data to score fairly can appear, and it shows the Top 10 for each index. Scores refresh when a company reports earnings, and the full index is rescanned about once a week. The list is computed once a day on the server, so every phone shows the same scores; tapping Rescan still runs a fresh scan on this phone.',
  radar: 'Five 0\u2013100 measures drawn as a snowflake: Value (the valuation score), Future (forecast EPS growth), Past (recent revenue growth), Health (debt, liquidity, margins) and Dividend (the yield). The further a point reaches, the stronger that measure \u2014 a big, even snowflake is strong all round. If the Future point is red, the cliff check fired \u2014 earnings are forecast to fall off a peak.',
};
var FACTOR_INFO = {
  'Forward P/E': 'fwpe', 'PEG ratio': 'peg', 'Below 52-wk high': 'belowhigh',
  'EPS growth, next yr': 'epsgrowth', 'Profit margin': 'pmargin', 'Gross margin': 'gmargin',
  'Debt / Equity': 'debteq', 'Beta (volatility)': 'beta', 'Company size': 'size',
  'EPS trend, next yr': 'epstrend', 'Current ratio': 'currentratio', 'Boom-bust pattern': 'boombust'
};
function infoDot(key) {
  return INFO_TEXT[key] ? ' <button type="button" class="info-dot" data-info="' + key + '" aria-label="What does this mean?">i</button>' : '';
}
var INFO_GLOSS = {
  fwpe: 'Forward P/E', pe: 'P/E ratio', peg: 'PEG ratio',
  epsttm: 'EPS (earnings per share)', epsgrowth: 'YoY (year over year)',
  epstrend: 'YoY (year over year)', epsmiss: 'Earnings surprise', epsbeat: 'Earnings surprise',
  revttm: 'TTM (trailing twelve months)', gmargin: 'Gross margin', omargin: 'Operating margin',
  pmargin: 'Profit margin', debteq: 'Debt / Equity', roe: 'ROE (return on equity)',
  beta: 'Beta', range52: '52-week high', belowhigh: '52-week high',
  divyield: 'Dividend yield', target: 'Analyst target', mktcap: 'Market cap', size: 'Market cap',
  boombust: 'Earnings cliff'
};
function infoText(key) {
  if (!INFO_TEXT[key]) return '';
  var link = INFO_GLOSS[key] ? ' <button type="button" class="info-gloss-link" data-gloss="' + INFO_GLOSS[key] + '">See in Glossary \u2192</button>' : '';
  return '<span class="info-text" data-info-text="' + key + '">' + INFO_TEXT[key] + link + '</span>';
}
/* Toggle an explainer as ONE motion (Justin's report, 2026-11-08: the
 * close used to fade the text out first, then slide the empty box up).
 * The stylesheet animates max-height against a tall cap (460px, 900px
 * in factor tables), so for a short explainer most of the transition
 * shrank an invisible region while opacity ran on its own clock.
 * Pinning the real height inline before transitioning did NOT fix it
 * either — frame-by-frame measurement in a real browser (2026-11-08)
 * showed the close curve unchanged, the text still fading ahead of
 * the box. So the height is now driven by the Web Animations API with
 * the same duration and easing as the opacity transition, which the
 * compositor runs as one motion. After an open, the inline height is
 * handed back to the stylesheet so the explainer reflows on rotation. */
function setInfoOpen(txt, open) {
  if (!txt) return;
  var reduced = false;
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  if (txt._infoAnim) { try { txt._infoAnim.cancel(); } catch (e) {} txt._infoAnim = null; }
  var h = txt.scrollHeight;
  if (open) txt.classList.add('open'); else txt.classList.remove('open');
  txt.style.maxHeight = open ? h + 'px' : '0px';
  if (reduced || !h || typeof txt.animate !== 'function') return;
  var anim = txt.animate(
    open ? [{ maxHeight: '0px' }, { maxHeight: h + 'px' }] : [{ maxHeight: h + 'px' }, { maxHeight: '0px' }],
    { duration: 350, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
  txt._infoAnim = anim;
  setTimeout(function () {
    if (txt._infoAnim !== anim) return;
    txt._infoAnim = null;
    if (txt.classList.contains('open')) txt.style.maxHeight = ''; // hand back to the stylesheet so it reflows on rotation
  }, 420);
}
var glossReturn = 'portfolio';
var glossReturnState = null; /* {tab, scroll, ov} captured at the 'See in Glossary' tap */
function openGlossaryTerm(term) {
  if (!term) return;
  var active = document.querySelector('.tabbar button.active');
  var from = active ? active.getAttribute('data-tab') : '';
  if (from) glossReturn = from;
  var mn0 = document.querySelector('main');
  glossReturnState = { tab: from || glossReturn, scroll: mn0 ? mn0.scrollTop : 0, ov: ovTicker || null };
  glossStack = [];
  closeOverview();
  var gs = $('gloss-search');
  if (gs) gs.value = '';
  renderGlossary('', term);
  switchTab('glossary');
  var item = document.querySelector('#gloss-list .g-item');
  if (item) item.classList.add('flash');
}

/* Glossary cross-links (Justin's ask, 2026-10-30): any mention of another
 * glossary term inside a definition renders as an underlined link; tapping
 * it jumps to that term, and a stack powers the glossary Back button so
 * the reader can return to the term they came from. */
var GLOSS_ALIASES = {
  'P/E ratio': ['P/E'],
  'PEG ratio': ['PEG'],
  'EPS (earnings per share)': ['EPS', 'earnings per share'],
  'Outstanding shares': ['shares outstanding'],
  'Debt / Equity': ['Debt/Equity', 'debt/equity ratio', 'debt-to-equity'],
  'ROE (return on equity)': ['ROE', 'return on equity'],
  'TTM (trailing twelve months)': ['TTM'],
  'YoY (year over year)': ['YoY'],
  'Consensus estimate': ['consensus'],
  'SWOT analysis': ['SWOT'],
  'Exit P/E (exit multiple)': ['exit P/E', 'exit multiple'],
  'Bear / Base / Bull case': ['bear case', 'base case', 'bull case'],
  'Adjusted (non-GAAP) EPS': ['adjusted EPS', 'non-GAAP'],
  'Buyback': ['buybacks'],
  'Free cash flow': ['FCF']
};
var GLOSS_LINK_RE = null, GLOSS_LINK_MAP = null;
function glossLinkerBuild() {
  if (GLOSS_LINK_RE) return;
  var pairs = [];
  GLOSSARY.forEach(function (g) {
    pairs.push([g[0], g[0]]);
    (GLOSS_ALIASES[g[0]] || []).forEach(function (a) { pairs.push([a, g[0]]); });
  });
  pairs.sort(function (a, b) { return b[0].length - a[0].length; });
  GLOSS_LINK_MAP = {};
  var parts = pairs.map(function (p) {
    GLOSS_LINK_MAP[p[0].toLowerCase()] = p[1];
    return p[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  GLOSS_LINK_RE = new RegExp('(?<![A-Za-z0-9])(' + parts.join('|') + ')(?![A-Za-z0-9])', 'gi');
}
function glossLinkify(def, selfTerm) {
  glossLinkerBuild();
  return esc(def).replace(GLOSS_LINK_RE, function (m) {
    var t = GLOSS_LINK_MAP[m.toLowerCase()];
    if (!t || t === selfTerm) return m;
    return '<button type="button" class="g-link" data-gterm="' + esc(t) + '">' + m + '</button>';
  });
}
var glossStack = [];
function glossSyncBack() {
  var b = $('gl-back');
  if (!b) return;
  var top = glossStack[glossStack.length - 1];
  b.textContent = top ? '\u2190 Back to ' + top : '\u2190 Back';
}
function glossShowTerm(term) {
  var gs = $('gloss-search');
  if (gs) gs.value = '';
  renderGlossary('', term);
  var mn = document.querySelector('main');
  if (mn) mn.scrollTop = 0;
  var item = document.querySelector('#gloss-list .g-item');
  if (item) item.classList.add('flash');
  glossSyncBack();
}
function glossJumpTo(term, fromTerm) {
  if (fromTerm && fromTerm !== term) glossStack.push(fromTerm);
  glossShowTerm(term);
}
function kvItem(k, v, ik) {
  return '<div class="kv-item"><div class="k">' + esc(k) + (ik ? infoDot(ik) : '') + '</div><div class="v">' + esc(v) + '</div>' + (ik ? infoText(ik) : '') + '</div>';
}

/* ============================== SWOT (auto) ============================== */
/* A SWOT built from the numbers already on the scorecard — every bullet
 * cites the metric behind it. It reads figures, not news: company-specific
 * events (lawsuits, new rivals, regulation) can't appear here. */
function buildSwot(d) {
  var S = [], W = [], O = [], T = [];
  var sc = scoreStock(d, STD_W);
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
  else if (epsPossibleCliff(d)) { var pcT = epsPossibleCliff(d); T.push('Possible earnings cliff — only 2 years of estimates: EPS explodes ' + fmtPct(pcT.g1, 0) + ' in ' + pcT.fy1Label + ', then growth slows to ' + fmtPct(pcT.g2, 0) + ' in ' + pcT.fy2Label + '. The peak may sit just past the forecast window, so this counts as a cliff.'); }
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
var BIZ_URL = 'https://stock-research-relay.supplessayings-6e6.workers.dev/bizmodel';
var CEOPREV_URL = 'https://stock-research-relay.supplessayings-6e6.workers.dev/ceoprev';
/* Previous-experience extraction lives in the Worker (grounded in
 * the Wikipedia article text the CEO hunt already fetched; shared
 * 30-day cache there). Returns {pr, pg} or null. */
async function ceoPrevFor(name, company, extract) {
  try {
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 60000) : null;
    var resp = await fetch(CEOPREV_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, company: company || '', extract: String(extract || '').slice(0, 12000) }),
      signal: ctrl ? ctrl.signal : undefined
    });
    if (timer) clearTimeout(timer);
    if (!resp.ok) return null;
    var data = await resp.json();
    if (data && (data.prevRole || data.prevGrowth)) return { pr: data.prevRole || null, pg: data.prevGrowth || null };
  } catch (e) {}
  return null;
}
var BIZ_KEY = 'sr_biz_v3';
var SCAN_SHARED_URL = 'https://stock-research-relay.supplessayings-6e6.workers.dev/scan';
var AI_SWOT_CACHE_URL = 'https://stock-research-relay.supplessayings-6e6.workers.dev/swot-cache';
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
  var sc = scoreStock(d, STD_W);
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
  if (isNum(d.insiderOwn)) parts.push('insider ownership ' + fmtNum(d.insiderOwn, 2) + '%');
  if (isNum(d.instOwn)) parts.push('institutional ownership ' + fmtNum(d.instOwn, 1) + '%');
  var itx = d.insiderTx || [];
  if (itx.length) {
    var ib = 0, isl = 0;
    itx.forEach(function (t) { if (t.type === 'Buy') ib++; else if (t.type === 'Sale') isl++; });
    var ip = 'recent insider trades: ' + ib + ' open-market buys, ' + isl + ' sales';
    var lastTx = itx[0];
    if (lastTx) ip += ' (latest: ' + lastTx.type + (isNum(lastTx.shares) ? ' of ' + Math.round(lastTx.shares).toLocaleString('en-US') + ' shares' : '') + ', ' + lastTx.date + ')';
    parts.push(ip);
  }
  return parts.join('; ') + '.';
}
function aiSwotGridHtml(entry) {
  return '<div class="swot-grid">' +
    swotBox('S', 'Strengths', entry.swot.S, 'sw-s') + swotBox('W', 'Weaknesses', entry.swot.W, 'sw-w') +
    swotBox('O', 'Opportunities', entry.swot.O, 'sw-o') + swotBox('T', 'Threats', entry.swot.T, 'sw-t') + '</div>' +
    '<div style="margin-top:8px"><button class="btn-ghost" id="ai-swot-btn" type="button">↻ Regenerate</button></div>';
}
function bindAiSwotBtn(d, refresh) {
  var b = $('ai-swot-btn');
  if (b) b.addEventListener('click', function () { runAiSwot(d, refresh === true); });
}
async function runAiSwot(d, refresh) {
  var zone = $('ai-swot-zone');
  if (!zone) return;
  var prevHtml = zone.innerHTML;
  zone.innerHTML = '<p class="fineprint"><span class="spinner"></span>Writing the SWOT — reading the numbers, headlines, insider trades and 10-K risks…</p>';
  try {
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 90000) : null;
    var payload = {
      ticker: d.ticker,
      name: d.companyName || d.ticker,
      sector: d.sector || '',
      industry: d.industry || '',
      metrics: aiMetricsText(d)
    };
    /* Regenerate is a deliberate fresh take: it carries the refresh
     * flag so the Worker skips its shared-cache answer (and counts
     * against the generation throttle). Plain Generate sends no flag
     * and gets the cached answer instantly when one is fresh. */
    if (refresh === true) payload.refresh = true;
    var resp = await fetch(AI_SWOT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined
    });
    if (timer) clearTimeout(timer);
    var data = await resp.json();
    if (resp.status === 429 || (data && (data.error === 'rate_limited' || data.error === 'daily_cap'))) {
      /* Throttled or the daily AI cap is hit: keep whatever SWOT was
       * on screen and put the plain reason above it. */
      var msg = (data && data.error === 'daily_cap')
        ? 'Today\'s AI limit is reached — the shared analysis above is today\'s; try again tomorrow.'
        : 'Lots of people are generating right now — try again in a minute.';
      var z9 = $('ai-swot-zone');
      if (z9) {
        if (prevHtml && prevHtml.indexOf('ai-swot-btn') >= 0) {
          z9.innerHTML = '<div class="alert warn" style="margin-bottom:8px">' + esc(msg) + '</div>' + prevHtml;
          bindAiSwotBtn(d, refresh === true);
        } else {
          z9.innerHTML = '<div class="alert warn">' + esc(msg) + ' <button class="btn-ghost" id="ai-swot-btn" type="button">Try again</button></div>';
          bindAiSwotBtn(d, refresh === true);
        }
      }
      return;
    }
    if (!resp.ok || !data.swot) throw new Error((data && data.error) || ('HTTP ' + resp.status));
    var entry = { asOf: data.asOf || '', swot: data.swot, tenk: data.tenk || null };
    saveAiSwot(d.ticker, entry);
    var z2 = $('ai-swot-zone');
    if (z2) { z2.innerHTML = aiSwotGridHtml(entry); bindAiSwotBtn(d, true); }
  } catch (e) {
    var z3 = $('ai-swot-zone');
    if (z3) {
      z3.innerHTML = '<div class="alert warn">The AI SWOT didn\'t come back (' + esc(e.message || 'network error') + '). <button class="btn-ghost" id="ai-swot-btn" type="button">Try again</button></div>';
      bindAiSwotBtn(d, refresh === true);
    }
  }
}

function aiSwotSharedHtml(swot, generatedAt) {
  var day = generatedAt ? String(generatedAt).slice(0, 10) : '';
  return '<p class="fineprint">Shared analysis' + (day ? ' · generated ' + esc(day) : '') +
    ' — written by AI, the same for everyone viewing this ticker today. Generate your own for a fresh take on the latest numbers.</p>' +
    '<div class="swot-grid">' +
    swotBox('S', 'Strengths', swot.S, 'sw-s') + swotBox('W', 'Weaknesses', swot.W, 'sw-w') +
    swotBox('O', 'Opportunities', swot.O, 'sw-o') + swotBox('T', 'Threats', swot.T, 'sw-t') + '</div>' +
    '<div style="margin-top:8px"><button class="btn-ghost" id="ai-swot-btn" type="button">✦ Generate my own</button></div>';
}

/* Shared-cache display: the Worker keeps the first AI SWOT generated
 * for each ticker each day, so if anyone already had one written, show
 * it here at zero extra AI cost. Display-only — a shared hit is never
 * written into sr_aiswot_v1, and a personal saved SWOT always wins (in
 * that case the cache isn't even fetched). Any miss or error leaves
 * today's empty state untouched, silently. */
async function maybeShowSharedSwot(d) {
  try {
    if (!d || !d.ticker) return;
    if (getAiSwot(d.ticker)) return;
    var zoneAtStart = $('ai-swot-zone');
    if (!zoneAtStart) return;
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 6000) : null;
    var resp = await fetch(AI_SWOT_CACHE_URL + '?ticker=' + encodeURIComponent(d.ticker), {
      signal: ctrl ? ctrl.signal : undefined
    });
    if (timer) clearTimeout(timer);
    if (!resp || !resp.ok) return;
    var data = await resp.json();
    if (!data || !data.hit || !data.text) return;
    var sw = data.text;
    if (!sw.S || !sw.W || !sw.O || !sw.T) return;
    var zone = $('ai-swot-zone');
    if (!zone || zone !== zoneAtStart) return; /* card re-rendered meanwhile */
    if (getAiSwot(d.ticker)) return;           /* a personal one landed meanwhile */
    if (!zone.querySelector('#ai-swot-btn')) return; /* user already started generating */
    zone.innerHTML = aiSwotSharedHtml(sw, data.generatedAt);
    bindAiSwotBtn(d);
  } catch (e) { /* silent: the empty state stays */ }
}

/* Analyst target used across the card: Nasdaq's 1-yr target when it
 * landed, else the Finviz snapshot target (same value the key stat
 * shows when Nasdaq answered). */
function analystTarget(d) {
  if (isNum(d.target1Y)) return d.target1Y;
  if (isNum(d.targetPrice)) return d.targetPrice;
  return null;
}

/* Dividend check-up: yield, payout, ex-date and the cash per share.
 * The cash figure is Finviz's annual dividend when present, else
 * price x yield as an approximation. Facts only — no advice. */
function dividendHtml(d) {
  if (!(isNum(d.divYield) && d.divYield > 0)) return '';
  var cash = isNum(d.divCash) ? d.divCash : (isNum(d.price) ? d.price * d.divYield / 100 : null);
  var html = '<div class="section-h">Dividend</div><div class="kv-grid">';
  html += kvItem('Dividend yield', fmtNum(d.divYield, 2) + '%', 'divyield');
  if (isNum(d.payout)) html += kvItem('Payout ratio', fmtNum(d.payout, 1) + '%', 'payout');
  if (d.exDivDate) html += kvItem('Ex-dividend date', d.exDivDate);
  if (isNum(cash)) html += kvItem('Cash per share / yr', fmtMoney(cash));
  html += '</div>';
  if (isNum(d.payout)) {
    html += '<p class="fineprint">' + (d.payout < 60 ? 'Payout uses under 60% of earnings' : d.payout <= 85 ? 'Payout uses most of earnings' : 'Payout is above 85% of earnings \u2014 thin cushion') + '</p>';
  }
  return html;
}

/* Analyst-target bar: today's price vs the 1-yr analyst target on
 * one track — white dot is the price, gold dot is the target. */
function fvBarHtml(d) {
  var tgt = analystTarget(d);
  if (!isNum(tgt) || tgt <= 0 || !isNum(d.price) || d.price <= 0) return '';
  var lo = Math.min(d.price, tgt) * 0.9, hi = Math.max(d.price, tgt) * 1.05;
  var pxPos = (d.price - lo) / (hi - lo) * 100;
  var tgPos = (tgt - lo) / (hi - lo) * 100;
  var diff = (tgt / d.price - 1) * 100;
  var gapL = Math.min(pxPos, tgPos), gapW = Math.abs(tgPos - pxPos);
  function labCls(p) { return p < 16 ? 'fv-lab l' : p > 72 ? 'fv-lab r' : 'fv-lab'; }
  return '<div class="fv-wrap">' +
    '<div class="fv-head">Analyst price target' + infoDot('target') + '</div>' + infoText('target') +
    '<div class="fv-labs"><span class="' + labCls(pxPos) + ' now" style="left:' + pxPos.toFixed(1) + '%">Now ' + fmtMoney(d.price) + '</span></div>' +
    '<div class="fv-track">' +
    (gapW > 0.5 ? '<div class="fv-gap' + (diff < 0 ? ' dn' : '') + '" style="left:' + gapL.toFixed(1) + '%;width:' + gapW.toFixed(1) + '%"></div>' : '') +
    '<span class="fv-dot target" style="left:' + tgPos.toFixed(1) + '%"></span>' +
    '<span class="fv-dot price" style="left:' + pxPos.toFixed(1) + '%"></span></div>' +
    '<div class="fv-labs"><span class="' + labCls(tgPos) + ' tgt" style="left:' + tgPos.toFixed(1) + '%">Target ' + fmtMoney(tgt) + ' \u00b7 ' + fmtPct(diff) + '</span></div></div>';
}

/* "At a glance" measures: five 0-100 axes mapped piecewise-linearly
 * from figures already on the card, drawn as a snowflake radar (see
 * radarSvg). Presentation only — no score reads these. */
var RADAR_FUT = [[-20, 0], [-5, 15], [0, 30], [8, 50], [15, 65], [25, 80], [40, 92], [60, 100]];
var RADAR_PAST = [[-20, 0], [0, 35], [5, 55], [10, 70], [20, 85], [35, 100]];
var RADAR_DE = [[0.1, 100], [0.5, 85], [1, 65], [2, 40], [3, 20], [4, 5]];
var RADAR_CR = [[0.8, 10], [1, 45], [1.5, 75], [2, 95]];
var RADAR_PM = [[-10, 5], [0, 40], [5, 60], [10, 75], [20, 90], [30, 100]];
var RADAR_DIV = [[0, 0], [0.5, 25], [1, 45], [2, 65], [3, 80], [5, 100]];
function radarMap(v, anchors) {
  if (!isNum(v)) return null;
  if (v <= anchors[0][0]) return anchors[0][1];
  for (var i = 1; i < anchors.length; i++) {
    if (v <= anchors[i][0]) {
      var x0 = anchors[i - 1][0], y0 = anchors[i - 1][1], x1 = anchors[i][0], y1 = anchors[i][1];
      return y0 + (y1 - y0) * (v - x0) / (x1 - x0);
    }
  }
  return anchors[anchors.length - 1][1];
}
function radarAxes(d) {
  var axes = [];
  axes.push({ label: 'Value', score: scoreStock(d).score });
  var g1 = isNum(d.epsGrowthNextY) ? radarMap(d.epsGrowthNextY, RADAR_FUT) : null;
  var fc = (d.epsForecasts || []).filter(function (f) { return f && isNum(f.eps); });
  var fut = g1;
  if (fc.length >= 2 && fc[0].eps > 0 && fc[1].eps > 0) {
    var g2 = radarMap((fc[1].eps / fc[0].eps - 1) * 100, RADAR_FUT);
    fut = isNum(g1) ? (g1 + g2) / 2 : g2;
  }
  axes.push({ label: 'Future', score: isNum(fut) ? Math.round(fut) : null });
  var pastParts = [];
  if (isNum(d.salesGrowthTTM)) pastParts.push(radarMap(d.salesGrowthTTM, RADAR_PAST));
  if (isNum(d.revGrowthQtr)) pastParts.push(radarMap(d.revGrowthQtr, RADAR_PAST));
  var past = null;
  if (pastParts.length) past = Math.round(pastParts.reduce(function (s, x) { return s + x; }, 0) / pastParts.length);
  else if (isNum(d.epsGrowthTTM)) past = Math.round(radarMap(d.epsGrowthTTM, RADAR_PAST));
  axes.push({ label: 'Past', score: past });
  var hParts = [];
  if (isNum(d.debtEq) && d.debtEq >= 0) hParts.push(radarMap(d.debtEq, RADAR_DE));
  if (isNum(d.currentRatio) && d.currentRatio > 0) hParts.push(radarMap(d.currentRatio, RADAR_CR));
  if (isNum(d.profitMargin)) hParts.push(radarMap(d.profitMargin, RADAR_PM));
  axes.push({ label: 'Health', score: hParts.length ? Math.round(hParts.reduce(function (s, x) { return s + x; }, 0) / hParts.length) : null });
  axes.push({ label: 'Dividend', score: isNum(d.divYield) ? Math.round(radarMap(Math.max(0, d.divYield), RADAR_DIV)) : null });
  return axes;
}
function radarSvg(axes, size, cliff) {
  var cx = size / 2, cy = size / 2, R = size / 2 - 6;
  function pt(i, frac) {
    var a = -Math.PI / 2 + i * (2 * Math.PI / 5);
    return [cx + R * frac * Math.cos(a), cy + R * frac * Math.sin(a)];
  }
  function ptsStr(fracFn) {
    return axes.map(function (a, i) { var p = pt(i, fracFn(a)); return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
  }
  var out = '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '" class="radar-svg" role="img" aria-label="At a glance snowflake">';
  [0.25, 0.5, 0.75, 1].forEach(function (f) {
    out += '<polygon points="' + ptsStr(function () { return f; }) + '" class="radar-grid"/>';
  });
  axes.forEach(function (a, i) {
    var p = pt(i, 1);
    out += '<line x1="' + cx + '" y1="' + cy + '" x2="' + p[0].toFixed(1) + '" y2="' + p[1].toFixed(1) + '" class="radar-grid"/>';
  });
  out += '<polygon points="' + ptsStr(function (a) { return isNum(a.score) ? a.score / 100 : 0; }) + '" class="radar-poly"/>';
  axes.forEach(function (a, i) {
    var p = pt(i, isNum(a.score) ? a.score / 100 : 0);
    out += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.2" class="radar-dot' + (cliff && i === 1 ? ' cliff' : '') + '"/>';
  });
  return out + '</svg>';
}
function cliffFlag(d) {
  try { return !!(epsCliffInfo(d) || epsPossibleCliff(d)); } catch (e) { return false; }
}
function radarLegendHtml(axes, cliff) {
  return axes.map(function (a, i) {
    return '<div class="radar-leg-row"><span class="radar-leg-name">' + a.label +
      (cliff && i === 1 ? ' <span class="radar-cliff-tag">cliff</span>' : '') +
      '</span><span class="radar-leg-num">' + (isNum(a.score) ? a.score : '\u2014') + '</span></div>';
  }).join('');
}
function radarFlexHtml(axes, cliff, mini) {
  return '<div class="radar-flex' + (mini ? ' mini' : '') + '">' + radarSvg(axes, mini ? 118 : 190, cliff) +
    '<div class="radar-leg">' + radarLegendHtml(axes, cliff) + '</div></div>';
}
function radarCount(axes) { return axes.filter(function (a) { return isNum(a.score); }).length; }
function radarCardHtml(d) {
  var axes = radarAxes(d);
  if (radarCount(axes) < 3) return '';
  return '<div class="section-h">At a glance' + infoDot('radar') + '</div>' + infoText('radar') +
    radarFlexHtml(axes, cliffFlag(d), false);
}

/* Cash & debt section (Justin's ask, 2026-11-10): how much cash the
 * company holds, how much debt it carries, and in one line how
 * easily it could pay that debt off. Figures are the latest reported
 * balance sheet from StockAnalysis (via cycLoadYearly's bs snapshot).
 * Renders nothing when no balance sheet came back. */
function cashDebtVerdict(cash, debt) {
  if (!isNum(cash) || !isNum(debt)) return null;
  if (debt <= 0) return { cls: 'ok', text: 'No debt on the balance sheet \u2014 nothing to pay off.' };
  if (cash >= debt) {
    return { cls: 'ok', text: 'Cash covers every dollar of debt ' + (cash / debt).toFixed(1) + '\u00d7 over \u2014 it could pay off all its debt today and still have cash left.' };
  }
  return { cls: 'warn', text: 'Cash covers ' + Math.round(cash / debt * 100) + '% of the debt \u2014 the rest would have to come from earnings or new borrowing.' };
}

function cashDebtHtml(d) {
  if (!isNum(d.bsCash) && !isNum(d.bsDebt)) return '';
  var html = '<div class="section-h">Cash & <span class="gold-text">debt</span></div><div class="kv-grid">';
  html += kvItem('Cash & investments', isNum(d.bsCash) ? fmtCap(d.bsCash) : '—', 'cashinv');
  html += kvItem('Total debt', isNum(d.bsDebt) ? fmtCap(d.bsDebt) : '—', 'totdebt');
  if (isNum(d.bsNet)) {
    html += kvItem(d.bsNet >= 0 ? 'Net cash' : 'Net debt', fmtCap(Math.abs(d.bsNet)), 'netcash');
  }
  html += '</div>';
  var v = cashDebtVerdict(d.bsCash, d.bsDebt);
  if (v) html += '<div class="alert ' + v.cls + '">' + (v.cls === 'ok' ? '\u2713 ' : '\u26a0 ') + esc(v.text) + '</div>';
  if (d.bsPeriod) html += '<p class="fineprint">Latest balance sheet \u00b7 ' + esc(d.bsPeriod) + ' \u00b7 StockAnalysis</p>';
  return html;
}

/* Estimated-return strip (Justin's call, 2026-11-13 evening): the
 * projected 4-yr CAGR sits at the TOP of the page a tap opens -- the
 * full scorecard and the watchlist overview both -- as an
 * "Estimated return" number, so the daily scan rows no longer carry
 * a cramped CAGR tag in their thumbnail. A saved projection's CAGR
 * wins, then the day-cached auto value; the fill below refreshes it
 * and hides the strip when no forecast path exists. The fill guards
 * on the strip's own ticker attribute, so a slow answer for a stock
 * the user has already tapped away from never lands. */
function projStripHtml(id, ticker) {
  var saved = pjSavedCagr(ticker);
  var cached = isNum(saved) ? saved : (wlProjEntry(ticker) || {}).cagr;
  var v = isNum(cached)
    ? '<span class="sc-proj-v ' + (cached >= 0 ? 'up' : 'down') + '">' + (cached >= 0 ? '+' : '') + fmtNum(cached, 1) + '%/yr</span>'
    : '<span class="sc-proj-v sc-proj-wait">Estimating\u2026</span>';
  return '<div class="sc-proj" id="' + id + '" data-proj-ticker="' + esc(ticker) + '"><span class="sc-proj-l"><b>Estimated return</b><span>Projected 4-yr CAGR \u00b7 base case</span></span>' + v + '</div>';
}
function projStripFill(id, ticker) {
  if (isNum(pjSavedCagr(ticker))) return;
  fetchWlProjCagr(ticker).then(function (cg) {
    var el = $(id);
    if (!el || el.getAttribute('data-proj-ticker') !== ticker) return;
    if (!isNum(cg)) { el.style.display = 'none'; return; }
    var v = el.querySelector('.sc-proj-v');
    if (!v) return;
    v.className = 'sc-proj-v ' + (cg >= 0 ? 'up' : 'down');
    v.textContent = (cg >= 0 ? '+' : '') + fmtNum(cg, 1) + '%/yr';
  }).catch(function () {});
}

function renderScorecard(d) {
  lastStock = d;
  var sc = scoreStock(d);
  var screen = valueScreen(d);
  var traj = epsTrajectory(d);
  var passCount = screen.filter(function (s) { return s.test === true; }).length;
  var knownCount = screen.filter(function (s) { return s.test !== null; }).length;
  var vClass = sc.verdict === 'Undervalued' ? 'undervalued' : (sc.verdict === 'Fairly valued' || sc.verdict === 'Value (cyclical peak risk)') ? 'fair' : 'overpriced';
  var chgCls = isNum(d.dayChangePct) ? (d.dayChangePct >= 0 ? 'up' : 'down') : '';
  var html = '<div class="card">';
  html += '<div class="sc-head"><div class="sc-head-l">' + logoTile(d.ticker, 'lg') + '<div><div class="sc-name">' + esc(d.companyName || d.ticker) + ' <span class="gold-text">' + esc(d.ticker) + '</span></div>' +
    '<div class="sc-sub">' + esc([d.exchange, d.sector, d.industry].filter(Boolean).join(' · ')) + '</div></div></div>' +
    '<div class="sc-price"><div class="p">' + fmtMoney(d.price) + '</div>' +
    '<div class="chg ' + chgCls + '">' + (isNum(d.dayChangePct) ? fmtPct(d.dayChangePct) + ' today' : '') + '</div></div></div>';
  html += projStripHtml('sc-proj', d.ticker);
  if (d.about) html += '<div class="sc-about">' + esc(d.about) + '</div>';
  html += moreBlockHtml(d);
  if (!d.earnEst) html += earnLineHtml(d);

  if (d.history && d.history.length >= 2) {
    html += '<div class="section-h">Price — <span class="gold-text" id="sc-range-label">1 year</span></div>' +
      '<div id="sc-chart-box"></div>';
  }
  html += fvBarHtml(d);

  if (sc.score != null) {
    html += '<div class="verdict ' + vClass + '"><div><div class="v-label">Valuation verdict</div>' +
      '<div class="v-word">' + esc(sc.verdict) + '</div></div>' +
      '<button type="button" class="v-score pts-btn" data-mathbtn data-mathtarget="math-vscore" aria-expanded="false">' + sc.score + '<small> / 100</small></button></div>';
    html += '<div class="score-bar"><div style="width:' + sc.score + '%"></div></div>';
    if (weightsAreCustom()) {
      var scStd = scoreStock(d, STD_W);
      if (scStd.score != null && scStd.rawScore !== sc.rawScore) html += '<p class="fineprint">Your scoring weights \u00b7 with the standard weights this scores ' + scStd.rawScore + '.</p>';
    }
    var scMath = 'Score = ' + sc.got + ' pts earned \u00f7 ' + sc.maxAvailable + ' pts available \u00d7 100 = ' + sc.rawScore + '.';
    if (sc.cycCapped) scMath += ' Capped at 70: cyclical severity ' + fmtNum(sc.severity, 2) + ' is 0.5 or higher (peak-earnings risk).';
    html += '<div class="math-box banner-math" id="math-vscore" hidden>' + esc(scMath) + '</div>';
    html += '<table class="factors"><tr><th>Factor</th><th>Value</th><th class="num">Points</th></tr>';
    sc.factors.forEach(function (f, fi) {
      var ik = FACTOR_INFO[f.name];
      html += '<tr><td><strong>' + esc(f.name) + '</strong>' + (ik ? infoDot(ik) : '') + '<div class="factor-note">' + esc(f.note) + '</div></td><td>' + esc(f.display) + '</td><td class="num"><button type="button" class="pts-btn" data-mathbtn data-mathtarget="math-v' + fi + '" aria-expanded="false">' + (f.max === 0 ? '<strong>off</strong>' : '<strong>' + f.pts + '</strong> / ' + f.max) + '</button></td></tr>';
      if (ik) html += '<tr class="info-row"><td colspan="3">' + infoText(ik) + '</td></tr>';
      html += '<tr class="math-row" id="math-v' + fi + '" hidden><td colspan="3"><div class="math-box">' + esc(f.math) + '</div></td></tr>';
    });
    html += '</table>';
    if (sc.maxAvailable < 100) {
      html += '<p class="fineprint">Scaled to 100 over factors with data (' + sc.maxAvailable + ' pts). Missing data is never guessed.</p>';
    }
  } else {
    html += '<div class="alert warn">Not enough data came back to score this stock. The key stats below show what was found.</div>';
  }

  var rk = riskScore(d);
  if (rk.score != null) {
    var rClass = rk.score <= 25 ? 'risk-low' : rk.score <= 45 ? 'risk-mod' : rk.score <= 65 ? 'risk-elev' : 'risk-high';
    html += '<div class="verdict ' + rClass + '"><div><div class="v-label">Risk score</div>' +
      '<div class="v-word">' + esc(rk.verdict) + '</div></div>' +
      '<button type="button" class="v-score pts-btn" data-mathbtn data-mathtarget="math-rscore" aria-expanded="false">' + rk.score + '<small> / 100</small></button></div>';
    html += '<div class="score-bar risk-bar"><div style="width:' + rk.score + '%"></div></div>';
    if (weightsAreCustom()) {
      var rkStd = riskScore(d, STD_W);
      if (rkStd.score != null && rkStd.score !== rk.score) html += '<p class="fineprint">Your scoring weights \u00b7 with the standard weights the risk score is ' + rkStd.score + '.</p>';
    }
    var rkMath = 'Base = ' + rk.got + ' pts \u00f7 ' + rk.maxAvailable + ' pts available \u00d7 100 = ' + rk.base + '.';
    if (rk.cyc && rk.cyc.severity > 0) rkMath += ' Cyclical overlay: ' + rk.base + ' + (100 \u2212 ' + rk.base + ') \u00d7 ' + fmtNum(rk.cyc.severity, 2) + ' \u00d7 0.6 = ' + rk.score + '.';
    html += '<div class="math-box banner-math" id="math-rscore" hidden>' + esc(rkMath) + '</div>';
    html += '<table class="factors"><tr><th>Risk factor</th><th>Value</th><th class="num">Risk pts</th></tr>';
    rk.factors.forEach(function (f, fi) {
      var ik = FACTOR_INFO[f.name];
      html += '<tr><td><strong>' + esc(f.name) + '</strong>' + (ik ? infoDot(ik) : '') + '<div class="factor-note">' + esc(f.note) + '</div></td><td>' + esc(f.display) + '</td><td class="num"><button type="button" class="pts-btn" data-mathbtn data-mathtarget="math-r' + fi + '" aria-expanded="false">' + (f.max === 0 ? '<strong>off</strong>' : '<strong>' + f.pts + '</strong> / ' + f.max) + '</button></td></tr>';
      if (ik) html += '<tr class="info-row"><td colspan="3">' + infoText(ik) + '</td></tr>';
      html += '<tr class="math-row" id="math-r' + fi + '" hidden><td colspan="3"><div class="math-box">' + esc(f.math) + '</div></td></tr>';
    });
    var cycSig = rk.cyc ? [rk.cyc.signals.margin, rk.cyc.signals.epsDD, rk.cyc.signals.epsGrowth, rk.cyc.signals.revSurge].filter(isNum) : [];
    if (rk.cyc && cycSig.length) {
      var cd = rk.cyc.detail, cParts = [];
      if (isNum(rk.cyc.signals.margin)) cParts.push('Margin ' + fmtNum(cd.marginRatio, 1) + '\u00d7 its long-run average');
      if (isNum(rk.cyc.signals.epsDD)) cParts.push('worst EPS drawdown \u2212' + fmtNum(cd.ddPct, 0) + '% (' + cd.downYears + ' down yrs)');
      if (isNum(rk.cyc.signals.epsGrowth)) cParts.push('EPS ' + fmtPct(cd.epsG, 0) + ' in a year');
      if (isNum(rk.cyc.signals.revSurge)) cParts.push('revenue ' + fmtNum(cd.revRatio, 1) + '\u00d7 in 2 yrs');
      if (rk.cyc.sectorBoost) cParts.push('cyclical sector \u00d71.15');
      if (rk.cyc.capped) cParts.push('capped at 0.80 \u2014 only ' + rk.cyc.sigCount + ' signals have data');
      if (rk.cyc.limitedHistory) cParts.push('limited history (<5 yrs) \u2014 margin & drawdown signals skipped');
      // Short one-line note on the row; the full signal breakdown
      // lives behind the (i), with the explainer (Justin's ask,
      // 2026-11-01: the blurb was too long out in the open).
      var cNote = 'Peak-cycle check vs its own history';
      if (!rk.cyc.gatePassed) cNote += ' \u00b7 gate not met, no adjustment';
      else if (rk.cyc.limitedHistory) cNote += ' \u00b7 limited history';
      var cDetail = INFO_TEXT.cycsev + (cParts.length ? '<br><br>This stock: ' + esc(cParts.join(' \u00b7 ')) + '.' : '');
      html += '<tr><td><strong>Cyclical earnings risk</strong>' + infoDot('cycsev') + '<div class="factor-note">' + esc(cNote) + '</div></td><td>Severity ' + fmtNum(rk.cyc.severity, 2) + '</td><td class="num"><button type="button" class="pts-btn" data-mathbtn data-mathtarget="math-cyc" aria-expanded="false"><strong>+' + rk.cycAdj + '</strong></button></td></tr>';
      html += '<tr class="info-row"><td colspan="3"><span class="info-text" data-info-text="cycsev">' + cDetail + '</span></td></tr>';
      var cycMath = 'Risk added = (100 \u2212 base ' + rk.base + ') \u00d7 severity ' + fmtNum(rk.cyc.severity, 2) + ' \u00d7 0.6 = +' + rk.cycAdj + ' \u2192 final ' + rk.score + '.';
      if (cParts.length) cycMath = 'Severity ' + fmtNum(rk.cyc.severity, 2) + ': ' + cParts.join(' \u00b7 ') + '.<br>' + cycMath;
      html += '<tr class="math-row" id="math-cyc" hidden><td colspan="3"><div class="math-box">' + cycMath + '</div></td></tr>';
    }
    html += '</table>';
    if (rk.cyc && cycSig.length) {
      html += '<p class="fineprint">Base risk ' + rk.base + ' \u00b7 cyclical adjustment +' + rk.cycAdj + ' \u00b7 final ' + rk.score + '. Higher = riskier \u00b7 base scaled to 100 over factors with data (' + rk.maxAvailable + ' pts).</p>';
    } else {
      html += '<p class="fineprint">Higher = riskier \u00b7 scaled to 100 over factors with data (' + rk.maxAvailable + ' pts).</p>';
    }
  }

  html += radarCardHtml(d);

  /* Collapsed header shows ONLY the pass count (Justin's ask,
   * 2026-11-07) — the per-check flags live in the expanded body. */
  html += '<button type="button" class="section-h screen-toggle" data-stoggle="vs"><span class="screen-name">Value screen \u2014</span> <span class="gold-text screen-count">' + passCount + ' of ' + knownCount + '</span><span class="screen-chev">\u25be</span></button>';
  html += '<div class="screen-chips" data-sbody="vs" hidden>';
  screen.forEach(function (s) {
    var cls = s.test === null ? '' : s.test ? 'pass' : 'fail';
    var mark = s.test === null ? '?' : s.test ? '✓ PASS' : '✗';
    html += '<div class="chip ' + cls + '"><span>' + esc(s.label) + '<br><span class="factor-note">' + esc(s.value) + '</span></span><span class="mark">' + mark + '</span></div>';
  });
  html += '</div>';

  var rScreen = riskScreen(d);
  var rKnown = rScreen.filter(function (s) { return s.test !== null; }).length;
  var rPass = rScreen.filter(function (s) { return s.test === true; }).length;
  html += '<button type="button" class="section-h screen-toggle" data-stoggle="rs"><span class="screen-name">Risk screen \u2014</span> <span class="gold-text screen-count">' + rPass + ' of ' + rKnown + ' clear</span><span class="screen-chev">\u25be</span></button>';
  html += '<div class="screen-chips" data-sbody="rs" hidden>';
  rScreen.forEach(function (s) {
    var cls = s.test === null ? '' : s.test ? 'pass' : 'fail';
    var mark = s.test === null ? '?' : s.test ? '\u2713 CLEAR' : '\u2717 FLAG';
    html += '<div class="chip ' + cls + '"><span>' + esc(s.label) + '<br><span class="factor-note">' + esc(s.value) + '</span></span><span class="mark">' + mark + '</span></div>';
  });
  html += '</div>';

  html += '<div class="section-h">Key <span class="gold-text">stats</span></div><div class="kv-grid">';
  html += kvItem('Market cap', fmtCap(d.marketCap), 'mktcap');
  html += kvItem('Forward P/E', isNum(d.forwardPE) ? fmtNum(d.forwardPE, 2) + (d.forwardPECalc ? ' (calc.)' : '') : '—', 'fwpe');
  html += kvItem('P/E (trailing)', isNum(d.pe) ? fmtNum(d.pe, 2) : '—', 'pe');
  html += kvItem('PEG', isNum(d.peg) ? fmtNum(d.peg, 2) + (d.pegCalc ? ' (calc.)' : '') : '—', 'peg');
  html += kvItem('EPS (trailing)', isNum(d.epsTTM) ? fmtNum(d.epsTTM) : '—', 'epsttm');
  html += kvItem('EPS growth next yr', isNum(d.epsGrowthNextY) ? fmtPct(d.epsGrowthNextY) : '—', 'epsgrowth');
  if (d.epsRecord && d.epsRecord.n >= 4) {
    html += kvItem('EPS miss rate · last ' + d.epsRecord.n + ' qtrs', d.epsRecord.missPct + '%', 'epsmiss');
    html += kvItem('EPS beat rate · last ' + d.epsRecord.n + ' qtrs', d.epsRecord.beatPct + '%', 'epsbeat');
  }
  html += kvItem('Revenue growth (TTM)', isNum(d.salesGrowthTTM) ? fmtPct(d.salesGrowthTTM) : '—', 'revttm');
  if (isNum(d.revGrowthQtr)) {
    html += kvItem('Revenue growth (latest qtr)', fmtPct(d.revGrowthQtr), 'revqtr');
  }
  html += kvItem('Gross margin', isNum(d.grossMargin) ? fmtNum(d.grossMargin, 1) + '%' : '—', 'gmargin');
  html += kvItem('Operating margin', isNum(d.operMargin) ? fmtNum(d.operMargin, 1) + '%' : '—', 'omargin');
  html += kvItem('Profit margin', isNum(d.profitMargin) ? fmtNum(d.profitMargin, 1) + '%' : '—', 'pmargin');
  html += kvItem('Debt / Equity', isNum(d.debtEq) ? fmtNum(d.debtEq, 2) : '—', 'debteq');
  html += kvItem('ROE', isNum(d.roe) ? fmtNum(d.roe, 1) + '%' : '—', 'roe');
  html += kvItem('Beta', isNum(d.beta) ? fmtNum(d.beta, 2) : '—', 'beta');
  html += kvItem('52-wk range', (isNum(d.low52) ? fmtNum(d.low52, 0) : '—') + ' – ' + (isNum(d.high52) ? fmtNum(d.high52, 0) : '—'), 'range52');
  html += kvItem('Below 52-wk high', isNum(d.pctBelowHigh) ? fmtNum(d.pctBelowHigh, 1) + '%' : '—', 'belowhigh');
  html += kvItem('Analyst 1-yr target', isNum(d.target1Y) ? fmtMoney(d.target1Y) : '—', 'target');
  if (isNum(d.instOwn)) html += kvItem('Institutional ownership', fmtNum(d.instOwn, 1) + '%', 'instown');
  html += '</div>';

  html += cashDebtHtml(d);

  html += dividendHtml(d);

  var profitWarn = epsProfitWarning(d);
  if (profitWarn) html += '<div class="alert warn">⚠ ' + esc(profitWarn) + '</div>';

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
    html += '<p class="fineprint">Written on demand by AI from the live numbers here, recent headlines and 10-K risks.</p>' +
      '<button class="btn-ghost" id="ai-swot-btn" type="button">✦ Generate AI SWOT</button>';
  }
  html += '</div>';

  var swot = buildSwot(d);
  html += '<div class="section-h">SWOT — <span class="gold-text">from the numbers</span></div>';
  html += '<div class="swot-grid">' +
    swotBox('S', 'Strengths', swot.S, 'sw-s') + swotBox('W', 'Weaknesses', swot.W, 'sw-w') +
    swotBox('O', 'Opportunities', swot.O, 'sw-o') + swotBox('T', 'Threats', swot.T, 'sw-t') + '</div>';
  html += '<p class="fineprint">Auto-generated from the figures on this page — numbers only, no news.</p>';

  html += '<div class="sc-actions">' +
    '<button class="btn-ghost" id="sc-watch" type="button">◎ Add to watchlist</button>' +
    '<button class="btn-ghost" id="sc-journal" type="button">✎ Journal this stock</button>' +
    '<button class="btn-ghost" id="sc-project" type="button">✦ Project it</button>' +
    '<button class="btn-ghost" id="sc-refresh" type="button">↻ Refresh data</button>' +
    '<a class="btn-ghost sc-ext" href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=' + esc(d.ticker) + '&type=&dateb=&owner=include&count=10" target="_blank" rel="noopener">SEC filings ↗</a></div>';

  html += stockNewsSectionHtml('sc', d.ticker);

  var when = d.fetchedAt ? new Date(d.fetchedAt).toLocaleString() : '';
  if (d.partial) html += '<div class="alert warn">Fast data is in — still pulling valuation details (forward P/E, PEG, margins)… the score updates when they land.</div>';
  html += '<p class="src-line">Sources: ' + esc(d.sources.join(', ') || '—') + ' · Fetched ' + esc(when) + (d.fromCache ? ' (cached, ≤15 min old)' : '') +
    (d.route ? ' · Route: ' + esc(d.route === 'public relay' ? 'public relay (backup)' : d.route) : '') +
    '. Figures can differ slightly between sources and from your broker. Research tool, not financial advice.</p>';
  html += '</div>';
  $('score-result').innerHTML = html;
  $('score-empty').style.display = 'none';
  projStripFill('sc-proj', d.ticker);
  loadStockNews('sc', d.ticker);

  /* The zone's button is "Regenerate" when a saved SWOT is showing
   * (a deliberate fresh take -> refresh flag) and "Generate" when it
   * isn't (cache-first is fine there). */
  bindAiSwotBtn(d, !!(aiSaved && aiSaved.swot));
  maybeShowSharedSwot(d);
  document.querySelectorAll('[data-stoggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var body = document.querySelector('[data-sbody="' + b.getAttribute('data-stoggle') + '"]');
      if (!body) return;
      body.hidden = !body.hidden;
      b.classList.toggle('open', !body.hidden);
    });
  });
  renderScChart(d);
  $('sc-watch').addEventListener('click', function () {
    addToWatchlist(d.ticker, isNum(d.price) ? d.price : null);
    switchTab('watchlist');
  });
  $('sc-journal').addEventListener('click', function () {
    jrReturnTab = 'scorecard';
    switchTab('journal');
    startJournalEdit(d.ticker);
  });
  $('sc-project').addEventListener('click', function () {
    switchTab('tools');
    setTool('pj');
    $('pj-ticker').value = d.ticker;
    fillProjection(d);
    runProjection();
    pjEnsureExitData(d).then(function () {
      if (String($('pj-mult').value) !== String(pjMultAuto) || ($('pj-ticker').value || '').trim().toUpperCase() !== d.ticker) return;
      if (!pjApplyAuto(d)) return;
      pjSetLoadedStatusParts('Loaded ' + d.ticker + ' from the scorecard', [pjPeNote]);
      runProjection();
    });
  });
  $('sc-refresh').addEventListener('click', function () { runSearch(d.ticker, true); });
}

async function runSearch(ticker, fresh) {
  var rawQ = String(ticker || '').trim();
  if (!rawQ) return;
  var T = await resolveTickerInput(rawQ);
  if (!T) return;
  if (T !== rawQ.toUpperCase()) { var siEl = $('search-input'); if (siEl) siEl.value = T; }
  scWin = null;
  scWinTicker = null;
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
    { label: 'P/E (trailing) ↓', get: function (d) { return d.pe; }, fmt: function (v) { return fmtNum(v, 2); }, best: 'min' },
    { label: 'PEG ↓', get: function (d) { return d.peg; }, fmt: function (v) { return fmtNum(v, 2); }, best: 'min' },
    { label: 'P/S ↓', get: function (d) { return d.ps; }, fmt: function (v) { return fmtNum(v, 2); }, best: 'min' },
    { label: 'P/B ↓', get: function (d) { return d.pb; }, fmt: function (v) { return fmtNum(v, 2); }, best: 'min' },
    { label: 'P/FCF ↓', get: function (d) { return d.pfcf; }, fmt: function (v) { return fmtNum(v, 2); }, best: 'min' },
    { label: 'Below 52-wk high', get: function (d) { return d.pctBelowHigh; }, fmt: function (v) { return fmtNum(v, 1) + '%'; }, best: 'max' },
    { label: 'EPS growth next yr', get: function (d) { return d.epsGrowthNextY; }, fmt: function (v) { return fmtPct(v); }, best: 'max' },
    { label: 'EPS growth past yr', get: function (d) { return d.epsGrowthTTM; }, fmt: function (v) { return fmtPct(v); }, best: 'max' },
    { label: 'EPS growth 5-yr', get: function (d) { return d.epsGrowth5Y; }, fmt: function (v) { return fmtPct(v); }, best: 'max' },
    { label: 'Revenue growth (TTM)', get: function (d) { return d.salesGrowthTTM; }, fmt: function (v) { return fmtPct(v); }, best: 'max' },
    { label: 'Profit margin', get: function (d) { return d.profitMargin; }, fmt: function (v) { return fmtNum(v, 1) + '%'; }, best: 'max' },
    { label: 'Gross margin', get: function (d) { return d.grossMargin; }, fmt: function (v) { return isNum(v) ? fmtNum(v, 1) + '%' : '\u2014'; }, best: 'max' },
    { label: 'Operating margin', get: function (d) { return d.operMargin; }, fmt: function (v) { return isNum(v) ? fmtNum(v, 1) + '%' : '\u2014'; }, best: 'max' },
    { label: 'ROE', get: function (d) { return d.roe; }, fmt: function (v) { return isNum(v) ? fmtNum(v, 1) + '%' : '\u2014'; }, best: 'max' },
    { label: 'Debt / Equity ↓', get: function (d) { return d.debtEq; }, fmt: function (v) { return fmtNum(v, 2); }, best: 'min' },
    { label: 'Current ratio', get: function (d) { return d.currentRatio; }, fmt: function (v) { return fmtNum(v, 2); }, best: 'max' },
    { label: 'Beta ↓', get: function (d) { return d.beta; }, fmt: function (v) { return fmtNum(v, 2); }, best: 'min' },
    { label: 'Dividend yield', get: function (d) { return d.divYield; }, fmt: function (v) { return isNum(v) ? fmtNum(v, 2) + '%' : '\u2014'; }, best: 'max' },
    { label: 'Value screen', get: function (d) { return valueScreen(d).filter(function (s) { return s.test === true; }).length; }, fmt: function (v) { return v + ' / 5'; }, best: 'max' },
    { label: 'Score', get: function (d) { return scoreStock(d).score; }, fmt: function (v) { return isNum(v) ? v + ' / 100' : '—'; }, best: 'max' },
    { label: 'Risk score \u2193', get: function (d) { var rk = riskScore(d); return rk && isNum(rk.score) ? rk.score : null; }, fmt: function (v) { return isNum(v) ? v + ' / 100' : '—'; }, best: 'min' },
  ];
  var html = '<div class="card"><table class="cmp"><tr><th></th>';
  ok.forEach(function (d) { html += '<th class="num"><span class="cmp-th">' + logoTile(d.ticker, 'sm') + esc(d.ticker) + '</span></th>'; });
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
  var failed = results.filter(function (r) { return r.error; }).map(function (r) { return r.ticker; });
  if (failed.length) html += '<div class="alert warn">Couldn\'t load ' + esc(failed.join(', ')) + ' — check the ticker, or try again in a moment.</div>';
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
var pjDivYield = null, pjDivYieldTicker = null; /* dividend yield (%) captured for the builder's ticker at load/restore */
var pjCurPe = null, pjCurPeTicker = null; /* current trailing P/E captured the same way, for the bear-case rule */
var PJ_KEY = 'sr_projections_v1';
function getProjections() { return lsGet(PJ_KEY, {}); }
function setProjections(p) { lsSet(PJ_KEY, p); }
/* The implied Base-case price of a saved projection, recomputed from its
 * stored EPS path (base case = the path as-is at the saved exit P/E). */
function pjSavedBase(T) {
  var s = getProjections()[T];
  if (!s || !isNum(s.baseEps) || !isNum(s.mult) || !Array.isArray(s.path)) return null;
  var off = (s.path.length && s.path[0].ttm) ? 1 : 0;
  var feps = pjCaseEps(s.baseEps, s.path.slice(0, (s.years || 3) + off), 1);
  return isNum(feps) ? Math.max(0, feps * s.mult) : null;
}
/* Base-case CAGR of a saved projection: implied end price vs the price at
 * save time, annualized over the saved horizon -- comparable across
 * projections even when they use different year counts. */
function pjSavedCagr(T) {
  var s = getProjections()[T];
  var fp = pjSavedBase(T);
  if (!s || !isNum(fp) || !isNum(s.price) || s.price <= 0 || !isNum(s.years) || s.years < 1 || fp <= 0) return null;
  var divF = isNum(s.divYield) && s.divYield > 0 ? Math.pow(1 + s.divYield / 100, s.years) : 1;
  return (Math.pow(fp / s.price * divF, 1 / s.years) - 1) * 100;
}
/* Headless base-case projection for the watchlist (Justin's ask,
 * 2026-11-10): the SAME math as the Projection Builder -- consensus
 * EPS path extended to 4 years at the trend growth rate, the auto
 * exit P/E (pjComputeExitPe), dividends reinvested at today's yield
 * -- but computed without touching the builder's UI state, so a
 * watchlist row can show the 4-year CAGR. Returns %/yr or null when
 * the stock has no analyst EPS path or no usable exit multiple. */
var WL_PROJ_YEARS = 4;
function wlProjectCagr(d) {
  if (!d || !isNum(d.price) || d.price <= 0) return null;
  var base = isNum(d.epsTTM) ? d.epsTTM : (isNum(d.epsNextY) ? d.epsNextY :
    (d.epsForecasts && d.epsForecasts[0] ? d.epsForecasts[0].eps : null));
  if (!isNum(base)) return null;
  var years = WL_PROJ_YEARS;
  var rows = [];
  if (isNum(d.epsTTM)) rows.push({ label: 'TTM', eps: d.epsTTM, growth: isNum(d.epsGrowthTTM) ? d.epsGrowthTTM : null, ttm: true, extrapolated: false });
  var fc = (d.epsForecasts || []).filter(function (r) { return r && isNum(r.eps); }).slice(0, 5);
  if (!fc.length) return null;
  fc.forEach(function (r, i) {
    var ym = String(r.fiscalEnd || '').match(/(\d{4})/);
    rows.push({ label: ym ? 'FY' + ym[1] : 'Year ' + (i + 1), eps: r.eps, extrapolated: false });
  });
  // Extend to `years` forecast rows at the trend rate, exactly like
  // pjEnsureYears: fit on the real forecast growths only, clamp to
  // that window's range, floor at -99.
  var target = years + (rows[0].ttm ? 1 : 0);
  var gAll = pjGrowths(base, rows), series = [], prevEps = base;
  rows.forEach(function (r, i) {
    if (!r.ttm && !r.extrapolated && isNum(gAll[i]) && isNum(prevEps) && prevEps > 0 && isNum(r.eps) && r.eps > 0) series.push(gAll[i]);
    if (isNum(r.eps)) prevEps = r.eps;
  });
  var added = 0, guard = 0;
  while (rows.length < target && guard++ < 5) {
    var prev = rows.length ? rows[rows.length - 1].eps : base;
    var g = pjTrendGrowthAt(series, added);
    if (!isNum(g)) g = series.length ? series[series.length - 1] : (isNum(d.epsGrowthNextY) ? d.epsGrowthNextY : null);
    if (!isNum(g) || !isNum(prev)) return null;
    g = Math.max(g, -99);
    added++;
    rows.push({ label: 'Year ' + rows.length, eps: +(prev * (1 + g / 100)).toFixed(4), extrapolated: true });
  }
  var feps = pjCaseEps(base, rows.slice(0, target), 1);
  if (!isNum(feps)) return null;
  var res = pjComputeExitPe(d);
  var mult = res ? res.mult : (isNum(d.pe5yAvg) ? d.pe5yAvg : (isNum(d.pe) ? d.pe : null));
  if (!isNum(mult)) return null;
  var fp = feps * mult;
  if (fp < 0) fp = 0;
  var divF = isNum(d.divYield) && d.divYield > 0 ? Math.pow(1 + d.divYield / 100, years) : 1;
  var tot = fp > 0 ? (fp / d.price) * divF : fp / d.price;
  var cagr = fp > 0 ? (Math.pow(tot, 1 / years) - 1) * 100 : -100;
  return cagr < -100 ? -100 : cagr;
}

function pjSaveCurrent() {
  var T = ($('pj-ticker').value || '').trim().toUpperCase();
  if (!T) { window.alert('Load a stock first -- a saved projection needs a ticker.'); return; }
  if (!isNum(parseFloat($('pj-price').value)) || !isNum(pjBaseEps()) || !isNum(parseFloat($('pj-mult').value))) {
    window.alert('Fill in price, EPS base and exit P/E before saving.'); return;
  }
  var all = getProjections();
  all[T] = {
    savedAt: new Date().toISOString(),
    price: parseFloat($('pj-price').value), baseEps: pjBaseEps(),
    flatGrowth: pjFlatGrowth(), years: pjYearsWanted(),
    mult: parseFloat($('pj-mult').value),
    divYield: (T === pjDivYieldTicker && isNum(pjDivYield)) ? pjDivYield : null,
    curPe: (T === pjCurPeTicker && isNum(pjCurPe)) ? pjCurPe : null,
    path: JSON.parse(JSON.stringify(pjPath)), fromForecast: pjPathFromForecast
  };
  setProjections(all);
  renderPjSaved();
  runProjection();
}
/* A restored projection's stored P/E is as of its save date (or
 * missing entirely on saves from before the bear-P/E rule). Refresh
 * it in the background so the rule always runs on TODAY'S P/E;
 * re-runs the build only if the value actually changed. */
async function pjRefreshCurPe(T) {
  try {
    var html = await relayFetch('https://finviz.com/stock?t=' + encodeURIComponent(T));
    if (!html || html.indexOf('snapshot-td-label') === -1) return;
    var v = parseNum(parseFinviz(html)['P/E']);
    if (isNum(v) && v > 0 && pjCurPeTicker === T && pjCurPe !== v) { pjCurPe = v; runProjection(); }
  } catch (e) {}
}
function pjRestore(T) {
  var s = getProjections()[T];
  if (!s) return;
  pjLoaded = null;
  pjMultAuto = null;
  pjExitDetail = null;
  pjDivYieldTicker = T; pjDivYield = isNum(s.divYield) ? s.divYield : null;
  pjCurPeTicker = T; pjCurPe = (isNum(s.curPe) && s.curPe > 0) ? s.curPe : null;
  $('pj-ticker').value = T;
  if (isNum(s.price)) $('pj-price').value = s.price;
  if (isNum(s.baseEps)) $('pj-eps').value = s.baseEps;
  if (isNum(s.flatGrowth)) $('pj-growth').value = s.flatGrowth;
  if (isNum(s.years)) $('pj-years').value = s.years;
  if (isNum(s.mult)) $('pj-mult').value = s.mult;
  pjPath = JSON.parse(JSON.stringify(s.path || []));
  pjPathFromForecast = !!s.fromForecast;
  renderPjPath();
  runProjection();
  pjRefreshCurPe(T);
  var st = $('pj-status');
  pjStatusBits = null;
  st.className = 'status';
  st.textContent = 'Showing your saved projection for ' + T + ' (saved ' + String(s.savedAt || '').slice(0, 10) + '). Price and EPS are as saved -- load the ticker again any time for live numbers.';
}
function renderPjSaved() {
  var box = $('pj-saved');
  if (!box) return;
  var all = getProjections();
  var ts = Object.keys(all).sort();
  if (!ts.length) { box.innerHTML = '<p class="fineprint">No saved projections yet — build one above and tap "Save projection" to keep it here.</p>'; return; }
  // Collapsible (Justin's call, 2026-10-25): the list only grows, and
  // restoring is occasional — collapsed by default, state remembered.
  var open = !!lsGet('sr_pjsaved_open', false);
  box.innerHTML = '<button type="button" class="pj-saved-head" id="pj-saved-toggle"><span>Saved projections \u00b7 ' + ts.length + '</span><span class="pj-saved-chev">' + (open ? '\u25b4' : '\u25be') + '</span></button>' +
    (open ? ts.map(function (T) {
      var base = pjSavedBase(T);
      return '<div class="pf-buy-row"><button class="pf-buy-txt" data-pj-open="' + esc(T) + '"><span>' + esc(T) + '</span><span>saved ' + esc(String(all[T].savedAt || '').slice(0, 10)) + (isNum(base) ? ' \u00b7 Base ' + fmtMoney(base) : '') + '</span></button><button class="link-btn danger" data-pj-del="' + esc(T) + '">\u2715</button></div>';
    }).join('') : '');
  var tg = $('pj-saved-toggle');
  if (tg) tg.addEventListener('click', function () { lsSet('sr_pjsaved_open', !open); renderPjSaved(); });
  box.querySelectorAll('[data-pj-open]').forEach(function (b) {
    b.addEventListener('click', function () { pjRestore(b.getAttribute('data-pj-open')); });
  });
  box.querySelectorAll('[data-pj-del]').forEach(function (b) {
    b.addEventListener('click', function () {
      var a2 = getProjections();
      delete a2[b.getAttribute('data-pj-del')];
      setProjections(a2);
      renderPjSaved();
      runProjection();
    });
  });
}

function pjBaseEps() { var v = parseFloat($('pj-eps').value); return isNum(v) ? v : null; }
function pjYearsWanted() {
  var y = parseInt($('pj-years').value, 10);
  return isNum(y) ? Math.max(1, Math.min(10, y)) : 3;
}
function pjFlatGrowth() {
  var g = parseFloat($('pj-growth').value);
  return isNum(g) ? g : 15;
}
/* Extrapolated years fade from the last known growth toward the long-run
 * rate (the flat-growth box), closing half the remaining gap per year --
 * so a one-year spike like +84.6% cools off instead of repeating forever. */
/* Extrapolated growth from the TREND of the EPS growth series
 * (Justin's ask, 2026-11-01 -- replaces fading the last growth rate
 * toward the flat fallback). Least-squares line over the LAST 5
 * years of growth rates only; extrapolated years continue along the
 * line, but the result is capped at that window's highest growth
 * and floored at its lowest -- the trend can never project a growth
 * rate outside the range of the past 5 years. One point: no trend
 * to fit, hold it flat. No points: null, and the caller uses the
 * flat fallback rate. stepsAhead is 0 for the first added year. */
function pjTrendGrowthAt(series, stepsAhead) {
  if (!series || !series.length) return null;
  var win = series.slice(-5);
  if (win.length === 1) return win[0];
  var k = win.length, sx = 0, sy = 0, sxx = 0, sxy = 0, lo = Infinity, hi = -Infinity;
  for (var i = 0; i < k; i++) {
    sx += i; sy += win[i]; sxx += i * i; sxy += i * win[i];
    if (win[i] < lo) lo = win[i];
    if (win[i] > hi) hi = win[i];
  }
  var den = k * sxx - sx * sx;
  var b = den ? (k * sxy - sx * sy) / den : 0;
  var a = (sy - b * sx) / k;
  var g = a + b * (k + stepsAhead);
  return Math.min(hi, Math.max(lo, g));
}
/* Growth % of each path year vs the prior year's EPS (year 1 vs base). */
function pjGrowths(base, path) {
  var out = [], prev = base;
  for (var i = 0; i < path.length; i++) {
    if (path[i].ttm) {
      // The TTM row IS the current position: its growth is the actual
      // trailing-twelve-month growth, a reported figure, not a step.
      out.push(isNum(path[i].growth) ? path[i].growth : null);
      prev = path[i].eps;
      continue;
    }
    /* Growth % is always shown, measured against |prev| so the sign
     * tells the truth even when EPS is negative (Justin's call,
     * 2026-11-01): the change divided by the SIZE of last year's EPS.
     * A shrinking loss (-4.97 -> -3.38) is +32%, a deepening one
     * (-3.66 -> -4.97) is -35.8%, turning profitable (-1.48 -> +5.20)
     * is +451%. For positive pairs this is the ordinary formula.
     * pjCaseEps and the growth edit box use the matching construction
     * (prev + |prev| x g), so displayed values chain back exactly. */
    out.push(isNum(prev) && prev !== 0 && isNum(path[i].eps) ? ((path[i].eps - prev) / Math.abs(prev)) * 100 : null);
    prev = path[i].eps;
  }
  return out;
}
function pjTtmOffset() { return (pjPath.length && pjPath[0].ttm) ? 1 : 0; }
/* Pure case math: chain the EPS path with every year's growth scaled by
 * factor (1 = Base, 0.8 = Bear, 1.2 = Bull) and return the exit-year EPS.
 * Exported for testing. */
function pjCaseEps(base, path, factor) {
  var growths = pjGrowths(base, path);
  var eps = base, pPrev = base;
  for (var i = 0; i < path.length; i++) {
    if (path[i].ttm) { if (isNum(path[i].eps)) { eps = path[i].eps; pPrev = path[i].eps; } continue; }
    var g = growths[i];
    if (!isNum(g) || !isNum(eps) || !isNum(path[i].eps)) { eps = path[i].eps; }
    else if (pPrev <= 0) {
      /* While EPS is at or below zero a % cannot compound (and scaling
       * a negative growth rate inverts Bear/Bull -- Bull came out below
       * Base on CoreWeave). Scale the year's DOLLAR step instead: the
       * recovery (or slide) shrinks in Bear, stretches in Bull, and the
       * cases stay ordered. Once EPS is positive, growth scaling (the
       * documented rule) takes over. */
      eps = eps + (path[i].eps - pPrev) * factor;
    } else {
      eps = eps + Math.abs(eps) * ((g * factor) / 100);
    }
    if (isNum(path[i].eps)) pPrev = path[i].eps;
  }
  return eps;
}
/* Grow the path to at least n years, extrapolating past the last known
 * year at that year's growth (or the flat fallback rate). */
function pjEnsureYears(n) {
  var base = pjBaseEps(), guard = 0;
  // Fit the growth trend ONCE, on the real forecast years only --
  // extrapolated rows never feed the fit.
  var gAll = pjGrowths(base, pjPath), series = [], prevEps = base;
  pjPath.forEach(function (r, i) {
    if (!r.ttm && !r.extrapolated && isNum(gAll[i]) && isNum(prevEps) && prevEps > 0 && isNum(r.eps) && r.eps > 0) series.push(gAll[i]);
    if (isNum(r.eps)) prevEps = r.eps;
  });
  var added = 0;
  while (pjPath.length < n && guard++ < 5) {
    var prevEps = pjPath.length ? pjPath[pjPath.length - 1].eps : base;
    var g = pjTrendGrowthAt(series, added);
    if (!isNum(g)) g = pjFlatGrowth();
    g = Math.max(g, -99);
    added++;
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
function pjSynthPath(ttmRow) {
  pjPath = ttmRow ? [ttmRow] : [];
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
  var n = pjYearsWanted() + pjTtmOffset();
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
    if (isNum(v) && pjPath[i]) {
      pjPath[i].eps = v; pjPath[i].extrapolated = false;
      if (pjPath[i].ttm) $('pj-eps').value = v;
      renderPjPath();
    }
  } else if (t.hasAttribute('data-pjg')) {
    var j = parseInt(t.getAttribute('data-pjg'), 10);
    var gv = parseFloat(t.value);
    if (pjPath[j] && pjPath[j].ttm) {
      if (isNum(gv)) { pjPath[j].growth = gv; renderPjPath(); }
      return;
    }
    var prev = j === 0 ? base : (pjPath[j - 1] ? pjPath[j - 1].eps : null);
    if (isNum(gv) && isNum(prev) && pjPath[j]) {
      pjPath[j].eps = +(prev + Math.abs(prev) * (gv / 100)).toFixed(4);
      pjPath[j].extrapolated = false;
      renderPjPath();
    }
  }
}
var pjPeNote = '', pjMultAuto = null;
function fillProjection(d) {
  pjLoaded = d;
  if (isNum(d.price)) $('pj-price').value = d.price;
  var base = isNum(d.epsTTM) ? d.epsTTM : (isNum(d.epsNextY) ? d.epsNextY :
    (d.epsForecasts && d.epsForecasts[0] ? d.epsForecasts[0].eps : null));
  if (isNum(base)) $('pj-eps').value = base;
  if (isNum(d.epsGrowth5Y)) $('pj-growth').value = Math.max(-20, Math.min(60, Math.round(d.epsGrowth5Y)));
  else if (isNum(d.epsGrowthNextY)) $('pj-growth').value = Math.round(Math.max(-20, Math.min(60, d.epsGrowthNextY)));
  pjPeNote = '';
  pjExitDetail = null;
  // Year-by-year path: the first row is the current TTM position (EPS and
  // its actual TTM growth), then the analysts' forecast years, up to 5.
  var ttmRow = isNum(d.epsTTM) ? {
    label: 'TTM', eps: d.epsTTM,
    growth: isNum(d.epsGrowthTTM) ? d.epsGrowthTTM : null,
    ttm: true, extrapolated: false
  } : null;
  var fc = (d.epsForecasts || []).filter(function (r) { return r && isNum(r.eps); }).slice(0, 5);
  if (fc.length) {
    pjPathFromForecast = true;
    pjPath = (ttmRow ? [ttmRow] : []).concat(fc.map(function (r, i) {
      var ym = String(r.fiscalEnd || '').match(/(\d{4})/);
      return { label: ym ? 'FY' + ym[1] : 'Year ' + (i + 1), eps: r.eps, extrapolated: false };
    }));
  } else {
    pjSynthPath(ttmRow);
  }
  renderPjPath();
  // Exit P/E (Justin's trend-and-factors rule, locked 2026-11-10):
  // recent-weighted average P/E x growth factor x margin factor --
  // see pjComputeExitPe. Fallbacks live in pjApplyAuto (plain 5-yr
  // average P/E, then today's P/E). Always editable.
  pjApplyAuto(d);
  renderPjPath();
}
/* The loaded blurb: one visible line, everything else (what was
 * loaded, where the exit P/E came from) behind a More info dropdown. */
function pjSetLoadedStatus(details) {
  var status = $('pj-status');
  status.className = 'status';
  status.innerHTML = 'Adjust the assumptions below, then build.' +
    '<br><button type="button" class="pj-math-toggle" data-pjmore aria-expanded="false">More info <span class="pj-math-chev">\u25be</span></button>' +
    '<div class="pj-math"><p>' + esc(details) + '</p></div>';
}
var pjStatusHead = '', pjStatusBits = null;
function pjRenderLoadedStatus() {
  pjSetLoadedStatus(pjStatusHead + (pjStatusBits && pjStatusBits.length ? ' \u2014 ' + pjStatusBits.join(' \u00b7 ') : '') + '.');
}
function pjSetLoadedStatusParts(head, bits) {
  pjStatusHead = head;
  pjStatusBits = bits && bits.length ? bits.slice() : null;
  pjRenderLoadedStatus();
}
async function loadProjectionTicker() {
  var rawQ = ($('pj-ticker').value || '').trim();
  var T = await resolveTickerInput(rawQ);
  if (T && T !== rawQ.toUpperCase()) $('pj-ticker').value = T;
  var status = $('pj-status');
  if (!T) { status.className = 'status err'; status.textContent = 'Type a ticker first.'; return; }
  status.className = 'status';
  status.innerHTML = '<span class="spinner"></span>Loading live data for ' + esc(T) + '…';
  try {
    var peP = fetchPe5yAvg(T).catch(function () { return null; });
    var qmP = fetchQMetrics(T, 'y').catch(function () { return null; });
    var qmQP = fetchQMetrics(T, 'q').catch(function () { return null; });
    var d = await fetchStock(T);
    var pe5 = await peP;
    if (pe5) { d.pe5yAvg = pe5.avg; d.pe5yYears = pe5.years; d.peByYear = pe5.byYear; }
    var qm = await qmP;
    if (qm && qm.revenue) {
      var rmap = {};
      qm.periods.forEach(function (p, i) {
        var m = String(p).match(/(\d{4})/);
        if (m && isNum(qm.revenue[i])) rmap[parseInt(m[1], 10)] = qm.revenue[i];
      });
      if (Object.keys(rmap).length) d.revByYear = rmap;
      if (qm.eps) {
        var emap = {};
        qm.periods.forEach(function (p, i) {
          var m = String(p).match(/(\d{4})/);
          if (m && isNum(qm.eps[i])) emap[parseInt(m[1], 10)] = qm.eps[i];
        });
        if (Object.keys(emap).length) d.epsByYear = emap;
      }
    }
    if (qm && qm.est) {
      if (qm.est.grossMargin && qm.est.grossMargin.length) d.estGmExp = qm.est.grossMargin[0].value;
      if (qm.est.operMargin && qm.est.operMargin.length) d.estOmExp = qm.est.operMargin[0].value;
      if (qm.est.revFcst) d.revFcst = qm.est.revFcst;
    }
    if (qm && !d.yearly) buildYearly(d, qm);
    var qmQ = await qmQP;
    if (qmQ && qmQ.revenue) d.revQ = qmQ.revenue.slice();
    fillProjection(d);
    var bits = [];
    if (pjPeNote) bits.push(pjPeNote);
    if (isNum(d.price)) bits.push('price ' + fmtMoney(d.price));
    if (isNum(d.epsTTM)) bits.push('EPS (TTM) ' + fmtMoney(d.epsTTM));
    var fcBits = (d.epsForecasts || []).filter(function (r) { return r && isNum(r.eps); }).slice(0, 5);
    if (fcBits.length) bits.push('analyst EPS path ' + fcBits.map(function (r) { return fmtMoney(r.eps); }).join(' → '));
    if (isNum(d.epsGrowth5Y)) bits.push('analyst 5-yr EPS growth ' + fmtNum(d.epsGrowth5Y, 1) + '%/yr');
    else if (isNum(d.epsGrowthNextY)) bits.push('next-yr EPS growth ' + fmtNum(d.epsGrowthNextY, 1) + '%');
    pjDivYieldTicker = T; pjDivYield = isNum(d.divYield) ? d.divYield : null;
    pjCurPeTicker = T; pjCurPe = (isNum(d.pe) && d.pe > 0) ? d.pe : null;
    pjSetLoadedStatusParts('Loaded ' + T, bits);
    runProjection();
  } catch (e) {
    status.className = 'status err';
    status.textContent = e.message || 'Could not load that ticker.';
  }
}
function pjScenClass(maxLen) {
  return 'factors scen' + (maxLen >= 11 ? ' micro' : maxLen >= 9 ? ' tight' : '');
}
function runProjection() {
  var price = parseFloat($('pj-price').value);
  var base = pjBaseEps();
  var years = pjYearsWanted();
  var out = $('pj-result');
  if (!pjPath.length) pjSynthPath();
  pjEnsureYears(years + pjTtmOffset());
  pjRefreshAutoMult();
  var mult = parseFloat($('pj-mult').value);
  if (!isNum(price) || !isNum(base) || !isNum(mult)) {
    out.innerHTML = '<div class="alert warn">Fill in price, EPS base and exit P/E to build the projection.</div>'; return;
  }
  renderPjPath();
  var path = pjPath.slice(0, years + pjTtmOffset());
  var pjT = ($('pj-ticker').value || '').trim().toUpperCase();
  /* Bear exit P/E rule (Justin's call, 2026-11-03): if the stock's
   * CURRENT trailing P/E is lower than the calculated bear multiple
   * (base x 0.8), the bear case uses today's P/E instead -- the
   * market already prices the stock cheaper than the bear scenario
   * assumes. Only for the ticker whose P/E was captured at load. */
  var bearMult = mult * 0.8, bearPeUsed = false;
  if (pjT && pjT === pjCurPeTicker && isNum(pjCurPe) && pjCurPe > 0 && pjCurPe < bearMult) { bearMult = pjCurPe; bearPeUsed = true; }
  var scen = [
    { name: 'Bear', f: 0.8, m: bearMult },
    { name: 'Base', f: 1, m: mult },
    { name: 'Bull', f: 1.2, m: mult * 1.2 }
  ];
  var divY = (pjT && pjT === pjDivYieldTicker && isNum(pjDivYield) && pjDivYield > 0) ? pjDivYield : 0;
  var divF = divY > 0 ? Math.pow(1 + divY / 100, years) : 1;
  var rows = '', maxLen = 0, baseFp = null;
  scen.forEach(function (s) {
    var feps = pjCaseEps(base, path, s.f);
    if (!isNum(feps)) {
      rows += '<tr><td><strong>' + s.name + '</strong></td><td>—</td><td>' + fmtNum(s.m, 1) + '×</td><td class="num">—</td><td class="num">—</td><td class="num">—</td></tr>';
      return;
    }
    var fp = feps * s.m;
    if (fp < 0) fp = 0; // a share price cannot be negative
    if (s.name === 'Base') baseFp = fp;
    var tot = fp > 0 ? (fp / price) * divF : fp / price;
    var ret = (tot - 1) * 100;
    if (ret < -100) ret = -100; // a return cannot be worse than -100%
    var cagr = fp > 0 ? (Math.pow(tot, 1 / years) - 1) * 100 : -100;
    var eTxt = fmtMoney(feps), pTxt = fmtMoney(fp), rTxt = fmtPct(ret), cTxt = fmtPct(cagr), mTxt = fmtNum(s.m, 1) + '×';
    [eTxt, pTxt, rTxt, cTxt, mTxt].forEach(function (t) { if (t.length > maxLen) maxLen = t.length; });
    rows += '<tr><td><strong>' + s.name + '</strong></td><td>' + eTxt + '</td><td>' + mTxt + '</td>' +
      '<td class="num"><strong>' + pTxt + '</strong></td><td class="num ' + (ret >= 0 ? 'up' : 'down') + '">' + rTxt + '</td><td class="num">' + cTxt + '</td></tr>';
  });
  var html = '<table class="' + pjScenClass(maxLen) + '"><tr><th>Case</th><th>EPS in ' + years + 'y</th><th>Exit P/E</th><th class="num">Implied price</th><th class="num">Return</th><th class="num">CAGR</th></tr>' + rows;
  var curT = ($('pj-ticker').value || '').trim().toUpperCase();
  var savedPj = curT ? getProjections()[curT] : null;
  html += '</table>';
  /* Glanceable headline (Justin's ask, 2026-11-02): the base case in
   * one big line under the Bear/Base/Bull table — "NFLX \u2192 $222
   * by 2030" (arrow wording, Justin's pick 2026-11-02) — so the
   * expected outcome reads at a glance. Base implied
   * price matches the table ($222.66 there, cents dropped here);
   * the year is the path's final fiscal year. Only with a ticker
   * loaded and a real base price. */
  if (pjT && isNum(baseFp) && baseFp > 0) {
    var lastLbl = '';
    for (var li = path.length - 1; li >= 0; li--) { if (!path[li].ttm && path[li].label) { lastLbl = path[li].label; break; } }
    var ym = String(lastLbl).match(/(\d{4})/);
    var hpTxt = baseFp >= 1e12 ? fmtMoney(baseFp, 0) : (baseFp >= 10 ? '$' + Math.floor(baseFp).toLocaleString('en-US') : fmtMoney(baseFp));
    var hlTxt = pjT + ' \u2192 ' + hpTxt + (ym ? ' by ' + ym[1] : '');
    html += '<div class="pj-headline' + (hlTxt.length > 22 ? ' sm' : '') + '">' + esc(pjT) + ' \u2192 <span class="pj-hl-price">' + esc(hpTxt) + '</span>' + (ym ? ' by ' + ym[1] : '') + '</div>';
  }
  var growths = pjGrowths(base, path), exLine = '', gPrev = base, hasNeg = isNum(base) && base <= 0;
  for (var gi = 0; gi < path.length; gi++) {
    if (isNum(path[gi].eps) && path[gi].eps <= 0 && !path[gi].ttm) hasNeg = true;
    if (!exLine && !path[gi].ttm && isNum(growths[gi]) && isNum(gPrev) && gPrev > 0) {
      exLine = ' ' + esc(path[gi].label || '') + ': ' + fmtNum(growths[gi], 1) + '% \u2192 Bear ' + fmtNum(growths[gi] * 0.8, 1) + '% \u00b7 Bull ' + fmtNum(growths[gi] * 1.2, 1) + '%.';
    }
    if (isNum(path[gi].eps)) gPrev = path[gi].eps;
  }
  if (hasNeg) exLine += ' Years at or below $0 EPS can\u2019t compound a %, so Bear/Bull scale those years\u2019 dollar step by the same \u00d7 0.8 / \u00d7 1.2.';
  html += '<div class="pj-math-wrap"><button type="button" class="pj-math-toggle" data-pjmath aria-expanded="false">Show math <span class="pj-math-chev">\u25be</span></button>' +
    '<div class="pj-math">' +
    '<p><strong>Growth:</strong> each year\u2019s growth is scaled \u2014 Bear \u00d7 0.8, Base as entered, Bull \u00d7 1.2.' + exLine + '</p>' +
    '<p><strong>Exit P/E:</strong> your ' + fmtNum(mult, 1) + '\u00d7, scaled \u2014 Bear ' + fmtNum(bearMult, 1) + '\u00d7' + (bearPeUsed ? ' (today\u2019s P/E \u2014 lower than the scaled ' + fmtNum(mult * 0.8, 1) + '\u00d7, so the bear case uses it)' : ' (\u00d7 0.8)') + ' \u00b7 Bull ' + fmtNum(mult * 1.2, 1) + '\u00d7 (\u00d7 1.2).</p>' +
    (pjExitDetail && String($('pj-mult').value) === String(pjMultAuto) ? '<p><strong>Where the auto exit P/E came from:</strong> recent-weighted average P/E ' + fmtNum(pjExitDetail.base, 1) + '\u00d7 \u00d7 growth factor ' + fmtNum(pjExitDetail.growth, 2) + ' \u00d7 margin factor ' + fmtNum(pjExitDetail.margin, 2) + ' = ' + fmtNum(pjExitDetail.mult, 1) + '\u00d7. Recent years count most; a year whose earnings fell counts at the stock\u2019s healthy-years median P/E, not its spiked one. The growth factor fades the multiple when forecast revenue growth is slowing; the margin factor trims it when expected margins sit at their peak.</p>' : '') +
    '<p><strong>Implied price</strong> = final-year EPS \u00d7 that case\u2019s exit P/E.</p>' +
    '</div></div>';
  if (divY > 0) html += '<p class="fineprint">Return and CAGR include dividends at the current ' + fmtNum(divY, 2) + '% yield, reinvested.</p>';
  html += '<div class="pj-save-row"><button class="btn-gold" id="pj-save" type="button">' + (savedPj ? 'Update saved projection' : 'Save projection') + '</button>' +
    (savedPj
      ? '<span class="factor-note">Saved for ' + esc(curT) + ' on ' + esc(String(savedPj.savedAt || '').slice(0, 10)) + '</span><button class="link-btn danger" id="pj-del" type="button">Delete saved</button>'
      : '<span class="factor-note">' + (curT ? 'Saves these exact assumptions on this device. Open it later from the Watchlist or the saved list below.' : 'Load a stock above first -- saving needs a ticker.') + '</span>') + '</div>';
  out.innerHTML = html;
  var svB = $('pj-save'); if (svB) svB.addEventListener('click', pjSaveCurrent);
  var mtB = out.querySelector('[data-pjmath]');
  if (mtB) mtB.addEventListener('click', function () { var b = mtB.nextElementSibling; if (!b) return; var open = b.classList.toggle('open'); mtB.setAttribute('aria-expanded', open ? 'true' : 'false'); });
  var dlB = $('pj-del'); if (dlB) dlB.addEventListener('click', function () { var all = getProjections(); delete all[curT]; setProjections(all); renderPjSaved(); runProjection(); });
}
/* ================= Quarterly metrics tool =================
 * 12 reported quarters of fundamentals (StockAnalysis statement
 * pages, which normalize SEC filings), one metric at a time as a bar
 * chart. EPS also gets analyst-consensus bars for the next few
 * quarters (Nasdaq) — the only metric with a published quarterly
 * consensus; the rest are reported quarters only. */
var QM_KEY = 'sr_qmetrics_v1';
var qmMetric = 'revenue';
var qmFreq = 'q';
var qmWin = 2;
var QM_WIN_CHOICES = [2, 3, 5, 10];
var qmStore = { ticker: null, q: null, y: null };
function qmData() { return qmStore[qmFreq]; }
/* History window (Justin's ask, 2026-11-09): every chart shows the
 * last qmWin years by default — 2 years of annual bars, 8 quarters
 * of quarterly bars — adjustable up to 10 years via the History
 * chips. Slicing happens at render time on the finished series, so
 * Growth keeps its full-history lookback and estimates always ride
 * along after the reported window. CSV exports keep the full data. */
function qmWinCount() { return qmFreq === 'y' ? qmWin : qmWin * 4; }
function qmTail(arr, n) { return arr.length > n ? arr.slice(arr.length - n) : arr; }
function qmSegWindow(data) {
  if (!data || !data.years || data.years.length <= qmWin) return data;
  var cut = data.years.length - qmWin;
  var out = Object.assign({}, data);
  out.years = data.years.slice(cut);
  out.segments = (data.segments || []).map(function (sg) {
    var c = Object.assign({}, sg);
    if (sg.rev) c.rev = sg.rev.slice(cut);
    if (sg.op) c.op = sg.op.slice(cut);
    return c;
  });
  if (data.total) {
    var t = {};
    if (data.total.rev) t.rev = data.total.rev.slice(cut);
    if (data.total.op) t.op = data.total.op.slice(cut);
    out.total = t;
  }
  return out;
}
/* Export the statements behind the Charts tool as CSV (Justin's
 * pick from the Fiscal.ai comparison, 2026-11-03): the actuals the
 * app already fetched for this ticker and period view, raw dollars,
 * downloaded with the same Blob pattern as the backup export. */
function qmDownloadCsv(lines, suffix) {
  try {
    var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (qmStore.ticker || 'stock') + suffix;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  } catch (e) {}
}

function qmExportCsv() {
  if (qmMode === 'detail' && (qmMetric === 'segRev' || qmMetric === 'segOp')) {
    var sd = qmStore.seg;
    if (!sd || !sd.ok) return;
    var key = qmMetric === 'segRev' ? 'rev' : 'op';
    var head = ['Segment'].concat(sd.years.map(function (y) { return 'FY' + y; }));
    var lines = [head.join(',')];
    sd.segments.forEach(function (sg) {
      if (!sg[key]) return;
      lines.push(['"' + String(sg.name).replace(/"/g, '""') + '"'].concat(sg[key].map(function (v) { return isNum(v) ? String(Math.round(v)) : ''; })).join(','));
    });
    if (sd.total && sd.total[key]) {
      lines.push(['"Total"'].concat(sd.total[key].map(function (v) { return isNum(v) ? String(Math.round(v)) : ''; })).join(','));
    }
    qmDownloadCsv(lines, '_segments_' + key + '.csv');
    return;
  }
  if (qmMode === 'detail' && (qmMetric === 'peHist' || qmMetric === 'psHist')) {
    var rd = qmStore.ratios;
    if (!rd) return;
    var series = qmMetric === 'peHist' ? rd.pe : rd.ps;
    if (!series || !series.length) return;
    var rl = ['Fiscal year,' + (qmMetric === 'peHist' ? 'P/E ratio' : 'P/S ratio')];
    series.forEach(function (p) { rl.push(p.fy + ',' + p.v); });
    qmDownloadCsv(rl, qmMetric === 'peHist' ? '_pe_by_year.csv' : '_ps_by_year.csv');
    return;
  }
  if (qmMode === 'detail' && qmMetric === 'avEps') {
    var md = qmStore.mb;
    if (!md || !md.length) return;
    var ml = ['Quarter,Consensus estimate,Reported EPS'];
    md.forEach(function (p) { ml.push('"' + String(p.label).replace(/"/g, '""') + '",' + p.est + ',' + p.act); });
    qmDownloadCsv(ml, '_eps_vs_estimates.csv');
    return;
  }
  var d = qmData();
  if (!d || !d.periods || !d.periods.length) return;
  var cols = [['Period', 'periods'], ['Revenue', 'revenue'], ['Gross profit', 'grossProfit'],
    ['Operating income', 'operIncome'], ['Net income', 'netIncome'], ['EPS (diluted)', 'eps'],
    ['Free cash flow', 'fcf'], ['Shares outstanding', 'shares']];
  var lines = [cols.map(function (c) { return c[0]; }).join(',')];
  d.periods.forEach(function (p, i) {
    lines.push(cols.map(function (c, ci) {
      if (ci === 0) return '"' + String(p).replace(/"/g, '""') + '"';
      var v = d[c[1]] && d[c[1]][i];
      return isNum(v) ? String(Math.round(v * 10000) / 10000) : '';
    }).join(','));
  });
  try {
    var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (qmStore.ticker || 'stock') + '_' + (qmFreq === 'y' ? 'yearly' : 'quarterly') + '_financials.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  } catch (e) {}
}

function parseSAValueM(s) {
  if (s == null) return null;
  var t = String(s).replace(/[$,]/g, '').trim();
  if (!t || t === '-' || t === '\u2014') return null;
  var v = parseFloat(t);
  return isFinite(v) ? v : null;
}

function parseSAQuarterly(htmlIs, htmlCf, yearly, htmlBs) {
  var periods = null, byLabel = {};
  var head = yearly ? 'Fiscal Year' : 'Fiscal Quarter';
  [htmlIs, htmlCf, htmlBs].forEach(function (html) {
    if (!html) return;
    saTables(html).forEach(function (rows) {
      if (!rows.length || rows[0][0] !== head) return;
      if (!periods) {
        periods = rows[0].slice(1);
        if (yearly) periods = periods.filter(function (p) { return p !== 'TTM'; }).slice(0, 8);
        else periods = periods.slice(0, 12);
      }
      rows.slice(1).forEach(function (r) {
        if (byLabel[r[0]]) return;
        var vals = [];
        for (var i = 0; i < periods.length; i++) {
          var j = rows[0].indexOf(periods[i]);
          vals.push(j > 0 ? parseSAValueM(r[j]) : null);
        }
        byLabel[r[0]] = vals;
      });
    });
  });
  if (!periods) return null;
  function series(label, scale) {
    var raw = byLabel[label];
    if (!raw) return null;
    return raw.map(function (v) { return isNum(v) ? v * scale : null; }).reverse();
  }
  var M = 1e6;
  return {
    periods: periods.slice().reverse(),
    revenue: series('Revenue', M) || series('Total Revenue', M) || series('Revenue as Reported', M),
    grossProfit: series('Gross Profit', M),
    operIncome: series('Operating Income', M),
    netIncome: series('Net Income', M),
    eps: series('EPS (Diluted)', 1) || series('Earnings Per Share', 1),
    shares: series('Shares Outstanding (Diluted)', M) || series('Shares Outstanding (Basic)', M),
    fcf: series('Free Cash Flow', M),
    /* Cash & investments includes long-term investments so the three
     * balance-sheet series tie out: cash - debt = net cash (debt),
     * exactly as StockAnalysis computes it (verified on AAPL). */
    bsCash: (function () {
      var c = series('Cash & Short-Term Investments', M) || series('Cash & Equivalents', M);
      var lt = series('Long-Term Investments', M);
      if (!c || !lt) return c;
      return c.map(function (v, i) { return (isNum(v) && isNum(lt[i])) ? v + lt[i] : v; });
    })(),
    bsDebt: series('Total Debt', M),
    bsNet: series('Net Cash (Debt)', M)
  };
}

function qmEstLabel(fiscalEnd) {
  var m = String(fiscalEnd || '').match(/^([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  return m ? m[1] + ' \u2019' + m[2].slice(2) : String(fiscalEnd || '');
}

/* Estimate bars continue the reported quarter sequence (last reported
 * Q3 2026 -> estimates Q4 2026, Q1 2027, ...), so every axis label is
 * the same short 'Qn \u2019YY' shape and 17 bars never collide. */
function qmNextQLabels(lastLabel, n) {
  var m = String(lastLabel || '').match(/Q([1-4])\s*(\d{4})/);
  if (!m) return null;
  var q = parseInt(m[1], 10), y = parseInt(m[2], 10), out = [];
  for (var i = 0; i < n; i++) { q++; if (q > 4) { q = 1; y++; } out.push('Q' + q + ' \u2019' + String(y).slice(2)); }
  return out;
}

async function fetchQMetrics(T, freq) {
  var yearly = freq === 'y';
  var cache = lsGet(QM_KEY, {});
  var day = new Date().toDateString();
  if (cache[T] && cache[T].day === day && cache[T][freq] && 'shares' in cache[T][freq] && 'bsDebt' in cache[T][freq]) return cache[T][freq];
  var base = 'https://stockanalysis.com/stocks/' + encodeURIComponent(T) + '/financials/';
  var suffix = yearly ? '' : '?p=quarterly';
  var needle = yearly ? 'Fiscal Year' : 'Fiscal Quarter';
  var ok = function (t) { return t.indexOf(needle) !== -1; };
  var fcUrl = 'https://stockanalysis.com/stocks/' + encodeURIComponent(T) + '/forecast/';
  var pages = await Promise.all([
    relayFetch(base + 'income-statement/' + suffix, { timeout: 25000, validate: ok }).catch(function () { return null; }),
    relayFetch(base + suffix, { timeout: 25000, validate: ok }).catch(function () { return null; }),
    relayFetch(base + 'cash-flow-statement/' + suffix, { timeout: 25000, validate: ok }).catch(function () { return null; }),
    yearly ? relayFetch(fcUrl, { timeout: 25000, validate: function (t) { return t.indexOf('Period Ending') !== -1; } }).catch(function () { return null; }) : Promise.resolve(null),
    relayFetch(base + 'balance-sheet/' + suffix, { timeout: 25000, validate: ok }).catch(function () { return null; })
  ]);
  var data = parseSAQuarterly(pages[0] || pages[1], pages[2], yearly, pages[4]);
  data.est = yearly ? parseSAForecastMetrics(pages[3]) : null;
  if (!data || !data.revenue) throw new Error('No ' + (yearly ? 'annual' : 'quarterly') + ' statements found for \u201c' + T + '\u201d.');
  data.estEps = [];
  try {
    var fc = await relayJSON('https://api.nasdaq.com/api/analyst/' + encodeURIComponent(T) + '/earnings-forecast?assetclass=stocks');
    var tbl = yearly ? (fc && fc.data && fc.data.yearlyForecast) : (fc && fc.data && fc.data.quarterlyForecast);
    var q = (tbl && tbl.rows) || [];
    data.estEps = q.map(function (r) {
      return { label: qmEstLabel(r.fiscalEnd), eps: typeof r.consensusEPSForecast === 'number' ? r.consensusEPSForecast : parseNum(r.consensusEPSForecast) };
    }).filter(function (r) { return isNum(r.eps); });
  } catch (e) {}
  data.ticker = T;
  if (!cache[T] || cache[T].day !== day) cache[T] = { day: day };
  cache[T][freq] = data;
  lsSet(QM_KEY, cache);
  return data;
}

function fmtSharesShort(v) {
  if (!isNum(v)) return '\u2014';
  var sign = v < 0 ? '-' : '', a = Math.abs(v);
  if (a >= 1e9) return sign + fmtNum(a / 1e9, 2) + 'B';
  if (a >= 1e6) return sign + fmtNum(a / 1e6, 1) + 'M';
  return sign + fmtNum(a, 0);
}
function fmtMoneyShort(v) {
  if (!isNum(v)) return '\u2014';
  var sign = v < 0 ? '-' : '';
  return sign + fmtCap(Math.abs(v));
}

function qmShortQ(label) {
  return String(label || '').replace(/(\d{4})/, function (y) { return '\u2019' + y.slice(2); });
}

function qmBarsSVG(pts, fmt) {
  var w = 640, h = 224, padT = 32, padX = 6;
  var max = Math.max.apply(null, pts.map(function (p) { return p.value; }).concat([0]));
  var min = Math.min.apply(null, pts.map(function (p) { return p.value; }).concat([0]));
  var span = (max - min) || 1;
  var vfsEarly = pts.length <= 8 ? 16.5 : pts.length <= 13 ? 14.5 : 12.5;
  var bw = (w - padX * 2) / pts.length;
  /* Legibility fitting (Justin's screenshots, 2026-11-01: 12 bars of
   * "$794.1M" / "108.0M" ran together into one unreadable string).
   * Measure the widest label against its bar slot; if it cannot fit,
   * first compact the labels (794.1M -> 794M, 108.0M -> 108M, 67.0% ->
   * 67%), then shrink the label font just enough, floored at 10.5.
   * Small values (EPS $3.25, $1.2B) are never compacted. */
  var labs = pts.map(function (p) { return String(fmt(p.value)); });
  function qmCompact(t) {
    return t.replace(/(\d{3,})\.(\d)([MBK])(?!\d)/, function (m, a, b, u) { return String(parseInt(a, 10) + (parseInt(b, 10) >= 5 ? 1 : 0)) + u; })
            .replace(/\.0([MBK%])/, '$1');
  }
  function widest(ls) { return ls.reduce(function (a, t) { return Math.max(a, t.length); }, 0); }
  var vfs = vfsEarly;
  if (widest(labs) * vfs * 0.64 > bw * 0.98) {
    labs = labs.map(qmCompact);
    var est = widest(labs) * vfs * 0.64;
    if (est > bw * 0.98) vfs = Math.max(10.5, Math.floor(vfs * (bw * 0.98 / est) * 2) / 2);
  }
  // Negative bars carry their value label BELOW the bar; reserve enough
  // bottom room that it can never land on the axis labels (TSLA FCF
  // screenshot, 2026-10-31).
  var padB = min < 0 ? Math.ceil(vfs * 1.25) + 24 : 34;
  var zeroY = padT + (max / span) * (h - padT - padB);
  /* "You are here" (Justin's ask, 2026-11-07): the current period
   * gets an outline in the theme ink (white on dark, black on
   * light). The current period is the first estimate bar when
   * estimates are shown — that quarter/year is still in progress —
   * and otherwise the latest reported bar. */
  var nowI = -1;
  pts.forEach(function (p, i) { if (nowI < 0 && p.kind === 'est') nowI = i; });
  if (nowI < 0) nowI = pts.length - 1;
  var out = '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Metric chart">';
  out += '<line x1="' + padX + '" y1="' + zeroY + '" x2="' + (w - padX) + '" y2="' + zeroY + '" stroke="#3a372d" stroke-width="1"/>';
  pts.forEach(function (p, i) {
    var x = padX + i * bw + bw * 0.03, bwid = bw * 0.94;
    var y = zeroY - (p.value / span) * (h - padT - padB);
    var top = Math.min(y, zeroY), bot = Math.max(y, zeroY);
    // Positive = green, negative = red, both with a soft glow
    // (Justin's ask, 2026-10-26); estimates keep their faded look.
    var col = p.value >= 0 ? 'var(--neon-up)' : 'var(--neon-dn)';
    var fill = p.kind === 'est'
      ? 'fill:' + col + ';opacity:.45;filter:drop-shadow(0 0 4px ' + col + ')'
      : 'fill:' + col + ';filter:drop-shadow(0 0 6px ' + col + ')';
    if (i === nowI) fill += ';stroke:var(--ink);stroke-width:2.5';
    out += '<rect x="' + x.toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + bwid.toFixed(1) + '" height="' + Math.max(1.5, bot - top).toFixed(1) + '" rx="1.5" style="' + fill + '"/>';
    var ly = p.value >= 0 ? top - 8 : bot + vfs + 3;
    out += '<text x="' + (x + bwid / 2).toFixed(1) + '" y="' + ly.toFixed(1) + '" text-anchor="middle" font-size="' + vfs + '" font-weight="800" style="fill:var(--chart-val)">' + esc(labs[i]) + '</text>';
    if (p.axis) {
      var nowAxis = i === nowI;
      out += '<text x="' + (x + bwid / 2).toFixed(1) + '" y="' + (h - 8) + '" text-anchor="middle" font-size="12" font-weight="' + (nowAxis ? '800' : '700') + '" fill="' + (nowAxis ? 'var(--ink)' : '#8a8271') + '">' + esc(p.axis) + '</text>';
    }
  });
  return out + '</svg>';
}

var QM_METRICS = {
  revenue: { name: 'Revenue', kind: 'money', fmt: fmtMoneyShort, get: function (d, i) { return d.revenue && d.revenue[i]; } },
  netIncome: { name: 'Net income', kind: 'money', csize: true, fmt: fmtMoneyShort, get: function (d, i) { return d.netIncome && d.netIncome[i]; } },
  eps: { name: 'EPS (diluted)', kind: 'eps', fmt: function (v) { return '$' + fmtNum(v, 2); }, get: function (d, i) { return d.eps && d.eps[i]; } },
  fcf: { name: 'Free cash flow', kind: 'money', csize: true, fmt: fmtMoneyShort, get: function (d, i) { return d.fcf && d.fcf[i]; } },
  shares: { name: 'Shares outstanding', kind: 'shares', fmt: fmtSharesShort, get: function (d, i) { return d.shares && d.shares[i]; } },
  grossMargin: { name: 'Gross margin', kind: 'pct', fmt: function (v) { return fmtNum(v, 1) + '%'; }, get: function (d, i) { return (isNum(d.grossProfit && d.grossProfit[i]) && isNum(d.revenue && d.revenue[i]) && d.revenue[i] !== 0) ? d.grossProfit[i] / d.revenue[i] * 100 : null; } },
  operMargin: { name: 'Operating margin', kind: 'pct', fmt: function (v) { return fmtNum(v, 1) + '%'; }, get: function (d, i) { return (isNum(d.operIncome && d.operIncome[i]) && isNum(d.revenue && d.revenue[i]) && d.revenue[i] !== 0) ? d.operIncome[i] / d.revenue[i] * 100 : null; } },
  netMargin: { name: 'Net margin', kind: 'pct', fmt: function (v) { return fmtNum(v, 1) + '%'; }, get: function (d, i) { return (isNum(d.netIncome && d.netIncome[i]) && isNum(d.revenue && d.revenue[i]) && d.revenue[i] !== 0) ? d.netIncome[i] / d.revenue[i] * 100 : null; } },
  bsCash: { name: 'Cash & investments', kind: 'money', fmt: fmtMoneyShort, get: function (d, i) { return d.bsCash && d.bsCash[i]; } },
  bsDebt: { name: 'Total debt', kind: 'money', fmt: fmtMoneyShort, get: function (d, i) { return d.bsDebt && d.bsDebt[i]; } },
  bsNet: { name: 'Net cash (debt)', kind: 'money', fmt: fmtMoneyShort, get: function (d, i) { return d.bsNet && d.bsNet[i]; } },
  peHist: { name: 'P/E by year', special: true, fmt: function (v) { return fmtNum(v, 1) + '\u00d7'; }, get: function () { return null; } },
  psHist: { name: 'P/S by year', special: true, fmt: function (v) { return fmtNum(v, 1) + '\u00d7'; }, get: function () { return null; } },
  segRev: { name: 'Segment revenue', special: true, fmt: fmtMoneyShort, get: function () { return null; } },
  segOp: { name: 'Segment operating profit', special: true, fmt: fmtMoneyShort, get: function () { return null; } },
  avEps: { name: 'EPS vs estimates', special: true, fmt: function (v) { return '$' + fmtNum(v, 2); }, get: function () { return null; } }
};

/* ============ Charts pack (2026-11-03, from the Fiscal.ai list) ====
 * Segments (SEC 10-K segment note via the relay's /segments),
 * trailing P/E + P/S by year (StockAnalysis ratios), reported-vs-
 * estimated EPS (MarketBeat), balance-sheet metrics (in fetchQMetrics
 * above), and Values / Growth / % of revenue views for the standard
 * metrics. Special metrics load lazily into qmStore slots and render
 * through their own paths; the freq toggle does not apply to them. */
var SEGMENTS_URL = 'https://stock-research-relay.supplessayings-6e6.workers.dev/segments';
var qmView = 'values';
var qmMode = 'grid';
var qmPrevMode = 'grid';

async function fetchSegmentsApp(T) {
  var cache = lsGet('sr_seg_v1', {});
  var hit = cache[T];
  if (hit && (Date.now() - hit.at) < (hit.data && hit.data.ok ? 7 * 864e5 : 864e5)) return hit.data;
  var data = null;
  try {
    var r = await fetch(SEGMENTS_URL + '?ticker=' + encodeURIComponent(T));
    data = await r.json();
  } catch (e) {}
  if (!data || typeof data !== 'object') data = { ok: false };
  cache[T] = { at: Date.now(), data: data };
  lsSet('sr_seg_v1', cache);
  return data;
}

/* Any row of the StockAnalysis ratios table by fiscal year (the PE
 * version, parseSAPeByYear, feeds the Projection Builder; this one
 * also reads PS Ratio for the Charts tool). */
function parseSARatioByYear(html, label) {
  var out = [];
  if (!html) return out;
  saTables(html).forEach(function (rows) {
    if (!rows.length || rows[0][0] !== 'Fiscal Year' || out.length) return;
    var row = null;
    rows.forEach(function (r) { if (r[0] === label) row = r; });
    if (!row) return;
    for (var i = 1; i < rows[0].length; i++) {
      if (rows[0][i] === 'Current') continue;
      var ym = String(rows[0][i]).match(/(\d{4})/);
      var v = parseNum(row[i]);
      if (ym && isNum(v) && v > 0 && v < 1000) out.push({ fy: parseInt(ym[1], 10), v: v });
    }
  });
  out.sort(function (a, b) { return a.fy - b.fy; });
  return out;
}

async function fetchRatiosByYear(T) {
  var cache = lsGet('sr_ratios_v1', {});
  var day = new Date().toDateString();
  if (cache[T] && cache[T].day === day) return cache[T].data;
  var data = null;
  try {
    var html = await relayFetch('https://stockanalysis.com/stocks/' + encodeURIComponent(T) + '/financials/ratios/', {
      timeout: 25000, validate: function (t) { return t.indexOf('PE Ratio') !== -1; }
    });
    var pe = parseSARatioByYear(html, 'PE Ratio'), ps = parseSARatioByYear(html, 'PS Ratio');
    if (pe.length || ps.length) data = { pe: pe, ps: ps };
  } catch (e) {}
  cache[T] = { day: day, data: data };
  lsSet('sr_ratios_v1', cache);
  return data;
}

/* Reported vs consensus EPS per quarter (MarketBeat's earnings table,
 * the same parse the scorecard's EPS record uses) — last 8 quarters,
 * oldest first. */
async function fetchMbPairs(T) {
  var cache = lsGet('sr_mbchart_v1', {});
  var day = new Date().toDateString();
  if (cache[T] && cache[T].day === day) return cache[T].data;
  var data = null;
  try {
    var segs = ['NASDAQ', 'NYSE'];
    var html = await new Promise(function (resolve, reject) {
      var pending = segs.length, done = false;
      segs.forEach(function (sg) {
        relayFetch('https://www.marketbeat.com/stocks/' + sg + '/' + encodeURIComponent(T) + '/earnings/', {
          timeout: 15000,
          validate: function (t) { return t.indexOf('Reported EPS') !== -1 && t.indexOf('Consensus Estimate') !== -1; }
        }).then(function (text) { if (!done) { done = true; resolve(text); } })
          .catch(function () { pending--; if (pending === 0 && !done) reject(new Error('no earnings history')); });
      });
    });
    var rows = parseMBEarnings(html);
    if (rows.length >= 4) data = rows.slice(0, 8).reverse().map(function (r) {
      return { label: r.quarter || r.date, est: r.consensus, act: r.reported };
    });
  } catch (e) {}
  cache[T] = { day: day, data: data };
  lsSet('sr_mbchart_v1', cache);
  return data;
}

/* Lazy slot loader for the special metrics: undefined = not tried,
 * 'loading' = in flight, null = unavailable, object = data. */
function qmEnsure(slot, loader) {
  if (qmStore[slot] !== undefined) return qmStore[slot];
  qmStore[slot] = 'loading';
  loader(qmStore.ticker).then(function (data) {
    if (qmStore[slot] === 'loading') { qmStore[slot] = data; renderQm(); }
  }).catch(function () {
    if (qmStore[slot] === 'loading') { qmStore[slot] = null; renderQm(); }
  });
  return 'loading';
}

var SEG_COLORS = ['#F8C73D', '#4da3ff', '#2fbf71', '#ff8a5c', '#b78bff', '#37c8c3', '#ff5c7a', '#a3b86b', '#e0a458', '#7d8fb3'];
function segColor(s, si) { return (s.balance || s.corporate) ? '#6b6656' : SEG_COLORS[si % SEG_COLORS.length]; }

function qmStackedSVG(data, key, mini) {
  var years = data.years;
  var segs = data.segments.filter(function (sg) { return sg[key]; });
  var w = 640, h = mini ? 150 : 224, padT = mini ? 10 : 34, padB = 34, padX = 6;
  var tops = years.map(function (y, yi) {
    var pos = 0, neg = 0;
    segs.forEach(function (sg) { var v = sg[key][yi]; if (isNum(v)) { if (v >= 0) pos += v; else neg += v; } });
    return { pos: pos, neg: neg };
  });
  var max = Math.max.apply(null, tops.map(function (t) { return t.pos; }).concat([0]));
  var min = Math.min.apply(null, tops.map(function (t) { return t.neg; }).concat([0]));
  var span = (max - min) || 1;
  var bw = (w - padX * 2) / years.length;
  var zeroY = padT + (max / span) * (h - padT - padB);
  var out = '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Segment chart">';
  out += '<line x1="' + padX + '" y1="' + zeroY + '" x2="' + (w - padX) + '" y2="' + zeroY + '" stroke="#3a372d" stroke-width="1"/>';
  years.forEach(function (y, yi) {
    var x = padX + yi * bw + bw * 0.06, bwid = bw * 0.88, posAcc = 0, negAcc = 0;
    segs.forEach(function (sg, si) {
      var v = sg[key][yi];
      if (!isNum(v) || v === 0) return;
      var yTop, yBot;
      if (v >= 0) {
        var topV = posAcc + v;
        yTop = zeroY - (topV / span) * (h - padT - padB);
        yBot = zeroY - (posAcc / span) * (h - padT - padB);
        posAcc = topV;
      } else {
        var botV = negAcc + v;
        yBot = zeroY - (negAcc / span) * (h - padT - padB);
        yTop = zeroY - (botV / span) * (h - padT - padB);
        negAcc = botV;
      }
      out += '<rect x="' + x.toFixed(1) + '" y="' + yTop.toFixed(1) + '" width="' + bwid.toFixed(1) + '" height="' + Math.max(1.5, yBot - yTop).toFixed(1) + '" rx="1.5" style="fill:' + segColor(sg, si) + '"/>';
    });
    if (yi === years.length - 1 && (tops[yi].pos > 0 || tops[yi].neg < 0)) {
      var oTop = zeroY - (tops[yi].pos / span) * (h - padT - padB);
      var oBot = zeroY - (tops[yi].neg / span) * (h - padT - padB);
      out += '<rect x="' + x.toFixed(1) + '" y="' + oTop.toFixed(1) + '" width="' + bwid.toFixed(1) + '" height="' + Math.max(1.5, oBot - oTop).toFixed(1) + '" rx="1.5" style="fill:none;stroke:var(--ink);stroke-width:2.5"/>';
    }
    var tot = data.total && data.total[key] ? data.total[key][yi] : null;
    if (isNum(tot) && !mini) {
      out += '<text x="' + (x + bwid / 2).toFixed(1) + '" y="' + (zeroY - (tops[yi].pos / span) * (h - padT - padB) - 8).toFixed(1) + '" text-anchor="middle" font-size="15" font-weight="800" style="fill:var(--chart-val)">' + esc(fmtMoneyShort(tot)) + '</text>';
    }
    if (!mini || yi === 0 || yi === years.length - 1) {
      out += '<text x="' + (x + bwid / 2).toFixed(1) + '" y="' + (h - 8) + '" text-anchor="middle" font-size="12" font-weight="700" fill="#8a8271">' + y + '</text>';
    }
  });
  return out + '</svg>';
}

function qmSegLegend(data, key) {
  var segs = data.segments.filter(function (sg) { return sg[key]; });
  var yi = data.years.length - 1;
  var tot = data.total && data.total[key] ? data.total[key][yi] : null;
  var rows = segs.map(function (sg, si) {
    var v = sg[key][yi];
    var extra = '';
    if (isNum(v)) {
      if (key === 'op' && isNum(sg.rev && sg.rev[yi]) && sg.rev[yi] > 0) extra = ' \u00b7 ' + fmtNum(v / sg.rev[yi] * 100, 0) + '% margin';
      else if (isNum(tot) && tot > 0) extra = ' \u00b7 ' + fmtNum(v / tot * 100, 0) + '%';
    }
    return '<div class="qm-leg-row"><span class="qm-dot" style="background:' + segColor(sg, si) + '"></span><span class="qm-leg-name">' + esc(sg.name) + '</span><span class="qm-leg-val">' + (isNum(v) ? fmtMoneyShort(v) + extra : '\u2014') + '</span></div>';
  });
  return '<div class="qm-legend">' + rows.join('') + '</div>';
}

function renderQmSegments(key) {
  var box = $('qm-chart'), note = $('qm-note');
  var data = qmEnsure('seg', fetchSegmentsApp);
  if (data === 'loading') {
    box.innerHTML = '<div class="status"><span class="spinner"></span>Loading segment data\u2026</div>';
    note.textContent = '';
    return;
  }
  if (!data || !data.ok) {
    box.innerHTML = '<div class="status err">No segment breakdown in ' + esc(qmStore.ticker) + '\u2019s filings.</div>';
    note.textContent = 'Segment data comes from the 10-K segment note; single-segment companies have nothing to break down.';
    return;
  }
  if (key === 'op' && !data.profit) {
    box.innerHTML = '<div class="status err">' + esc(qmStore.ticker) + ' reports segment revenue only \u2014 no profit split in its filings.</div>';
    note.textContent = 'The Segment revenue view shows the split this company does report.';
    return;
  }
  if (key === 'rev' && !data.revenue) {
    box.innerHTML = '<div class="status err">No segment revenue split in ' + esc(qmStore.ticker) + '\u2019s filings.</div>';
    note.textContent = '';
    return;
  }
  var wd = qmSegWindow(data);
  box.innerHTML = '<div class="chart-wrap">' + qmStackedSVG(wd, key) + '</div>' + qmSegLegend(wd, key);
  note.textContent = 'Annual, as reported in the 10-K segment note (filed ' + data.filed + ') \u00b7 SEC EDGAR. Stacks sum to the reported total. The outlined column is the latest reported year.';
}

function qmPairsSVG(pairs, mini) {
  var w = 640, h = mini ? 150 : 224, padT = mini ? 10 : 36, padB = 34, padX = 6;
  var vals = [];
  pairs.forEach(function (p) { vals.push(p.est, p.act); });
  var max = Math.max.apply(null, vals.concat([0]));
  var min = Math.min.apply(null, vals.concat([0]));
  var span = (max - min) || 1;
  var bw = (w - padX * 2) / pairs.length;
  var zeroY = padT + (max / span) * (h - padT - padB);
  var lfs = pairs.length > 6 ? 10.5 : 11.5;
  var out = '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Reported versus estimated EPS">';
  out += '<line x1="' + padX + '" y1="' + zeroY + '" x2="' + (w - padX) + '" y2="' + zeroY + '" stroke="#3a372d" stroke-width="1"/>';
  pairs.forEach(function (p, i) {
    var slotX = padX + i * bw;
    var bwPair = bw * 0.40;
    var ex = slotX + bw * 0.05, ax = ex + bwPair + bw * 0.05;
    function bar(x, v, fill, bold, now) {
      var y = zeroY - (v / span) * (h - padT - padB);
      var top = Math.min(y, zeroY), bot = Math.max(y, zeroY);
      var r = '<rect x="' + x.toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + bwPair.toFixed(1) + '" height="' + Math.max(1.5, bot - top).toFixed(1) + '" rx="1.5" style="fill:' + fill + (now ? ';stroke:var(--ink);stroke-width:2.5' : '') + '"/>';
      if (mini) return r;
      return r + '<text x="' + (x + bwPair / 2).toFixed(1) + '" y="' + (v >= 0 ? top - 6 : bot + lfs + 3).toFixed(1) + '" text-anchor="middle" font-size="' + lfs + '" font-weight="' + (bold ? '800' : '600') + '" fill="' + (bold ? 'var(--chart-val)' : '#8a8271') + '">$' + fmtNum(v, 2) + '</text>';
    }
    out += bar(ex, p.est, '#5a5546', false, false);
    out += bar(ax, p.act, p.act >= p.est ? 'var(--neon-up)' : 'var(--neon-dn)', true, i === pairs.length - 1);
    if (!mini || i === 0 || i === pairs.length - 1) {
      out += '<text x="' + (slotX + bw / 2).toFixed(1) + '" y="' + (h - 8) + '" text-anchor="middle" font-size="12" font-weight="700" fill="#8a8271">' + esc(qmShortQ(p.label)) + '</text>';
    }
  });
  return out + '</svg>';
}

function renderQmAv() {
  var box = $('qm-chart'), note = $('qm-note');
  var data = qmEnsure('mb', fetchMbPairs);
  if (data === 'loading') {
    box.innerHTML = '<div class="status"><span class="spinner"></span>Loading earnings history\u2026</div>';
    note.textContent = '';
    return;
  }
  if (!data || !data.length) {
    box.innerHTML = '<div class="status err">No earnings history found for ' + esc(qmStore.ticker) + '.</div>';
    note.textContent = 'Reported-vs-estimate history comes from MarketBeat; coverage is US-listed stocks.';
    return;
  }
  var shown = qmTail(data, qmWin * 4);
  var beats = shown.filter(function (p) { return p.act >= p.est; }).length;
  box.innerHTML = '<div class="chart-wrap">' + qmPairsSVG(shown) + '</div>' +
    '<div class="qm-legend">' +
    '<div class="qm-leg-row"><span class="qm-dot" style="background:#5a5546"></span><span class="qm-leg-name">Consensus estimate</span></div>' +
    '<div class="qm-leg-row"><span class="qm-dot" style="background:var(--neon-up)"></span><span class="qm-leg-name">Reported EPS</span></div>' +
    '</div>';
  note.textContent = 'Reported EPS vs the consensus estimate for each quarter (MarketBeat) \u00b7 beat the estimate in ' + beats + ' of the last ' + shown.length + ' quarters. The outlined bar is the most recent quarter.';
}

function renderQmRatios(key) {
  var box = $('qm-chart'), note = $('qm-note');
  var data = qmEnsure('ratios', fetchRatiosByYear);
  if (data === 'loading') {
    box.innerHTML = '<div class="status"><span class="spinner"></span>Loading valuation history\u2026</div>';
    note.textContent = '';
    return;
  }
  var series = data ? (key === 'pe' ? data.pe : data.ps) : null;
  if (!series || !series.length) {
    box.innerHTML = '<div class="status err">No ' + (key === 'pe' ? 'P/E' : 'P/S') + ' history for ' + esc(qmStore.ticker) + '.</div>';
    note.textContent = 'Year-by-year multiples come from the StockAnalysis ratios table.';
    return;
  }
  var pts = qmTail(series.map(function (p) { return { label: 'FY ' + p.fy, value: p.v, kind: 'actual', axis: String(p.fy) }; }), qmWin);
  box.innerHTML = '<div class="chart-wrap">' + qmBarsSVG(pts, QM_METRICS[key === 'pe' ? 'peHist' : 'psHist'].fmt) + '</div>';
  note.textContent = (key === 'pe' ? 'Price / earnings' : 'Price / sales') + ' at each fiscal year end (StockAnalysis ratios) \u00b7 the current multiple is on the scorecard. The outlined bar is the latest fiscal year.';
}

/* Mini bar chart for grid cards: shape only (the card header
 * carries the latest value), first + last period labels. */
function qmMiniBarsSVG(pts) {
  var w = 640, h = 150, padT = 10, padB = 22, padX = 4;
  var max = Math.max.apply(null, pts.map(function (p) { return p.value; }).concat([0]));
  var min = Math.min.apply(null, pts.map(function (p) { return p.value; }).concat([0]));
  var span = (max - min) || 1;
  var bw = (w - padX * 2) / pts.length;
  var zeroY = padT + (max / span) * (h - padT - padB);
  var out = '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Mini chart">';
  out += '<line x1="' + padX + '" y1="' + zeroY + '" x2="' + (w - padX) + '" y2="' + zeroY + '" stroke="#3a372d" stroke-width="1"/>';
  pts.forEach(function (p, i) {
    var x = padX + i * bw + bw * 0.04, bwid = bw * 0.92;
    var y = zeroY - (p.value / span) * (h - padT - padB);
    var top = Math.min(y, zeroY), bot = Math.max(y, zeroY);
    var col = p.value >= 0 ? 'var(--neon-up)' : 'var(--neon-dn)';
    var msty = 'fill:' + col + ';opacity:.92';
    if (i === pts.length - 1) msty += ';stroke:var(--ink);stroke-width:2.5';
    out += '<rect x="' + x.toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + bwid.toFixed(1) + '" height="' + Math.max(1.5, bot - top).toFixed(1) + '" rx="1.5" style="' + msty + '"/>';
  });
  if (pts.length) {
    out += '<text x="' + padX + '" y="' + (h - 5) + '" font-size="12" font-weight="700" fill="#8a8271">' + esc(pts[0].label) + '</text>';
    out += '<text x="' + (w - padX) + '" y="' + (h - 5) + '" text-anchor="end" font-size="12" font-weight="700" fill="#8a8271">' + esc(pts[pts.length - 1].label) + '</text>';
  }
  return out + '</svg>';
}

function qmCardHtml(id, name, val, svg, wide) {
  return '<button type="button" class="qm-card' + (wide ? ' wide' : '') + '" data-qmopen="' + id + '">' +
    '<div class="qm-card-h"><span class="qm-card-name">' + esc(name) + '</span><span class="qm-card-val">' + esc(val) + '</span></div>' + svg + '</button>';
}
function qmLoadCardHtml(name) {
  return '<div class="qm-card"><div class="qm-card-h"><span class="qm-card-name">' + esc(name) + '</span></div><div class="qm-card-load"><span class="spinner"></span>Loading</div></div>';
}

/* The Charts grid: every metric as a small-multiples card on one
 * scrolling page; tap a card for the full chart. Standard metrics
 * read the loaded statements; the special ones (segments, ratios,
 * EPS-vs-estimates) fill in as their lazy loads land, and hide when
 * a company doesn't have them. */
/* Grid/detail tap wiring, registered exactly once. Called from
 * initApp and lazily from renderQmGrid -- whichever runs first -- so
 * the taps are live even if some other startup wiring ever fails. */
var qmWiringDone = false;
function ensureQmWiring() {
  if (qmWiringDone) return;
  qmWiringDone = true;
  document.querySelectorAll('[data-qmview]').forEach(function (b) {
    b.addEventListener('click', function () {
      qmView = b.getAttribute('data-qmview');
      renderQm();
    });
  });
  var qmGridEl = $('qm-grid');
  if (qmGridEl) qmGridEl.addEventListener('click', function (e) {
    var card = e.target && e.target.closest ? e.target.closest('[data-qmopen]') : null;
    if (!card) return;
    qmMetric = card.getAttribute('data-qmopen');
    qmMode = 'detail';
    renderQm();
  });
  var qmBackEl = $('qm-back');
  if (qmBackEl) qmBackEl.addEventListener('click', function () { qmMode = 'grid'; renderQm(); });
  var qmCloseEl = $('qm-close');
  if (qmCloseEl) qmCloseEl.addEventListener('click', function () { qmMode = 'grid'; renderQm(); });
  var qmOvEl = $('qm-overlay');
  if (qmOvEl) qmOvEl.addEventListener('click', function (e) {
    if (e.target === qmOvEl) { qmMode = 'grid'; renderQm(); }
  });
}

function renderQmGrid() {
  var grid = $('qm-grid');
  if (!grid) return;
  ensureQmWiring();
  var d = qmData();
  var groups = [];
  function stdCards(ids) {
    var out = [];
    if (!d) return out;
    ids.forEach(function (id) {
      var M = QM_METRICS[id], pts = [];
      d.periods.forEach(function (p, i) {
        var v = M.get(d, i);
        if (isNum(v)) pts.push({ label: qmShortQ(p), value: v });
      });
      if (pts.length) out.push(qmCardHtml(id, M.name, M.fmt(pts[pts.length - 1].value), qmMiniBarsSVG(qmTail(pts, qmWinCount())), false));
    });
    return out;
  }
  groups.push(['Money', stdCards(['revenue', 'netIncome', 'eps', 'fcf'])]);
  groups.push(['Margins', stdCards(['grossMargin', 'operMargin', 'netMargin'])]);
  groups.push(['Shares', stdCards(['shares'])]);
  groups.push(['Balance sheet', stdCards(['bsCash', 'bsDebt', 'bsNet'])]);
  var valCards = [];
  var ratios = qmEnsure('ratios', fetchRatiosByYear);
  if (ratios === 'loading') { valCards.push(qmLoadCardHtml('P/E by year')); }
  else if (ratios) {
    [['peHist', 'pe', 'P/E by year'], ['psHist', 'ps', 'P/S by year']].forEach(function (cfg) {
      var series = ratios[cfg[1]] || [];
      if (!series.length) return;
      var pts = series.map(function (p) { return { label: String(p.fy), value: p.v }; });
      valCards.push(qmCardHtml(cfg[0], cfg[2], QM_METRICS[cfg[0]].fmt(series[series.length - 1].v), qmMiniBarsSVG(qmTail(pts, qmWin)), false));
    });
  }
  groups.push(['Valuation', valCards]);
  var segCards = [];
  var seg = qmEnsure('seg', fetchSegmentsApp);
  if (seg === 'loading') { segCards.push(qmLoadCardHtml('Segments')); }
  else if (seg && seg.ok) {
    var yi = seg.years.length - 1;
    if (seg.revenue && seg.total && seg.total.rev) segCards.push(qmCardHtml('segRev', 'Segment revenue', fmtMoneyShort(seg.total.rev[yi]), qmStackedSVG(qmSegWindow(seg), 'rev', true), true));
    if (seg.profit && seg.total && seg.total.op) segCards.push(qmCardHtml('segOp', 'Segment operating profit', fmtMoneyShort(seg.total.op[yi]), qmStackedSVG(qmSegWindow(seg), 'op', true), true));
  }
  groups.push(['Segments', segCards]);
  var estCards = [];
  var mb = qmEnsure('mb', fetchMbPairs);
  if (mb === 'loading') { estCards.push(qmLoadCardHtml('EPS vs estimates')); }
  else if (mb && mb.length) {
    estCards.push(qmCardHtml('avEps', 'EPS vs estimates', '$' + fmtNum(mb[mb.length - 1].act, 2), qmPairsSVG(qmTail(mb, qmWin * 4), true), true));
  }
  groups.push(['Estimates', estCards]);
  var html = '';
  groups.forEach(function (g) {
    if (!g[1].length) return;
    html += '<div class="qm-grid-group">' + g[0] + '</div>' + g[1].join('');
  });
  grid.innerHTML = html || '<div class="status err">No chart data for ' + esc(qmStore.ticker || '') + '.</div>';
}

function renderQm() {
  var ov = $('qm-overlay'), det = $('qm-detail');
  document.querySelectorAll('[data-qmfreq]').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-qmfreq') === qmFreq);
    if (qmMode === 'grid') b.disabled = false;
  });
  document.querySelectorAll('[data-qmwin]').forEach(function (b) {
    b.classList.toggle('active', parseInt(b.getAttribute('data-qmwin'), 10) === qmWin);
  });
  if (qmMode === 'grid') {
    if (ov) ov.hidden = true;
    document.body.classList.remove('qm-lock');
    qmPrevMode = 'grid';
    renderQmGrid();
    return;
  }
  /* Detail opens as a popup sheet over the grid (the grid stays
   * rendered underneath), so the chart appears where the user is
   * instead of swapping the page under their scroll position. */
  if (ov) ov.hidden = false;
  document.body.classList.add('qm-lock');
  if (det && qmPrevMode !== 'detail') det.scrollTop = 0;
  qmPrevMode = 'detail';
  renderQmDetail();
}

function renderQmDetail() {
  document.querySelectorAll('[data-qm]').forEach(function (b) {
    b.classList.toggle('on', b.getAttribute('data-qm') === qmMetric);
  });
  var qmName = $('qm-metric-name'), qmActive = document.querySelector('[data-qm="' + qmMetric + '"]');
  if (qmName && qmActive) qmName.textContent = qmActive.textContent;
  var M = QM_METRICS[qmMetric];
  var special = !!M.special;
  document.querySelectorAll('[data-qmfreq]').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-qmfreq') === qmFreq);
    b.disabled = special;
  });
  if (qmView === 'csize' && !M.csize) qmView = 'values';
  var view = qmView;
  document.querySelectorAll('[data-qmview]').forEach(function (b) {
    var v = b.getAttribute('data-qmview');
    b.classList.toggle('active', v === view && !special);
    b.disabled = special || (v === 'csize' && !M.csize);
  });
  if (qmMetric === 'segRev') return renderQmSegments('rev');
  if (qmMetric === 'segOp') return renderQmSegments('op');
  if (qmMetric === 'avEps') return renderQmAv();
  if (qmMetric === 'peHist') return renderQmRatios('pe');
  if (qmMetric === 'psHist') return renderQmRatios('ps');
  var d = qmData();
  if (!d) return;
  /* View transforms (Values / Growth / % of revenue) run on the raw
   * per-period series; estimates are values-view only. Growth is
   * year-over-year (4 quarters back in quarterly view) and reads as
   * percentage points for the margin metrics. */
  var raw = d.periods.map(function (p, i) { return M.get(d, i); });
  var fmt = M.fmt;
  if (view === 'growth') {
    var lb = qmFreq === 'y' ? 1 : 4;
    fmt = M.kind === 'pct'
      ? function (v) { return (v >= 0 ? '+' : '') + fmtNum(v, 1) + ' pts'; }
      : function (v) { return (v >= 0 ? '+' : '') + fmtNum(v, 1) + '%'; };
    raw = raw.map(function (v, i) {
      var prev = (i - lb >= 0) ? raw[i - lb] : null;
      if (!isNum(v) || !isNum(prev) || prev === 0) return null;
      return M.kind === 'pct' ? v - prev : (v - prev) / Math.abs(prev) * 100;
    });
  } else if (view === 'csize') {
    fmt = function (v) { return fmtNum(v, 1) + '%'; };
    raw = raw.map(function (v, i) {
      var rev = d.revenue && d.revenue[i];
      return (isNum(v) && isNum(rev) && rev !== 0) ? v / rev * 100 : null;
    });
  }
  var pts = [];
  d.periods.forEach(function (p, i) {
    if (isNum(raw[i])) pts.push({ label: qmShortQ(p), value: raw[i], kind: 'actual' });
  });
  // History window: trim the reported points to the chosen span.
  // The view transforms above already ran on the full series, so a
  // Growth bar at the window's edge still has its year-ago value;
  // axis labels are computed on the shown points below, and the
  // estimates append after them as usual.
  pts = qmTail(pts, qmWinCount());
  // Sparse axis (Justin's ask): in quarterly view, mark only the first
  // bar of each year with the year; yearly view labels every bar.
  var lastYr = null;
  pts.forEach(function (p) {
    var ym = p.label.match(/(\d{4}|’\d{2})/);
    var yr = ym ? ym[1] : p.label;
    if (qmFreq === 'y') { p.axis = p.label; lastYr = yr; }
    else if (yr !== lastYr) { p.axis = '’' + String(yr).slice(-2); lastYr = yr; }
  });
  var estList = [];
  if (view === 'values') {
    if (qmMetric === 'eps' && d.estEps && d.estEps.length) estList = d.estEps.map(function (e) { return { label: e.label, value: e.eps }; });
    else if (d.est && d.est[qmMetric] && d.est[qmMetric].length) estList = d.est[qmMetric];
  }
  if (estList.length) {
    var lastP = d.periods[d.periods.length - 1];
    var seq = qmFreq === 'y' ? qmNextYLabels(lastP, estList.length) : qmNextQLabels(lastP, estList.length);
    estList.forEach(function (e, i) {
      var pt = { label: e.plabel ? qmShortQ(e.plabel) : ((seq && seq[i]) || e.label), value: e.value, kind: 'est' };
      var ym = pt.label.match(/(\d{4}|’\d{2})/);
      var yr = ym ? ym[1] : pt.label;
      if (qmFreq === 'y') pt.axis = pt.label;
      else if (yr !== lastYr) { pt.axis = '’' + String(yr).slice(-2); lastYr = yr; }
      pts.push(pt);
    });
  }
  var box = $('qm-chart');
  if (!pts.length) {
    box.innerHTML = '<div class="status err">No ' + esc(M.name) + ' data in the statements for ' + esc(d.ticker) + '.</div>';
  } else {
    box.innerHTML = '<div class="chart-wrap">' + qmBarsSVG(pts, fmt) + '</div>';
  }
  var per = qmFreq === 'y' ? 'years' : 'quarters';
  var note = $('qm-note');
  if (view === 'growth') {
    note.textContent = 'Year-over-year change for each reported ' + (qmFreq === 'y' ? 'year' : 'quarter') + (M.kind === 'pct' ? ', in percentage points for margins' : '') + ' \u00b7 SEC filings via StockAnalysis. Estimates are shown in the Values view. The outlined bar is the latest reported ' + (qmFreq === 'y' ? 'year' : 'quarter') + '.';
  } else if (view === 'csize') {
    note.textContent = 'Each bar is the period\u2019s value as a % of that same period\u2019s revenue \u00b7 SEC filings via StockAnalysis. Estimates are shown in the Values view. The outlined bar is the latest reported ' + (qmFreq === 'y' ? 'year' : 'quarter') + '.';
  } else {
    var hasEst = pts.some(function (p) { return p.kind === 'est'; });
    note.textContent = !hasEst
      ? 'Reported ' + per + ' only \u2014 SEC filings via StockAnalysis. No free consensus is published for this metric in this view. The outlined bar is the latest reported ' + (qmFreq === 'y' ? 'year' : 'quarter') + '.'
      : qmMetric === 'eps'
        ? 'Solid bars: reported ' + per + ' (SEC filings via StockAnalysis). Faded bars: analyst consensus for the next few ' + per + ' (Nasdaq). The outlined bar is the current ' + (qmFreq === 'y' ? 'fiscal year' : 'quarter') + ', still in progress.'
        : 'Solid bars: reported years (SEC filings via StockAnalysis). Faded bars: analyst consensus for the current fiscal year (StockAnalysis) \u2014 deeper years are paywalled there, so only EPS runs further out (via Nasdaq). Quarterly consensus is published only for EPS. The outlined bar is the current fiscal year, still in progress.';
  }
}

/* Yearly estimate labels continue the reported fiscal years:
 * last reported 'FY 2025' -> estimates 'FY \u201926', 'FY \u201927', ... */
function qmNextYLabels(lastLabel, n) {
  var m = String(lastLabel || '').match(/(\d{4})/);
  if (!m) return null;
  var y = parseInt(m[1], 10), fy = String(lastLabel).indexOf('FY') !== -1, out = [];
  for (var i = 0; i < n; i++) { y++; out.push((fy ? 'FY ' : '') + '\u2019' + String(y).slice(2)); }
  return out;
}

async function loadQm() {
  var rawQ = String(($('qm-ticker').value || '')).trim();
  if (!rawQ) return;
  var T = await resolveTickerInput(rawQ);
  if (!T) return;
  if (T !== rawQ.toUpperCase()) $('qm-ticker').value = T;
  if (qmStore.ticker !== T) { qmStore = { ticker: T, q: null, y: null }; qmMode = 'grid'; }
  var st = $('qm-status');
  var yearly = qmFreq === 'y';
  try {
    if (!qmStore[qmFreq]) {
      st.innerHTML = '<span class="spinner"></span>Loading ' + (yearly ? 'annual' : 'quarterly') + ' statements for ' + esc(T) + '\u2026';
      qmStore[qmFreq] = await withTimeout(fetchQMetrics(T, qmFreq), 45000,
        'Loading timed out for ' + T + ' — check the name or ticker and try again.');
    }
    var d = qmData();
    st.textContent = d.ticker + ' \u00b7 last ' + d.periods.length + ' reported ' + (yearly ? 'years' : 'quarters');
    $('qm-body').hidden = false;
    renderQm();
  } catch (e) {
    $('qm-body').hidden = true;
    st.innerHTML = '<span class="status err">' + esc(e.message || 'Could not load data.') + '</span>';
  }
}

function runCompound() {
  var init = parseFloat($('cc-init').value) || 0;
  var monthly = parseFloat($('cc-monthly').value) || 0;
  var years = parseInt($('cc-years').value, 10) || 0;
  if (!isFinite(init)) init = 0;
  if (!isFinite(monthly)) monthly = 0;
  if (years > 200) years = 200; // the loop below runs years x 12 times: an absurd year count would hang the tab
  var rate = parseFloat($('cc-rate').value);
  var out = $('cc-result');
  if (!isNum(rate) || years < 1) { out.innerHTML = '<div class="alert warn">Enter a return rate and at least 1 year.</div>'; return; }
  var r = rate / 100 / 12, bal = init, series = [init], contributed = init;
  for (var m = 1; m <= years * 12; m++) {
    bal = bal * (1 + r) + monthly;
    contributed += monthly;
    /* Pin absurd magnitudes so the series (and therefore the
     * chart math) stays finite no matter what was typed. */
    if (Math.abs(bal) > 1e300) bal = bal < 0 ? -1e300 : 1e300;
    if (contributed > 1e300) contributed = 1e300;
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
var WLVAL_KEY = 'sr_wlval_v2';
var WLSORT_KEY = 'sr_wlsort_v1';
function getWlSort() {
  try { return localStorage.getItem(WLSORT_KEY) || 'added'; } catch (e) { return 'added'; }
}
/* Best available valuation for a watchlist row, synchronously: a recent
 * full scorecard fetch wins; otherwise the saved Finviz-only score. */
function wlValuationDisplay(T) {
  var cache = lsGet(CACHE_KEY, {});
  var hit = cache[T];
  if (hit && hit.data) {
    // Any cached scorecard record beats a blank line: show its score even
    // when stale (fresh=false still triggers the background refetch).
    var sc = scoreStock(hit.data);
    if (sc.score != null) {
      var rk = riskScore(hit.data);
      return { score: sc.score, verdict: sc.verdict, risk: rk.score, riskOverlay: !!hit.data.yearly, fresh: (Date.now() - hit.ts) < CACHE_TTL };
    }
  }
  var map = lsGet(WLVAL_KEY, {});
  var e = map[T];
  if (e && isNum(e.score)) return { score: e.score, verdict: e.verdict, risk: isNum(e.risk) ? e.risk : null, riskOverlay: e.riskOverlay === true, fresh: (Date.now() - (e.at || 0)) < 24 * 3600 * 1000 };
  return null;
}
/* Watchlist valuation pass. Finviz covers most fields, but two risk
 * factors need data Finviz alone can't supply: the EPS path (Nasdaq
 * yearly consensus -> EPS-trend factor + cliff tests) and the revenue
 * path (StockAnalysis -> boom-bust factor). Without them riskScore
 * normalizes over a smaller factor pool and inflates the number --
 * RH read Risk 80 here vs 52 on the scorecard (2026-10-29) because
 * its 60 raw risk points were divided by a 75-pt pool instead of
 * the full 100. Fetch both so the watchlist and the scorecard
 * compute risk over the same factors. */
var WLAUX_KEY = 'sr_wlaux_v1';
async function fetchWlValuation(T) {
  var d = { ticker: T, sources: [], errors: [] };
  // The EPS path and revenue path move at most daily, so they are
  // day-cached per ticker; a same-day refresh then only re-fetches
  // the Finviz quote. All three fetches fire in parallel -- run
  // sequentially they tripled each row's wait (2026-10-29).
  var auxCache = lsGet(WLAUX_KEY, {});
  var day = new Date().toDateString();
  var aux = (auxCache[T] && auxCache[T].day === day) ? auxCache[T] : null;
  var cycHit = cycCachePeek(T);
  var parts = await Promise.all([
    relayFetch('https://finviz.com/stock?t=' + encodeURIComponent(T), {
      validate: function (t) { return t.indexOf('snapshot-td-label') !== -1; }
    }).catch(function () { return null; }),
    aux ? Promise.resolve(null) : relayJSON('https://api.nasdaq.com/api/analyst/' + encodeURIComponent(T) + '/earnings-forecast?assetclass=stocks').catch(function () { return null; }),
    aux ? Promise.resolve(null) : relayFetch('https://stockanalysis.com/stocks/' + encodeURIComponent(T) + '/forecast/', {
      timeout: 20000,
      validate: function (t) { return t.indexOf('Fiscal Year') !== -1 && t.indexOf('Revenue') !== -1; }
    }).catch(function () { return null; }),
    // Yearly statements for the cyclical overlay, loaded whenever
    // they are not already day-cached (see the overlay block below).
    cycHit ? Promise.resolve(null) : cycLoadYearly(T).catch(function () { return null; })
  ]);
  if (parts[0]) fillFromFinviz(d, parts[0]);
  if (aux) {
    d.epsForecasts = aux.epsForecasts || [];
    if (aux.revPath) d.revPath = aux.revPath;
  } else {
    var rows = (parts[1] && parts[1].data && parts[1].data.yearlyForecast && parts[1].data.yearlyForecast.rows) || [];
    d.epsForecasts = rows.map(function (r) {
      return {
        fiscalEnd: r.fiscalEnd,
        eps: typeof r.consensusEPSForecast === 'number' ? r.consensusEPSForecast : parseNum(r.consensusEPSForecast),
        high: parseNum(r.highEPSForecast),
        low: parseNum(r.lowEPSForecast),
        n: parseNum(r.noOfEstimates)
      };
    }).filter(function (r) { return isNum(r.eps); });
    if (parts[2]) {
      var rp = parseSAForecast(parts[2]);
      if (rp.length >= 3) d.revPath = rp;
    }
    auxCache[T] = { day: day, epsForecasts: d.epsForecasts || [], revPath: d.revPath || null };
    lsSet(WLAUX_KEY, auxCache);
  }
  // Cyclical overlay (Justin's rule, 2026-11-07): the watchlist risk
  // is ALWAYS the final score, never the base alone -- he asked what
  // the "base" label meant and then ruled it out. Today's yearly
  // statements usually sit in the cyclical cache already (a scorecard
  // visit or the scan enrichment); on a miss they were loaded in
  // parallel above and day-cached for every other surface. Only a
  // failed load leaves the risk at its base value for this pass.
  var cycData = cycHit || parts[3];
  if (cycData && cycData.yearly) {
    d.yearly = cycData.yearly;
    if (!d.revPath && cycData.revPath) d.revPath = cycData.revPath;
  }
  // EPS growth next yr: fiscal-year over fiscal-year, the scorecard's
  // rule -- Nasdaq FY pair first, Finviz pair as fallback.
  var nextFY = (d.epsForecasts && d.epsForecasts[0]) || null;
  var f1 = (d.epsForecasts && d.epsForecasts[1]) || null;
  if (nextFY && f1 && isNum(nextFY.eps) && isNum(f1.eps) && nextFY.eps > 0) {
    d.epsGrowthNextY = (f1.eps / nextFY.eps - 1) * 100;
  } else if (isNum(d.epsNextY) && isNum(d.epsThisY) && d.epsThisY > 0) {
    d.epsGrowthNextY = (d.epsNextY / d.epsThisY - 1) * 100;
  }
  var sc = scoreStock(d);
  if (sc.score == null) return null;
  var rk = riskScore(d);
  return { score: sc.score, verdict: sc.verdict, risk: rk.score, riskOverlay: !!d.yearly };
}

/* ============================== daily index scan ==============================
 * Once a day the app scans the whole S&P 500 and Russell 2000 for the
 * five best combined scores, using the same scoreStock() and
 * riskScore() as the scorecard: combined = 60% valuation + 40% safety
 * (100 - risk). His Cloudflare relay does the heavy lifting: its
 * /screen route extracts just the needed rows from Finviz's screener
 * pages (~2-4 KB per page instead of ~400 KB of HTML).
 *
 * PACING IS DELIBERATE (v2): Finviz rate-limits by IP — the relay's
 * egress included — and a 375-page burst earned 403s, which the first
 * version mistook for "page failed, drop it" and finalized a partial
 * scan as if it were complete. Now: 2 pages at a time with gaps,
 * a 25-second cool-down whenever the relay reports a Finviz block,
 * up to 5 tries per page, dropped pages remembered for Resume, and a
 * scan only counts as DONE when every page landed. Partial results
 * are labelled partial, with the true scored count. */
function wlValInner(v) {
  return 'Value <b style="color:hsl(' + Math.round(v.score * 1.2) + ', 78%, var(--val-l))">' + v.score + '</b>' +
    (isNum(v.risk) ? ' \u00b7 Risk <b style="color:hsl(' + Math.round((100 - v.risk) * 1.2) + ', 78%, var(--val-l))">' + v.risk + '</b>' : '');
}

/* Second watchlist line (2026-11-10): the projected 4-year CAGR and
 * the risk/reward score Justin defined -- CAGR divided by the risk
 * score, so it reads as growth earned per point of risk. A saved
 * projection's CAGR (the user's own assumptions) wins over the
 * auto-computed one when both exist. */
function wlDispCagr(r) {
  if (r && isNum(r.projCagr)) return r.projCagr;
  if (r && isNum(r.autoCagr)) return r.autoCagr;
  return null;
}
function wlProjInner(cagr, val) {
  if (!isNum(cagr)) return '';
  var s = '4-yr CAGR <b>' + (cagr >= 0 ? '+' : '') + fmtNum(cagr, 1) + '%/yr</b>';
  if (val && isNum(val.risk) && val.risk > 0) {
    s += ' \u00b7 R/R <b>' + fmtNum(cagr / val.risk, 2) + '</b>';
  }
  return s;
}

/* Background fill for stale watchlist scores. The old version fired
 * every stale ticker at once and blocked the first paint until the
 * slowest finished: a burst through one relay IP earns Finviz 403s,
 * so the refresh crawled (Justin's "still throttling", 2026-10-29).
 * Now: rows paint immediately with whatever is cached, then a pool
 * of 2 workers with a short gap walks the stale list, updating each
 * row in place as its score lands. */
var wlFillRunning = false;
async function wlFillPass(tickers) {
  if (wlFillRunning || !tickers.length) return;
  wlFillRunning = true;
  var queue = tickers.slice();
  var vmap = lsGet(WLVAL_KEY, {});
  async function worker() {
    while (queue.length) {
      var T = queue.shift();
      try {
        var v = await fetchWlValuation(T);
        if (v) {
          vmap[T] = { score: v.score, verdict: v.verdict, risk: v.risk, riskOverlay: v.riskOverlay, at: Date.now() };
          lsSet(WLVAL_KEY, vmap);
          var rowEls = document.querySelectorAll('#wl-list .wl-row');
          for (var i = 0; i < rowEls.length; i++) {
            if (rowEls[i].getAttribute('data-ticker') === T) {
              var valEl = rowEls[i].querySelector('.wl-val');
              if (valEl) valEl.innerHTML = wlValInner(v);
              break;
            }
          }
        }
      } catch (e) {}
      if (queue.length) await new Promise(function (res) { setTimeout(res, 250); });
    }
  }
  await Promise.all([worker(), worker()]);
  wlFillRunning = false;
}

/* Projected-CAGR cache: one full projection load per watchlist
 * ticker per day (the sub-loads are day-cached at their own layers,
 * so this is mostly assembly after the first run). A stored null
 * means "no analyst path today" and is not retried until tomorrow. */
var WLPROJ_KEY = 'sr_wlproj_v2';
function wlProjEntry(T) {
  var m = lsGet(WLPROJ_KEY, {});
  var e = m[T];
  return (e && e.day === new Date().toDateString()) ? e : null;
}
async function fetchWlProjCagr(T) {
  var ent = wlProjEntry(T);
  if (ent) return ent.cagr;
  var cagr = null;
  try {
    var d = await fetchStock(T);
    if (d) {
      await pjEnsureExitData(d);
      cagr = wlProjectCagr(d);
    }
  } catch (e) { cagr = null; }
  var m = lsGet(WLPROJ_KEY, {});
  m[T] = { day: new Date().toDateString(), cagr: isNum(cagr) ? cagr : null };
  lsSet(WLPROJ_KEY, m);
  return m[T].cagr;
}
var wlProjRunning = false;
async function wlProjPass(tickers) {
  if (wlProjRunning || !tickers.length) return;
  wlProjRunning = true;
  var queue = tickers.slice();
  var changed = false;
  async function worker() {
    while (queue.length) {
      var T = queue.shift();
      try {
        var cagr = await fetchWlProjCagr(T);
        if (isNum(cagr)) {
          changed = true;
          var rowEls = document.querySelectorAll('#wl-list .wl-row');
          for (var i = 0; i < rowEls.length; i++) {
            if (rowEls[i].getAttribute('data-ticker') === T) {
              var pEl = rowEls[i].querySelector('.wl-proj');
              if (pEl) pEl.innerHTML = wlProjInner(cagr, wlValuationDisplay(T));
              break;
            }
          }
        }
      } catch (e) {}
      if (queue.length) await new Promise(function (res) { setTimeout(res, 250); });
    }
  }
  await Promise.all([worker(), worker()]);
  wlProjRunning = false;
  // In risk/reward or CAGR sort mode the order itself depends on
  // these numbers, so re-render once they have all landed.
  if (changed && (getWlSort() === 'riskreward' || getWlSort() === 'cagr')) renderWatchlist(false);
}

var SCAN_URL = 'https://stock-research-relay.supplessayings-6e6.workers.dev/screen';
var SCAN_VIEWS = ['121', '161', '171'];
var SCAN_IDXS = [
  { key: 'spx', label: 'S&P 500' },
  { key: 'rut', label: 'Russell 2000' },
  { key: 'tot', label: 'Total Market' }
];
var SCAN_KEY = 'sr_scan_v4';
/* Rules stamp for saved scan states: bump when the ranking rules
 * change (eligibility gates, scoring) so a list computed under older
 * rules is recomputed from the stored dataset on the next open
 * instead of being re-shown all day. States saved before the stamp
 * existed read as undefined and mismatch once, by design. */
var SCAN_RULES_V = 3;
var scanRunning = false, scanActive = 0, scanCoolUntil = 0, scanTimer = null;

function scanTodayKey() { return pfKeyToISO(pfDkey(new Date())); }

/* ---------- earnings calendar (2026-11-03, from the Fiscal.ai
 * comparison): the user's watchlist + portfolio stocks reporting in
 * the next 14 days, from the Nasdaq earnings calendar (rides the
 * relay like everything else). Cached per day + ticker set; the
 * card renders instantly from cache and refreshes in the
 * background. Dates can shift -- the fineprint says so. ---------- */
var EARN_KEY = 'sr_earncal_v1';
var earnBusy = false;
function earnUserTickers() {
  var set = {};
  getWatchlist().forEach(function (x) { if (x.ticker) set[x.ticker] = true; });
  getPortfolio().forEach(function (p) { if (p.ticker && p.shares > 0) set[p.ticker] = true; });
  return Object.keys(set).sort();
}
function earnDays() {
  var out = [], base = new Date(scanTodayKey() + 'T12:00:00');
  for (var i = 0; i < 14; i++) out.push(pfKeyToISO(pfDkey(new Date(base.getTime() + i * 86400000))));
  return out;
}
async function earnFetchDay(iso) {
  try {
    var txt = await relayFetch('https://api.nasdaq.com/api/calendar/earnings?date=' + iso);
    if (!txt) return null;
    var j = JSON.parse(txt);
    var rows = (j && j.data && j.data.rows) || [];
    return rows.map(function (r) {
      return { s: String(r.symbol || '').toUpperCase(), n: r.name || '', t: r.time || '', eps: r.epsForecast || '' };
    }).filter(function (r) { return r.s; });
  } catch (e) { return null; }
}
function earnRender(box, cache, tickers) {
  var inSet = {};
  tickers.forEach(function (t) { inSet[t] = true; });
  var html = '<div class="card"><div class="scan-h">Earnings \u2014 your stocks <span class="scan-date">next 14 days</span></div>';
  var any = false;
  earnDays().forEach(function (iso) {
    var rows = ((cache.byDay || {})[iso] || []).filter(function (r) { return inSet[r.s]; });
    if (!rows.length) return;
    any = true;
    html += '<div class="scan-group">' + esc(new Date(iso + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })) + '</div>';
    rows.forEach(function (r) {
      var when = r.t === 'time-pre-market' ? 'before the open' : r.t === 'time-after-hours' ? 'after close' : '';
      html += '<button type="button" class="scan-row" data-earn-research="' + esc(r.s) + '">' + logoTile(r.s, 'sm') +
        '<span class="scan-id"><b>' + esc(r.s) + '</b><span class="scan-sub"><span class="scan-nm">' + esc(r.n) + '</span>' + (r.eps ? ' <span class="scan-cyc partial">est ' + esc(r.eps) + '</span>' : '') + '</span></span>' +
        '<span class="scan-px">' + esc(when) + '</span></button>';
    });
  });
  if (!any) html += '<div class="status">None of your stocks report in the next 14 days.</div>';
  html += '<p class="fineprint" style="margin-top:8px">From the Nasdaq earnings calendar \u00b7 dates can shift.</p></div>';
  box.innerHTML = html;
  box.querySelectorAll('[data-earn-research]').forEach(function (b) {
    b.addEventListener('click', function () {
      var T = b.getAttribute('data-earn-research');
      switchTab('scorecard');
      $('search-input').value = T;
      runSearch(T);
    });
  });
}
async function renderEarnCard() {
  var box = $('earn-card');
  if (!box) return;
  var tickers = earnUserTickers();
  if (!tickers.length) { box.innerHTML = ''; return; }
  var setKey = tickers.join(',');
  var cache = lsGet(EARN_KEY, null);
  if (cache && cache.day === scanTodayKey() && cache.setKey === setKey) { earnRender(box, cache, tickers); return; }
  if (earnBusy) { if (cache && cache.setKey === setKey) earnRender(box, cache, tickers); return; }
  earnBusy = true;
  if (cache && cache.setKey === setKey) earnRender(box, cache, tickers);
  else box.innerHTML = '<div class="card"><div class="scan-h">Earnings \u2014 your stocks</div><div class="status">Checking the calendar\u2026</div></div>';
  var days = earnDays(), byDay = {};
  for (var b = 0; b < days.length; b += 4) {
    var batch = await Promise.all(days.slice(b, b + 4).map(function (iso) {
      return earnFetchDay(iso).then(function (rows) { return [iso, rows]; });
    }));
    batch.forEach(function (pair) { if (pair[1]) byDay[pair[0]] = pair[1]; });
  }
  /* Store only the user's own matches -- a full day page is ~480
   * rows, and 14 of those would crowd localStorage for data the
   * card never renders. A changed ticker set refetches (setKey). */
  var inSet = {};
  tickers.forEach(function (t) { inSet[t] = true; });
  Object.keys(byDay).forEach(function (iso) {
    byDay[iso] = byDay[iso].filter(function (r) { return inSet[r.s]; });
  });
  var fresh = { day: scanTodayKey(), setKey: setKey, byDay: byDay };
  lsSet(EARN_KEY, fresh);
  earnBusy = false;
  earnRender(box, fresh, tickers);
}
function scanFreshIdx(started) {
  // Option B (Justin's pick, 2026-10-26): the Russell 2000 is 297 of
  // the 375 daily pages, so only the S&P 500 auto-starts; the Russell
  // waits for the card's Scan button (started=false, empty queue).
  var ix = { total: null, merged: {}, pending: [], queued: {}, pages: 0, dropped: [], started: started !== false };
  if (ix.started) ix.pending = SCAN_VIEWS.map(function (v) { return [v, 1, 0]; });
  return ix;
}
function scanFreshState() {
  var s = { date: scanTodayKey(), done: false, partial: false, results: null, idx: {}, rulesV: SCAN_RULES_V };
  SCAN_IDXS.forEach(function (ix) { s.idx[ix.key] = scanFreshIdx(ix.key === 'spx'); });
  return s;
}
function scanStartIndex(ixKey) {
  var s = getScan();
  if (!s || s.date !== scanTodayKey()) { s = scanFreshState(); }
  var ix = s.idx[ixKey];
  if (!ix || ix.started) { setScan(s); return; }
  ix.started = true;
  ix.pending = SCAN_VIEWS.map(function (v) { return [v, 1, 0]; });
  s.done = false;
  s.partial = false;
  setScan(s);
  renderScanCard();
  scanPump();
}
function getScan() {
  try { var s = JSON.parse(localStorage.getItem(SCAN_KEY) || 'null'); return (s && s.idx) ? s : null; }
  catch (e) { return null; }
}
function setScan(s) { try { localStorage.setItem(SCAN_KEY, JSON.stringify(s)); } catch (e) {} }

/* Finviz industry -> sector, their own screener taxonomy
 * (extracted 2026-10-31). Scan records carry industry; the sector is
 * derived here so records stay small. Unknown industries -> 'Other'. */
var INDUSTRY_SECTOR = {
  'Advertising Agencies': 'Communication Services',
  'Aerospace & Defense': 'Industrials',
  'Agricultural Inputs': 'Basic Materials',
  'Airlines': 'Industrials',
  'Airports & Air Services': 'Industrials',
  'Aluminum': 'Basic Materials',
  'Apparel Manufacturing': 'Consumer Cyclical',
  'Apparel Retail': 'Consumer Cyclical',
  'Asset Management': 'Financial',
  'Auto & Truck Dealerships': 'Consumer Cyclical',
  'Auto Manufacturers': 'Consumer Cyclical',
  'Auto Parts': 'Consumer Cyclical',
  'Banks - Diversified': 'Financial',
  'Banks - Regional': 'Financial',
  'Beverages - Brewers': 'Consumer Defensive',
  'Beverages - Non-Alcoholic': 'Consumer Defensive',
  'Beverages - Wineries & Distilleries': 'Consumer Defensive',
  'Biotechnology': 'Healthcare',
  'Broadcasting': 'Communication Services',
  'Building Materials': 'Basic Materials',
  'Building Products & Equipment': 'Industrials',
  'Business Equipment & Supplies': 'Industrials',
  'Capital Markets': 'Financial',
  'Chemicals': 'Basic Materials',
  'Coking Coal': 'Basic Materials',
  'Communication Equipment': 'Technology',
  'Computer Hardware': 'Technology',
  'Confectioners': 'Consumer Defensive',
  'Conglomerates': 'Industrials',
  'Consulting Services': 'Industrials',
  'Consumer Electronics': 'Technology',
  'Copper': 'Basic Materials',
  'Credit Services': 'Financial',
  'Department Stores': 'Consumer Cyclical',
  'Diagnostics & Research': 'Healthcare',
  'Discount Stores': 'Consumer Defensive',
  'Drug Manufacturers - General': 'Healthcare',
  'Drug Manufacturers - Specialty & Generic': 'Healthcare',
  'Education & Training Services': 'Consumer Defensive',
  'Electrical Equipment & Parts': 'Industrials',
  'Electronic Components': 'Technology',
  'Electronic Gaming & Multimedia': 'Communication Services',
  'Electronics & Computer Distribution': 'Technology',
  'Engineering & Construction': 'Industrials',
  'Entertainment': 'Communication Services',
  'Farm & Heavy Construction Machinery': 'Industrials',
  'Farm Products': 'Consumer Defensive',
  'Financial Conglomerates': 'Financial',
  'Financial Data & Stock Exchanges': 'Financial',
  'Food Distribution': 'Consumer Defensive',
  'Footwear & Accessories': 'Consumer Cyclical',
  'Furnishings, Fixtures & Appliances': 'Consumer Cyclical',
  'Gambling': 'Consumer Cyclical',
  'Gold': 'Basic Materials',
  'Grocery Stores': 'Consumer Defensive',
  'Health Information Services': 'Healthcare',
  'Healthcare Plans': 'Healthcare',
  'Home Improvement Retail': 'Consumer Cyclical',
  'Household & Personal Products': 'Consumer Defensive',
  'Industrial Distribution': 'Industrials',
  'Information Technology Services': 'Technology',
  'Infrastructure Operations': 'Industrials',
  'Insurance - Diversified': 'Financial',
  'Insurance - Life': 'Financial',
  'Insurance - Property & Casualty': 'Financial',
  'Insurance - Reinsurance': 'Financial',
  'Insurance - Specialty': 'Financial',
  'Insurance Brokers': 'Financial',
  'Integrated Freight & Logistics': 'Industrials',
  'Internet Content & Information': 'Communication Services',
  'Internet Retail': 'Consumer Cyclical',
  'Leisure': 'Consumer Cyclical',
  'Lodging': 'Consumer Cyclical',
  'Lumber & Wood Production': 'Basic Materials',
  'Luxury Goods': 'Consumer Cyclical',
  'Marine Shipping': 'Industrials',
  'Medical Care Facilities': 'Healthcare',
  'Medical Devices': 'Healthcare',
  'Medical Distribution': 'Healthcare',
  'Medical Instruments & Supplies': 'Healthcare',
  'Metal Fabrication': 'Industrials',
  'Mortgage Finance': 'Financial',
  'Oil & Gas Drilling': 'Energy',
  'Oil & Gas E&P': 'Energy',
  'Oil & Gas Equipment & Services': 'Energy',
  'Oil & Gas Integrated': 'Energy',
  'Oil & Gas Midstream': 'Energy',
  'Oil & Gas Refining & Marketing': 'Energy',
  'Other Industrial Metals & Mining': 'Basic Materials',
  'Other Precious Metals & Mining': 'Basic Materials',
  'Packaged Foods': 'Consumer Defensive',
  'Packaging & Containers': 'Consumer Cyclical',
  'Paper & Paper Products': 'Basic Materials',
  'Personal Services': 'Consumer Cyclical',
  'Pharmaceutical Retailers': 'Healthcare',
  'Pollution & Treatment Controls': 'Industrials',
  'Publishing': 'Communication Services',
  'REIT - Diversified': 'Real Estate',
  'REIT - Healthcare Facilities': 'Real Estate',
  'REIT - Hotel & Motel': 'Real Estate',
  'REIT - Industrial': 'Real Estate',
  'REIT - Mortgage': 'Real Estate',
  'REIT - Office': 'Real Estate',
  'REIT - Residential': 'Real Estate',
  'REIT - Retail': 'Real Estate',
  'REIT - Specialty': 'Real Estate',
  'Railroads': 'Industrials',
  'Real Estate - Development': 'Real Estate',
  'Real Estate - Diversified': 'Real Estate',
  'Real Estate Services': 'Real Estate',
  'Recreational Vehicles': 'Consumer Cyclical',
  'Rental & Leasing Services': 'Industrials',
  'Residential Construction': 'Consumer Cyclical',
  'Resorts & Casinos': 'Consumer Cyclical',
  'Restaurants': 'Consumer Cyclical',
  'Scientific & Technical Instruments': 'Technology',
  'Security & Protection Services': 'Industrials',
  'Semiconductor Equipment & Materials': 'Technology',
  'Semiconductors': 'Technology',
  'Silver': 'Basic Materials',
  'Software - Application': 'Technology',
  'Software - Infrastructure': 'Technology',
  'Solar': 'Technology',
  'Specialty Business Services': 'Industrials',
  'Specialty Chemicals': 'Basic Materials',
  'Specialty Industrial Machinery': 'Industrials',
  'Specialty Retail': 'Consumer Cyclical',
  'Staffing & Employment Services': 'Industrials',
  'Steel': 'Basic Materials',
  'Telecom Services': 'Communication Services',
  'Textile Manufacturing': 'Consumer Cyclical',
  'Thermal Coal': 'Energy',
  'Tobacco': 'Consumer Defensive',
  'Tools & Accessories': 'Industrials',
  'Travel Services': 'Consumer Cyclical',
  'Trucking': 'Industrials',
  'Uranium': 'Energy',
  'Utilities - Diversified': 'Utilities',
  'Utilities - Independent Power Producers': 'Utilities',
  'Utilities - Regulated Electric': 'Utilities',
  'Utilities - Regulated Gas': 'Utilities',
  'Utilities - Regulated Water': 'Utilities',
  'Utilities - Renewable': 'Utilities',
  'Waste Management': 'Industrials'
};
function sectorOf(rec) { return (rec && rec.industry && INDUSTRY_SECTOR[rec.industry]) || 'Other'; }
function scanMerge(idxs, view, rows) {
  rows.forEach(function (row) {
    var rec = idxs.merged[row.t];
    if (!rec) { rec = { name: row.name || row.t }; idxs.merged[row.t] = rec; }
    if (row.ind) rec.industry = row.ind;
    var n = row.n || {};
    if (view === '121') {
      if (isNum(n.forwardPE)) rec.forwardPE = n.forwardPE;
      if (isNum(n.PEG)) rec.peg = n.PEG;
      if (isNum(n.epsYoY1)) rec.epsGrowthNextY = n.epsYoY1;
      if (isNum(n.epsYoY)) rec.epsGrowthTTM = n.epsYoY;
      if (isNum(n.price)) rec.price = n.price;
      // Finviz reports market cap in $millions; the risk score's size
      // bands (and fmtCap) work in raw dollars.
      if (isNum(n.marketCap)) rec.marketCap = n.marketCap * 1e6;
    } else if (view === '161') {
      if (isNum(n.grossMargin)) rec.grossMargin = n.grossMargin;
      if (isNum(n.netMargin)) rec.profitMargin = n.netMargin;
      if (isNum(n.debtEq)) rec.debtEq = n.debtEq;
      if (isNum(n.curRatio)) rec.currentRatio = n.curRatio;
      if (isNum(n.dividendYield)) rec.divYield = n.dividendYield;
    } else if (view === '171') {
      if (isNum(n.high52w)) rec.pctBelowHigh = Math.max(0, -n.high52w);
      if (isNum(n.beta)) rec.beta = n.beta;
    }
  });
}

function scanRankAll(idxs) {
  var out = [];
  Object.keys(idxs.merged).forEach(function (t) {
    var rec = idxs.merged[t];
    // Eligibility: a ranking score must rest on the anchor factor (a
    // real forward P/E) and at least 60 of the 100 factor points —
    // otherwise a name with two maxed-out minor factors (fresh
    // spin-offs, pre-revenue shells) normalizes to a meaningless 100.
    // Data-sanity + size gates (Justin's call, 2026-11-08): a forward
    // P/E under 1 is a broken data point (a units artifact — NIVF
    // read 0.0002), not a valuation; and the Top lists only carry
    // companies worth $100M or more.
    if (!(isNum(rec.forwardPE) && rec.forwardPE >= 1)) return;
    if (!(isNum(rec.marketCap) && rec.marketCap >= 1e8)) return;
    var s = scoreStock(rec, STD_W);
    if (!(s && isNum(s.score) && s.maxAvailable >= 60)) return;
    // The combined score's risk side needs the same grounding: the
    // screener-fed risk factors total 80 points (beta 10 + debt/eq 20
    // + profit margin 15 + size 10 + EPS trend 15 + current ratio 10;
    // the boom-bust factor needs a revenue path the screener doesn't
    // carry, so it never counts here). Require at least 60% of those
    // 80 — 48 points — mirroring the valuation side's 60-of-100 rule.
    var rk = riskScore(rec, STD_W);
    if (!(rk && isNum(rk.score) && rk.maxAvailable >= 60)) return;
    // One score for the daily list (Justin's ask, 2026-10-27):
    // 60% how cheap it is + 40% how safe it is.
    var combined = Math.round(0.6 * s.score + 0.4 * (100 - rk.score));
    out.push({ t: t, name: rec.name, score: combined, price: isNum(rec.price) ? rec.price : null, rec: rec, sev: rk.cyc ? rk.cyc.severity : 0 });
  });
  out.sort(function (a, b) { return b.score - a.score; });
  return out;
}

/* Display shape for a scan row: the plain entry the card has always
 * stored, plus the cyclical tags when they apply (severity >= 0.5,
 * or a partial check when the full overlay could not load). */
function scanDisplayEntry(e, partialOverride) {
  var o = { t: e.t, name: e.name, score: e.score, price: e.price };
  if (isNum(e.sev) && e.sev >= 0.5) o.sev = e.sev;
  if (isNum(e.cagr)) o.cagr = Math.round(e.cagr * 10) / 10;
  if (partialOverride || e.partial) o.partial = true;
  return o;
}

function scanFinalizeIdx(idxs) {
  return scanRankAll(idxs).slice(0, 10).map(function (e) { return scanDisplayEntry(e); });
}

/* Full-overlay enrichment for the scan lists (Justin's spec,
 * 2026-11-01): the preliminary ranking runs on screener fields
 * alone; the top 25 of each index then load yearly statements
 * (day-cached) and re-rank with the same scoreStock/riskScore as the
 * scorecard before the Top 10 is final. Entries whose statements
 * fail to load keep their preliminary score, flagged partial. */
var scanEnriching = false, scanLastFull = null;
async function scanEnrichTop(fullByIx) {
  if (scanEnriching) return;
  scanEnriching = true;
  var gen0 = (getScan() || {}).resultsGen;
  try {
    var changed = false;
    /* Phase 1: deep-dive each index's top 25, collecting every fully
     * checked finalist into one shared pool. The indexes overlap
     * (Total Market contains the S&P 500 and Russell 2000), and a
     * stock checked in one list must compete in every list it
     * belongs to -- per-index silos let a checked 78 sit out of
     * Total Market while an unchecked-crowded pool left that list
     * with only low checked scores (Justin's catch, 2026-11-12). */
    var pool = {};   // ticker -> entry that fully checked in some index's pass
    var ownFull = {}; // ixKey -> this index's own fully checked finalists
    for (var ii = 0; ii < SCAN_IDXS.length; ii++) {
      var ixKey = SCAN_IDXS[ii].key;
      ownFull[ixKey] = [];
      var ranked = fullByIx[ixKey];
      if (!ranked || !ranked.length) continue;
      var top = ranked.slice(0, 25);
      for (var i = 0; i < top.length; i += 4) {
        await Promise.all(top.slice(i, i + 4).map(async function (entry) {
          var data = await cycLoadYearly(entry.t);
          var g = await cycLoadTtmGrowth(entry.t);
          var nY = await cycLoadGrowthOutlook(entry.t);
          if (isNum(g)) entry.rec.epsGrowthTTM = g;
          if (isNum(nY)) entry.rec.epsGrowthNextY = nY;
          if (data) {
            entry.rec.yearly = data.yearly;
            if (data.revPath) entry.rec.revPath = data.revPath;
            var s = scoreStock(entry.rec, STD_W), rk = riskScore(entry.rec, STD_W);
            if (s && isNum(s.score) && rk && isNum(rk.score)) {
              var combined = Math.round(0.6 * s.score + 0.4 * (100 - rk.score));
              entry.score = combined;
              entry.sev = rk.cyc ? rk.cyc.severity : 0;
              /* CAGR blend (Justin's pick, 2026-11-12): the checked
               * score is 75% value + safety and 25% growth, where
               * growth is the same base-case 4-yr CAGR the watchlist
               * shows, mapped -20%/yr -> 0 points and +40%/yr -> 100.
               * A finalist with no analyst forecast path keeps its
               * unblended score -- no growth evidence either way. */
              var cg = await fetchWlProjCagr(entry.t);
              if (isNum(cg)) {
                entry.cagr = cg;
                var cpts = Math.max(0, Math.min(100, (cg + 20) / 60 * 100));
                entry.score = Math.round(0.75 * combined + 0.25 * cpts);
              }
            }
            entry.full = true;
            if (!isNum(g) || !isNum(nY)) entry.partial = true; // yearly loaded, growth basis unverified
          } else {
            entry.partial = true;
          }
        }));
      }
      top.forEach(function (e) {
        if (e.full && !e.partial) {
          ownFull[ixKey].push(e);
          if (!pool[e.t]) pool[e.t] = e;
        }
      });
    }
    /* Phase 2: build each index's Top 10 from its own checked
     * finalists PLUS every pooled name that belongs to the index and
     * passes the same ranking gates (forward P/E >= 1, market cap
     * >= $100M), all at their checked scores. */
    for (var jj = 0; jj < SCAN_IDXS.length; jj++) {
      var jxKey = SCAN_IDXS[jj].key;
      if (!fullByIx[jxKey] || !fullByIx[jxKey].length) continue;
      var cand = {};
      ownFull[jxKey].forEach(function (e) { cand[e.t] = e; });
      Object.keys(pool).forEach(function (t) {
        if (cand[t]) return;
        var pe = pool[t];
        if (!scanRecIx(pe.rec, jxKey)) return;
        if (!(isNum(pe.rec.forwardPE) && pe.rec.forwardPE >= 1)) return;
        if (!(isNum(pe.rec.marketCap) && pe.rec.marketCap >= 1e8)) return;
        cand[t] = pe;
      });
      /* Fully-checked-only Top 10 (Justin's rule, 2026-11-10, mirrors
       * the server scan): a finalist whose deep-dive could not verify
       * every input does not take a Top-10 slot -- the next fully
       * checked finalist is promoted instead. If fewer than 10 fully
       * check, the list is shorter rather than padded with partials. */
      var final10 = Object.keys(cand).map(function (t) { return cand[t]; })
        .sort(function (a, b) { return b.score - a.score; }).slice(0, 10)
        .map(function (e) { return scanDisplayEntry(e); });
      var sNow = getScan();
      if (sNow && sNow.done && sNow.date === scanTodayKey() && sNow.results) {
        sNow.results[jxKey] = final10;
        setScan(sNow);
        changed = true;
      }
    }
    if (changed) {
      var s2 = getScan();
      if (s2 && s2.results) {
        scanUpdateNewBadges(s2.results, true);
        if (s2.resultsGen === gen0) {
          // This pass enriched the current result set end to end:
          // it is now the checked list -- safe to show, and the
          // snapshot future pending windows fall back to.
          s2.checked = true;
          setScan(s2);
          var scMap = {};
          SCAN_IDXS.forEach(function (ix) { scMap[ix.key] = s2.idx[ix.key] ? s2.idx[ix.key].scored : null; });
          scanSaveChecked(s2.date, s2.results, scMap);
        } else {
          // The results were replaced mid-pass (a refresh landed):
          // re-run once against the current dataset so the new
          // lists get their checks too, rather than blessing the
          // stale writes.
          var dsNow = getScanData();
          if (dsNow) {
            scanEnriching = false;
            scanEnrichTop(scanFullFromData(dsNow));
            return;
          }
        }
      }
      renderScanCard();
    }
  } catch (e) {}
  scanEnriching = false;
}

/* Full preliminary rankings from the persisted dataset, over CLONES
 * of the stored records: enrichment hangs yearly/revenue data on the
 * records it scores, and the stored dataset must not grow them. */
function scanFullFromData(ds) {
  var byIx = {};
  SCAN_IDXS.forEach(function (ix) { byIx[ix.key] = { merged: {} }; });
  Object.keys(ds.recs).forEach(function (t) {
    var r = ds.recs[t];
    SCAN_IDXS.forEach(function (ix) { if (scanRecIx(r, ix.key)) byIx[ix.key].merged[t] = Object.assign({}, r); });
  });
  var out = {};
  SCAN_IDXS.forEach(function (ix) { out[ix.key] = scanRankAll(byIx[ix.key]); });
  return out;
}

async function scanFetchPage(ixKey, v, r) {
  // Hard 30s race on top of fetchWithTimeout's abort: a throttled
  // Finviz can leave a request hanging, and a hung slot must free up
  // so the pump keeps moving instead of wedging at full concurrency.
  var work = (async function () {
    var resp = await fetchWithTimeout(SCAN_URL + '?v=' + v + '&f=' + ixKey + '&r=' + r, 25000);
    if (!resp.ok) { var e = new Error('screen ' + resp.status); e.status = resp.status; throw e; }
    var data = await resp.json();
    if (!data || !Array.isArray(data.rows)) throw new Error('screen payload');
    return data;
  })();
  var limit = new Promise(function (resolve, reject) {
    setTimeout(function () { var e = new Error('screen timeout'); e.timeout = true; reject(e); }, 30000);
  });
  return Promise.race([work, limit]);
}

/* Fallback route for scan pages (2026-10-28): every /screen page
 * leaves through the relay Worker's single Cloudflare egress IP, and
 * when Finviz flags that IP the whole scan stalls in cooldown cycles
 * -- 'won't stop throttling'. This route pulls the same screener page
 * through the public relays (different egress IPs) and extracts the
 * rows here, with the worker's own extraction mirrored field-for-field. */
var SCAN_VIEW_FIELDS = {
  '121': ['marketCap', 'PE', 'forwardPE', 'PEG', 'epsYoY', 'epsYoY1', 'price', 'change'],
  '161': ['grossMargin', 'netMargin', 'debtEq', 'curRatio'],
  '171': ['high52w', 'beta']
};
function scanExtractRows(html, v) {
  var anchor = '"data":{"rows":[';
  var i = html.indexOf(anchor);
  if (i < 0) return null;
  var start = i + anchor.length - 1;
  var j = html.indexOf('],"totalCount"', start);
  if (j < 0) return null;
  var rows = null, total = null;
  try { rows = JSON.parse(html.slice(start, j + 1)); } catch (e) {}
  if (!Array.isArray(rows)) return null;
  var tm = html.slice(j, j + 80).match(/"totalCount":(\d+)/);
  if (tm) total = parseInt(tm[1], 10);
  var keep = SCAN_VIEW_FIELDS[v] || [];
  var slim = rows.map(function (row) {
    var n = {};
    if (row.numbers) keep.forEach(function (k) { if (typeof row.numbers[k] === 'number') n[k] = row.numbers[k]; });
    return { t: row.text ? row.text.ticker : '', name: row.text ? row.text.company : '', ind: row.text ? (row.text.industry || '') : '', n: n };
  }).filter(function (row) { return row.t; });
  return { total: total, rows: slim };
}

async function scanFetchPageAlt(ixKey, v, r) {
  var filter = ixKey === 'spx' ? 'idx_sp500' : 'idx_rut';
  var url = 'https://finviz.com/screener?v=' + v + '&f=' + filter + (r > 1 ? '&r=' + r : '');
  var work = (async function () {
    var html = await relayFetch(url, {
      timeout: 25000,
      validate: function (t) { return t.indexOf('"data":{"rows"') !== -1; }
    });
    var data = scanExtractRows(html, v);
    if (!data) { var e = new Error('screen payload'); e.status = 502; throw e; }
    return data;
  })();
  var limit = new Promise(function (resolve, reject) {
    setTimeout(function () { var e = new Error('screen timeout'); e.timeout = true; reject(e); }, 30000);
  });
  return Promise.race([work, limit]);
}

function scanSchedule(delay) {
  if (scanTimer) return;
  scanTimer = setTimeout(function () { scanTimer = null; scanStep(); scanStep(); }, delay);
}

function scanStep() {
  if (!scanRunning) return;
  var st = getScan();
  if (!st || st.done) { scanRunning = false; return; }
  var wait = scanCoolUntil - Date.now();
  if (wait > 0) { scanSchedule(wait); return; }
  if (scanActive >= 2) return;
  var job = null, jobIx = null;
  for (var i = 0; i < SCAN_IDXS.length && !job; i++) {
    var cand = st.idx[SCAN_IDXS[i].key];
    if (cand.started === false) continue;
    if (cand.pending.length) { job = cand.pending[0]; jobIx = SCAN_IDXS[i].key; }
  }
  if (!job) {
    if (scanActive === 0) {
      // Queue drained: complete only if nothing was dropped (among
      // the indexes that were started -- an unstarted Russell must
      // not hold the S&P's completion hostage).
      var droppedTotal = SCAN_IDXS.reduce(function (a, ix) { return a + (st.idx[ix.key].started === false ? 0 : st.idx[ix.key].dropped.length); }, 0);
      var results = {}, full = {};
      SCAN_IDXS.forEach(function (ix) {
        var z = st.idx[ix.key];
        z.scored = Object.keys(z.merged).length;
        full[ix.key] = scanRankAll(z);
        results[ix.key] = full[ix.key].slice(0, 10).map(function (e) { return scanDisplayEntry(e); });
      });
      scanLastFull = full;
      st.results = results;
      // Feed the persistent dataset: any index that landed complete
      // becomes the stored copy future days refresh incrementally.
      SCAN_IDXS.forEach(function (ix) {
        var z = st.idx[ix.key];
        if (z.started === false) return;
        if (z.pending.length || z.dropped.length) return;
        if (Object.keys(z.merged).length > 100) scanPersistIdx(ix.key, z.merged);
      });
      if (droppedTotal === 0) {
        st.done = true;
        st.partial = false;
        scanUpdateNewBadges(results, true);
        SCAN_IDXS.forEach(function (ix) { st.idx[ix.key].merged = {}; });
      } else {
        st.partial = true;
      }
      setScan(st);
      scanRunning = false;
      renderScanCard();
      if (droppedTotal === 0) scanEnrichTop(full);
    }
    return;
  }
  var idxs = st.idx[jobIx];
  idxs.pending.shift();
  setScan(st);
  scanActive++;
  scanFetchPage(jobIx, job[0], job[1]).catch(function (err) {
    if (err && err.status === 502) return scanFetchPageAlt(jobIx, job[0], job[1]);
    throw err;
  }).then(function (data) {
    var st2 = getScan(); if (!st2) return;
    var ix2 = st2.idx[jobIx];
    if (isNum(data.total)) ix2.total = data.total;
    scanMerge(ix2, job[0], data.rows);
    ix2.pages++;
    if (job[1] === 1 && isNum(data.total)) {
      for (var r = 21; r <= data.total; r += 20) {
        var k = job[0] + ':' + r;
        if (!ix2.queued[k]) { ix2.queued[k] = 1; ix2.pending.push([job[0], r, 0]); }
      }
    }
    setScan(st2);
  }).catch(function (err) {
    // A 502 from the relay means Finviz blocked it (403): cool the
    // whole scan down instead of burning the page's retries at once.
    if (err && err.status === 502) scanCoolUntil = Date.now() + 25000;
    else if (err && err.timeout) scanCoolUntil = Date.now() + 10000;
    var st2 = getScan(); if (!st2) return;
    var ix2 = st2.idx[jobIx];
    if (job[2] < 4) { job[2]++; ix2.pending.push(job); }
    else ix2.dropped.push([job[0], job[1]]);
    setScan(st2);
  }).then(function () {
    scanActive--;
    renderScanCard();
    scanSchedule(350);
  });
}

function scanPump() {
  if (scanRunning) return;
  var s = getScan();
  if (!s || s.done || s.partial || s.date !== scanTodayKey()) return;
  scanRunning = true;
  scanStep(); scanStep();
}

function scanResume() {
  var s = getScan();
  if (!s) return;
  SCAN_IDXS.forEach(function (ix) {
    var z = s.idx[ix.key];
    if (z.started === false) return;
    z.dropped.forEach(function (dr) { z.pending.push([dr[0], dr[1], 0]); });
    z.dropped = [];
  });
  s.partial = false;
  setScan(s);
  renderScanCard();
  scanPump();
}

/* ---------- persistent scan dataset + earnings refresh ----------
 * Justin's ask (2026-10-28): don't rescan all ~2,460 companies every
 * day. A completed full scan stores every company's record; on later
 * days only the companies that reported earnings since then get
 * re-fetched (one Finviz quote page each -- earnings are when the
 * numbers actually change), and the lists re-rank from the stored
 * data. A full rescan still runs weekly (prices drift, companies
 * come and go) or whenever he taps Rescan. */
var SCAN_DATA_KEY = 'sr_scan_data_v1';
function getScanData() {
  try { var s = JSON.parse(localStorage.getItem(SCAN_DATA_KEY) || 'null'); return (s && s.recs) ? s : null; }
  catch (e) { return null; }
}
function setScanData(s) { try { localStorage.setItem(SCAN_DATA_KEY, JSON.stringify(s)); } catch (e) {} }

/* Last fully-checked scan lists (Justin's rule, 2026-11-12: never
 * show a list until its deep checks have landed). Written when a
 * server pass is adopted and when the on-device top-25 deep-dive
 * completes; shown -- under its own date -- while today's checks
 * are still running, so the unchecked preliminary ranking is never
 * what renders. */
var SCAN_CHECKED_KEY = 'sr_scan_checked_v1';
function scanSaveChecked(date, results, scored) {
  try { lsSet(SCAN_CHECKED_KEY, { date: date, results: results, scored: scored || null }); } catch (e) {}
}
function scanGetChecked() {
  var c = lsGet(SCAN_CHECKED_KEY, null);
  return (c && c.results) ? c : null;
}

/* NEW badges (2026-10-30): when a completed Top-10 list replaces the
 * last shown one, names that weren't in the previous list carry a
 * NEW pill until the next completed list lands. The first-ever list
 * gets no badges — everything would be "new". */
var SCAN_TOP_KEY = 'sr_scan_top_v1';
var SCAN_NEW_KEY = 'sr_scan_new_v1';
function scanNewList(ixKey) {
  var nv = lsGet(SCAN_NEW_KEY, null);
  return (nv && nv[ixKey]) || [];
}
function scanNewPill(ixKey, t) {
  return scanNewList(ixKey).indexOf(t) !== -1 ? ' <span class="scan-new">NEW</span>' : '';
}
function scanUpdateNewBadges(results, force) {
  if (!results) return;
  var today = scanTodayKey();
  var top = lsGet(SCAN_TOP_KEY, null);
  if (!force && top && top.date === today) return; // already noted today's first list
  var hadPrev = !!(top && SCAN_IDXS.some(function (ix) { return (top[ix.key] || []).length; }));
  var newIn = {}, newTop = { date: today };
  SCAN_IDXS.forEach(function (ixDef) {
    var ix = ixDef.key;
    newIn[ix] = []; newTop[ix] = [];
    var prev = (top && top[ix]) || [];
    (results[ix] || []).forEach(function (r) {
      newTop[ix].push(r.t);
      if (hadPrev && prev.indexOf(r.t) === -1) newIn[ix].push(r.t);
    });
  });
  newIn.date = today;
  lsSet(SCAN_NEW_KEY, newIn);
  lsSet(SCAN_TOP_KEY, newTop);
}

/* Multi-index membership (2026-11-08): indexes overlap -- the
 * Russell 3000 contains nearly every Russell 2000 and S&P 500 name --
 * so a stored record keeps the SET of indexes it belongs to (ixs).
 * ix remains the most recent writer for legacy readers; membership
 * questions go through scanRecIx. Without this, persisting the
 * Russell 3000 dataset would have relabeled ~2,400 shared tickers
 * and emptied the other two indexes' screener results. */
function scanRecIx(rec, key) {
  return !!rec && (rec.ix === key || !!(rec.ixs && rec.ixs.indexOf(key) !== -1));
}
function scanPersistIdx(ixKey, merged) {
  var ds = getScanData() || { recs: {}, asOf: null, lastRefreshDay: null, lastRefreshCount: 0 };
  Object.keys(merged).forEach(function (t) {
    var r = merged[t];
    var prev = ds.recs[t];
    var ixs = (prev && prev.ixs) ? prev.ixs.slice() : (prev && prev.ix ? [prev.ix] : []);
    if (ixs.indexOf(ixKey) === -1) ixs.push(ixKey);
    ds.recs[t] = { name: r.name, ix: ixKey, ixs: ixs, forwardPE: r.forwardPE, peg: r.peg, epsGrowthNextY: r.epsGrowthNextY,
      price: r.price, marketCap: r.marketCap, grossMargin: r.grossMargin, profitMargin: r.profitMargin,
      debtEq: r.debtEq, currentRatio: r.currentRatio, pctBelowHigh: r.pctBelowHigh, beta: r.beta,
      divYield: r.divYield, industry: r.industry, epsGrowthTTM: r.epsGrowthTTM };
  });
  if (ixKey === 'spx') ds.asOf = scanTodayKey();
  setScanData(ds);
}

/* One-time backfill (2026-10-30): scanPersistIdx dropped divYield from
 * stored records, so datasets built before the fix carry no yields and
 * the screener's dividend filter can only return the "not in the data
 * yet" notice. Fill yields in from the hosted snapshot (same tickers)
 * once, on a launch where the dataset is still missing them; scans
 * keep the field from here on. */
var DY_BACKFILL_KEY = 'sr_dy_backfill_v1';
var SECTOR_BACKFILL_KEY = 'sr_sector_backfill_v1';
async function sectorBackfill() {
  if (lsGet(SECTOR_BACKFILL_KEY, null)) return;
  var ds = getScanData();
  if (!ds || !ds.recs) return;
  var tickers = Object.keys(ds.recs);
  if (!tickers.length) return;
  var have = tickers.filter(function (t) { return !!ds.recs[t].industry; }).length;
  if (have > tickers.length * 0.5) { lsSet(SECTOR_BACKFILL_KEY, 1); return; }
  try {
    var resp = await fetch('scan-data.json?cb=' + Date.now(), { cache: 'no-store' });
    if (!resp.ok) return;
    var snap = await resp.json();
    if (!snap || !snap.recs) return;
    var filled = 0;
    tickers.forEach(function (t) {
      if (!ds.recs[t].industry && snap.recs[t] && snap.recs[t].industry) {
        ds.recs[t].industry = snap.recs[t].industry;
        filled++;
      }
    });
    if (filled > 0) {
      setScanData(ds);
      lsSet(SECTOR_BACKFILL_KEY, 1);
      if (document.querySelector('#tool-scr.active')) runScreener();
    }
  } catch (e) {}
}
async function dyBackfill() {
  if (lsGet(DY_BACKFILL_KEY, null)) return;
  var ds = getScanData();
  if (!ds || !ds.recs) return;
  var tickers = Object.keys(ds.recs);
  if (!tickers.length) return;
  var have = tickers.filter(function (t) { return isNum(ds.recs[t].divYield); }).length;
  if (have > tickers.length * 0.1) { lsSet(DY_BACKFILL_KEY, 1); return; }
  try {
    var resp = await fetch('scan-data.json?cb=' + Date.now(), { cache: 'no-store' });
    if (!resp.ok) return;
    var snap = await resp.json();
    if (!snap || !snap.recs) return;
    var filled = 0;
    tickers.forEach(function (t) {
      if (!isNum(ds.recs[t].divYield) && snap.recs[t] && isNum(snap.recs[t].divYield)) {
        ds.recs[t].divYield = snap.recs[t].divYield;
        filled++;
      }
    });
    if (filled > 0) {
      setScanData(ds);
      lsSet(DY_BACKFILL_KEY, 1);
      if (document.querySelector('#tool-scr.active')) runScreener();
    }
  } catch (e) {}
}

/* One Finviz quote page -> a scan-shaped record (same fields the
 * screener merge produces). Missing fields keep the stored values. */
function scanRecordFromQuote(html, prev) {
  var d = { ticker: '', sources: [], errors: [] };
  try { fillFromFinviz(d, html); } catch (e) { return null; }
  var rec = { name: d.companyName || (prev && prev.name) || '', ix: prev && prev.ix, ixs: prev && prev.ixs };
  rec.industry = prev ? prev.industry : null;
  ['forwardPE', 'peg', 'price', 'marketCap', 'grossMargin', 'profitMargin', 'debtEq', 'beta', 'currentRatio', 'pctBelowHigh', 'divYield', 'epsGrowthTTM'].forEach(function (k) {
    rec[k] = isNum(d[k]) ? d[k] : (prev ? prev[k] : null);
  });
  if (isNum(d.epsNextY) && isNum(d.epsThisY) && d.epsThisY > 0) rec.epsGrowthNextY = (d.epsNextY / d.epsThisY - 1) * 100;
  else rec.epsGrowthNextY = prev ? prev.epsGrowthNextY : null;
  return rec;
}

function scanBucketsFromData(ds) {
  var byIx = {};
  SCAN_IDXS.forEach(function (ix) { byIx[ix.key] = { merged: {} }; });
  Object.keys(ds.recs).forEach(function (t) {
    var r = ds.recs[t];
    SCAN_IDXS.forEach(function (ix) { if (scanRecIx(r, ix.key)) byIx[ix.key].merged[t] = r; });
  });
  return byIx;
}
function scanRankFromData(ds) {
  var byIx = scanBucketsFromData(ds);
  var out = {};
  SCAN_IDXS.forEach(function (ix) { out[ix.key] = scanFinalizeIdx(byIx[ix.key]); });
  return out;
}

function scanShowDataResults(ds, refreshed) {
  var today = scanTodayKey();
  var s = getScan();
  if (!s || s.date !== today) s = scanFreshState();
  s.results = scanRankFromData(ds);
  scanUpdateNewBadges(s.results, false);
  s.done = true;
  s.partial = false;
  s.fromData = true;
  s.dataAsOf = ds.asOf;
  s.refreshed = refreshed;
  s.rulesV = SCAN_RULES_V;
  s.checked = false; // preliminary ranking only -- the deep-dive below decides what may be shown
  s.resultsGen = (s.resultsGen || 0) + 1;
  SCAN_IDXS.forEach(function (ix) {
    var n = Object.keys(ds.recs).filter(function (t) { return scanRecIx(ds.recs[t], ix.key); }).length;
    s.idx[ix.key].scored = n;
    // Stored rows for this index mean its list renders; leaving the
    // fresh-day started=false in place would swap in the on-demand
    // "Scan Russell" button instead of the stored Russell list.
    if (n > 0) s.idx[ix.key].started = true;
  });
  setScan(s);
  renderScanCard();
  // Top-25 full-overlay pass over the stored records (clones); the
  // day cache makes repeat calls network-free.
  scanEnrichTop(scanFullFromData(ds));
}

var scanRefreshing = false, scanRefreshStartedAt = 0, scanRekickAt = 0;
async function scanRefreshReporters() {
  var ds = getScanData();
  if (!ds || scanRefreshing) return;
  var today = scanTodayKey();
  if (ds.lastRefreshDay === today) { scanShowDataResults(ds, ds.lastRefreshCount || 0); return; }
  scanRefreshing = true;
  scanRefreshStartedAt = Date.now();
  scanShowDataResults(ds, null); // stored lists instantly; counts update when the refresh lands
  try {
    // Earnings calendar for the days since the last refresh (plus a
    // one-day overlap: evening reporters update Finviz overnight),
    // capped at 10 days back.
    var startMs = Date.parse((ds.lastRefreshDay || ds.asOf) + 'T12:00:00') - 86400000;
    var todayMs = Date.parse(today + 'T12:00:00');
    var reporters = {};
    for (var ms = startMs; ms <= todayMs; ms += 86400000) {
      if ((todayMs - ms) / 86400000 > 10) continue;
      var iso = pfKeyToISO(pfDkey(new Date(ms)));
      try {
        var cal = await relayJSON('https://api.nasdaq.com/api/calendar/earnings?date=' + iso);
        var rows = (cal && cal.data && cal.data.rows) || [];
        rows.forEach(function (r) { if (r.symbol && ds.recs[r.symbol]) reporters[r.symbol] = 1; });
      } catch (e) {}
    }
    var list = Object.keys(reporters);
    var updated = 0;
    for (var i = 0; i < list.length; i += 2) {
      var batch = list.slice(i, i + 2);
      await Promise.all(batch.map(async function (t) {
        try {
          var html = await relayFetch('https://finviz.com/quote.ashx?t=' + encodeURIComponent(t), { timeout: 20000 });
          var rec = scanRecordFromQuote(html, ds.recs[t]);
          if (rec) { ds.recs[t] = rec; updated++; }
        } catch (e) {}
      }));
      if (i + 2 < list.length) await new Promise(function (r) { setTimeout(r, 300); });
    }
    ds.lastRefreshDay = today;
    ds.lastRefreshCount = updated;
    setScanData(ds);
    scanShowDataResults(ds, updated);
  } catch (e) {
    scanShowDataResults(ds, 0);
  }
  scanRefreshing = false;
}

/* Bootstrap snapshot: a pre-built dataset hosted next to the app
 * (scan-data.json, public market data only) so a cold start never has
 * to grind through 375 screener pages -- the exact grind that made
 * the scan feel like it would never stop throttling. Used only when
 * this device has no stored dataset of its own; once it does, the
 * on-device machinery owns everything. */
var scanBootstrapping = false;
/* Diagnostic trail for the scan bootstrap: the harness version
 * works, but on Justin's phone the snapshot rescue kept not firing
 * (2026-10-29) with no visibility into which step failed. The last
 * few events persist on-device and the newest prints on the scan
 * card, so a screenshot carries the evidence. */
function scanDiag(msg) {
  try {
    var a = lsGet('sr_scan_diag', []);
    a.push(new Date().toTimeString().slice(0, 8) + ' ' + msg);
    lsSet('sr_scan_diag', a.slice(-6));
  } catch (e) {}
}
function scanDiagLast() {
  var a = lsGet('sr_scan_diag', []);
  return a.length ? a[a.length - 1] : '';
}
async function scanBootstrapFromHosted() {
  if (scanBootstrapping) { scanDiag('bootstrap skipped: already running'); return; }
  if (getScanData()) { scanDiag('bootstrap: dataset exists, fresh scan'); var s0 = scanFreshState(); setScan(s0); renderScanCard(); scanPump(); return; }
  scanBootstrapping = true;
  var s = scanFreshState();
  setScan(s);
  renderScanCard();
  try {
    var resp = await fetch('scan-data.json?cb=' + Date.now(), { cache: 'no-store' });
    if (!resp.ok) {
      scanDiag('snapshot fetch failed: HTTP ' + resp.status);
    } else {
      var snap = await resp.json();
      var n = (snap && snap.recs) ? Object.keys(snap.recs).length : 0;
      var ageDays = snap && snap.asOf ? (Date.parse(scanTodayKey() + 'T12:00:00') - Date.parse(snap.asOf + 'T12:00:00')) / 86400000 : -1;
      if (n > 400 && ageDays >= 0 && ageDays <= 10) {
        setScanData({ recs: snap.recs, asOf: snap.asOf, lastRefreshDay: null, lastRefreshCount: 0 });
        scanBootstrapping = false;
        scanDiag('snapshot loaded: ' + n + ' recs, asOf ' + snap.asOf);
        scanRefreshReporters();
        return;
      }
      scanDiag('snapshot rejected: recs=' + n + ' ageDays=' + ageDays);
    }
  } catch (e) {
    scanDiag('snapshot fetch error: ' + (e && e.message ? e.message : String(e)));
  }
  scanBootstrapping = false;
  scanPump();
}

/* ---------- shared scan adoption (2026-11-01) ----------
 * The Worker runs the full scan centrally (chunked cron, same
 * scoring code as this app) and publishes finished results. A phone
 * that finds a fresh published pass adopts it wholesale -- dataset,
 * Top-10 lists, NEW badges -- so a stock's Score is identical for
 * everyone instead of depending on when each phone last scanned.
 * Anything missing or stale leaves the on-device scan untouched. */
var scanSharedBusy = false;
var scanSharedAt = 0; // last adoption attempt, this session
async function scanFetchShared(ixKey) {
  try {
    var resp = await fetch(SCAN_SHARED_URL + '?ix=' + ixKey + '&cb=' + Date.now(),
      { cache: 'no-store', signal: AbortSignal.timeout(9000) });
    if (!resp.ok) return null;
    var p = await resp.json();
    if (!p || !p.asOf || !p.recs || !Array.isArray(p.top)) return null;
    if (Date.now() - Date.parse(p.asOf) > 48 * 3600 * 1000) return null; // stale
    var n = Object.keys(p.recs).length;
    if (n < (ixKey === 'tot' ? 4000 : ixKey === 'rut' ? 500 : 100)) return null;
    return p;
  } catch (e) { return null; }
}
async function scanAdoptShared() {
  if (scanSharedBusy) return false;
  if (Date.now() - scanSharedAt < 30 * 60 * 1000) return false; // throttle
  scanSharedBusy = true;
  scanSharedAt = Date.now();
  try {
    if (scanRunning) return false;
    var cur = getScan();
    if (cur && cur.date === scanTodayKey() && (cur.done || cur.partial || cur.fromData)) return false; // today's list already settled on-device
    var spx = await scanFetchShared('spx');
    if (!spx) return false;
    var rut = await scanFetchShared('rut');
    var tot = await scanFetchShared('tot');
    var asOfDay = pfKeyToISO(pfDkey(new Date(spx.asOf)));
    if (asOfDay !== scanTodayKey()) {
      // Yesterday's pass: refresh the stored dataset only (if newer),
      // then let the usual on-device day flow rank today from it.
      var ds0 = getScanData();
      if (!ds0 || !ds0.asOf || ds0.asOf < asOfDay) {
        scanPersistIdx('spx', spx.recs);
        if (rut) scanPersistIdx('rut', rut.recs);
        if (tot) scanPersistIdx('tot', tot.recs);
        var ds1 = getScanData();
        if (ds1) { ds1.asOf = asOfDay; setScanData(ds1); }
        return 'data';
      }
      return false;
    }
    var s = scanFreshState();
    s.done = true;
    s.shared = true;
    s.sharedAsOf = spx.asOf;
    [rut, tot].forEach(function (p) { if (p && Date.parse(p.asOf) > Date.parse(s.sharedAsOf)) s.sharedAsOf = p.asOf; });
    s.results = { spx: spx.top, rut: rut ? rut.top : [], tot: tot ? tot.top : [] };
    var counts = { spx: 0, rut: 0, tot: 0 };
    [spx, rut, tot].forEach(function (p) {
      if (!p) return;
      Object.keys(p.recs).forEach(function (t) { if (p.recs[t].ix) counts[p.recs[t].ix] = (counts[p.recs[t].ix] || 0) + 1; });
    });
    s.idx.spx.started = true;
    s.idx.spx.scored = counts.spx;
    if (rut) { s.idx.rut.started = true; s.idx.rut.scored = counts.rut; }
    else { s.idx.rut = scanFreshIdx(false); }
    if (tot) { s.idx.tot.started = true; s.idx.tot.scored = counts.tot; }
    else { s.idx.tot = scanFreshIdx(false); }
    setScan(s);
    scanPersistIdx('spx', spx.recs);
    if (rut) scanPersistIdx('rut', rut.recs);
    if (tot) scanPersistIdx('tot', tot.recs);
    scanUpdateNewBadges(s.results);
    s.checked = true;
    setScan(s);
    scanSaveChecked(s.date, s.results, counts);
    scanDiag('shared scan adopted: spx ' + spx.top.length + ' rows, asOf ' + spx.asOf);
    renderScanCard();
    return true;
  } catch (e) { return false; }
  finally { scanSharedBusy = false; }
}

function scanRestart() {
  if (getScanData()) { setScan(scanFreshState()); renderScanCard(); scanPump(); return; }
  scanBootstrapFromHosted();
}

function maybeStartScan() {
  var existing = getScan();
  // Settled on-device (dataset) lists get two rescue checks before
  // they are simply re-shown: (1) a list computed under older ranking
  // rules (rules stamp mismatch) is recomputed from the dataset, and
  // (2) a morning refresh that never landed (footer stuck on
  // "refreshing…") is re-run, so the top-25 deep-dive it kicks off
  // gets another chance instead of the preliminary list sitting all
  // day. A refresh inside its first minutes counts as running; past
  // that it is treated as stuck and released. (2026-11-09: a pre-gates
  // list sat on Justin's phone all day with SNDK #1 at 98, unchecked.)
  if (existing && existing.date === scanTodayKey() && existing.fromData) {
    var dsFix = getScanData();
    if (dsFix && existing.rulesV !== SCAN_RULES_V) { scanRefreshReporters(); return; }
    if (dsFix && existing.refreshed === null && Date.now() - scanRekickAt > 10 * 60 * 1000) {
      if (!scanRefreshing || Date.now() - scanRefreshStartedAt > 3 * 60 * 1000) {
        scanRekickAt = Date.now();
        scanRefreshing = false;
        scanRefreshReporters();
        return;
      }
    }
    if (dsFix && existing.checked === false && !scanEnriching && Date.now() - scanRekickAt > 10 * 60 * 1000) {
      // The reporters refresh landed but the deep-dive never did
      // (app closed mid-pass): give the checks another run, or the
      // card sits on the last checked list all day.
      scanRekickAt = Date.now();
      scanEnrichTop(scanFullFromData(dsFix));
      return;
    }
  }
  if (!(existing && existing.date === scanTodayKey() && (existing.done || existing.partial || existing.fromData))) {
    scanAdoptShared().then(function (adopted) {
      if (adopted === true) { renderScanCard(); return; }
      if (adopted === 'data') { scanRefreshReporters(); return; }
      maybeStartScanCore();
    });
    return;
  }
  maybeStartScanCore();
}

function maybeStartScanCore() {
  var s = getScan();
  var today = scanTodayKey();
  if (s && s.date === today) {
    // No stored dataset yet but a hosted snapshot exists: it is at
    // least as current as any in-progress grind, so load it instead
    // of making the phone finish a 375-page scan even once.
    if (!s.fromData && !getScanData()) { scanBootstrapFromHosted(); return; }
    renderScanCard();
    if (!s.done && !s.partial && !s.fromData) scanPump();
    return;
  }
  var ds = getScanData();
  if (ds && ds.asOf) {
    var ageDays = (Date.parse(today + 'T12:00:00') - Date.parse(ds.asOf + 'T12:00:00')) / 86400000;
    if (ageDays < 7) { scanRefreshReporters(); return; }
  }
  scanBootstrapFromHosted();
}

function scanScoreClass(score) { return score >= 70 ? 'up' : (score >= 45 ? '' : 'down'); }
/* Pill color as a smooth ramp instead of the three hard buckets, so a
 * 44 and a 45 look nearly identical (Justin's call, 2026-10-31): red at
 * 30, the app's gold at 50 (Justin's middle tier, 2026-10-31: the
 * middle of the scale gets the color between green and red), green
 * at 70, clamped outside. */
function scanScoreStyle(score) {
  if (!isNum(score)) return '';
  var stops = [[30, [255, 90, 77]], [50, [248, 199, 61]], [70, [47, 191, 107]]];
  var c;
  if (score <= stops[0][0]) c = stops[0][1];
  else if (score >= stops[2][0]) c = stops[2][1];
  else {
    var a = score < 50 ? stops[0] : stops[1], b = score < 50 ? stops[1] : stops[2];
    var t = (score - a[0]) / (b[0] - a[0]);
    c = a[1].map(function (v, i) { return Math.round(v + (b[1][i] - v) * t); });
  }
  return ' style=' + String.fromCharCode(34) + 'color:rgb(' + c.join(',') + ');border-color:rgba(' + c.join(',') + ',.45)' + String.fromCharCode(34);
}

/* Tappable share-amount sheet for purchases/sales (Justin's ask,
 * 2026-10-26): typing ALL into a phone prompt was too easy to miss,
 * so the amount step is now an in-app sheet with a real All button.
 * Resolves with a number (All -> cap), NaN for an empty/invalid
 * entry (callers show their usual alert), or null on cancel. */
function pfShareSheet(title, cap, initial) {
  return new Promise(function (resolve) {
    var bg = document.createElement('div');
    bg.className = 'pf-sheet-bg';
    var allBtn = (isNum(cap) && cap > 0)
      ? '<button type="button" class="btn-ghost" id="pf-sh-all">All \u00b7 ' + fmtShares(cap) + '</button>' : '';
    bg.innerHTML = '<div class="pf-sheet"><h4>' + esc(title) + '</h4>' +
      '<div class="pf-sheet-row"><input id="pf-sh-in" type="text" inputmode="decimal" autocomplete="off" placeholder="Shares" value="' + (isNum(initial) ? esc(String(initial)) : '') + '">' + allBtn + '</div>' +
      '<div class="pf-sheet-row" style="margin-top:10px"><button type="button" class="btn-ghost" id="pf-sh-cancel" style="flex:1">Cancel</button><button type="button" class="pf-sh-save" id="pf-sh-ok" style="flex:1">Save</button></div></div>';
    document.body.appendChild(bg);
    var done = false;
    function close(v) {
      if (done) return; done = true;
      if (bg.parentNode) bg.parentNode.removeChild(bg);
      resolve(v);
    }
    bg.querySelector('#pf-sh-cancel').addEventListener('click', function () { close(null); });
    bg.addEventListener('click', function (e) { if (e.target === bg) close(null); });
    var all = bg.querySelector('#pf-sh-all');
    if (all) all.addEventListener('click', function () { close(cap); });
    bg.querySelector('#pf-sh-ok').addEventListener('click', function () {
      close(parseFloat(bg.querySelector('#pf-sh-in').value));
    });
    var inp = bg.querySelector('#pf-sh-in');
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); bg.querySelector('#pf-sh-ok').click(); }
    });
    setTimeout(function () { try { inp.focus(); inp.select(); } catch (e) {} }, 60);
  });
}

/* Justin's layout call (2026-11-08): the Total Market list leads the
 * scan card; the S&P 500 and Russell 2000 lists sit inside one
 * discreet dropdown, collapsed by default. scanIxOpen survives the
 * card's re-renders within the session. */
var scanIxOpen = false;
function scanIxDropdownHtml(inner) {
  if (!inner) return '';
  return '<button type="button" class="scan-ix-toggle' + (scanIxOpen ? ' open' : '') + '" data-scan-ixtoggle aria-expanded="' + (scanIxOpen ? 'true' : 'false') + '">' +
    '<span>S&amp;P 500 &amp; Russell 2000</span><span class="scan-ix-chev">▾</span></button>' +
    (scanIxOpen ? '<div class="scan-ix-body">' + inner + '</div>' : '');
}
function wireScanIxToggle(box) {
  var t = box.querySelector('[data-scan-ixtoggle]');
  if (t) t.addEventListener('click', function () { scanIxOpen = !scanIxOpen; renderScanCard(); });
}

function renderScanCard() {
  var box = $('scan-card');
  if (!box) return;
  var s = getScan();
  /* The last completed list, ranked from the stored dataset. Justin's
   * rule (2026-10-30): a list that was shown before is never taken
   * away while a new scan loads -- it stays on screen, even if it is
   * from yesterday, until the new stocks have actually landed. */
  var prevListsHtml = function () {
    var snap = scanGetChecked();
    if (!snap) return '';
    var out = '<div class="fineprint" style="margin:2px 0 8px">Last checked list \u00b7 ' + esc(snap.date || 'an earlier scan') + '</div>';
    var secs = {};
    SCAN_IDXS.forEach(function (ix) {
      var rows = snap.results[ix.key] || [];
      var n = snap.scored ? snap.scored[ix.key] : null;
      if (!rows.length && !isNum(n)) return;
      var out0 = out; out = '';
      out += '<div class="scan-group">' + esc(ix.label) + (isNum(n) ? ' <span class="scan-count">' + n + ' stocks scored' + (scanNewList(ix.key).length ? ' \u00b7 ' + scanNewList(ix.key).length + ' new' : '') + '</span>' : '') + '</div>';
      if (!rows.length) { out += '<div class="status">No scored stocks came back.</div>'; }
      rows.forEach(function (row, i) {
        out += '<button type="button" class="scan-row" data-scan-research="' + esc(row.t) + '">' +
          '<span class="scan-rank">' + (i + 1) + '</span>' +
          logoTile(row.t, 'sm') + '<span class="scan-id"><span class="scan-tline"><b>' + esc(row.t) + '</b>' + scanNewPill(ix.key, row.t) + (isNum(row.sev) && row.sev >= 0.5 ? ' <span class="scan-cyc">Cyclical</span>' : '') + (row.partial ? ' <span class="scan-cyc partial">partial</span>' : '') + '</span><span class="scan-sub"><span class="scan-nm">' + esc(row.name) + '</span></span></span>' +
          '<span class="scan-px">' + (isNum(row.price) ? fmtMoney(row.price) : '\u2014') + '</span>' +
          '<span class="scan-score"' + scanScoreStyle(row.score) + '>Score ' + row.score + '</span></button>';
      });
      secs[ix.key] = out; out = out0;
    });
    return out + (secs.tot || '') + scanIxDropdownHtml((secs.spx || '') + (secs.rut || ''));
  };
  if (!s || s.date !== scanTodayKey()) {
    var prev0 = prevListsHtml();
    box.innerHTML = '<div class="card scan-card"><div class="scan-h">Top value + low risk today' + infoDot('scanscore') + '</div>' + infoText('scanscore') +
      (prev0 || '<div class="status">Preparing today\'s scan\u2026</div>') + '</div>';
    box.querySelectorAll('[data-scan-research]').forEach(function (b) {
      b.addEventListener('click', function () {
        var T = b.getAttribute('data-scan-research');
        switchTab('scorecard');
        $('search-input').value = T;
        runSearch(T);
      });
    });
    wireScanIxToggle(box);
    return;
  }
  var snapC = scanGetChecked();
  var pendingGate = !!(s.done && s.results && s.checked === false);
  var html = '<div class="card scan-card"><div class="scan-h">Top value + low risk today <span class="scan-date">' + esc(pendingGate && snapC ? snapC.date : s.date) + '</span>' + infoDot('scanscore') + '</div>' + infoText('scanscore');
  var listsHtml = function () {
    var out = '';
    var secs = {};
    SCAN_IDXS.forEach(function (ix) {
      var rows = (s.results && s.results[ix.key]) || [];
      var z = s.idx[ix.key];
      var out0 = out; out = '';
      if (z.started === false) {
        out += '<div class="scan-group">' + esc(ix.label) + '</div>';
        if (ix.key === 'rut') {
          out += '<div class="fineprint" style="margin:0 0 8px">Scanned on demand, so the daily scan stays fast.</div>' +
            '<button type="button" class="btn-ghost" id="scan-start-rut">Scan Russell 2000</button>';
        } else {
          // No on-device crawl for this index; it arrives with the
          // shared daily scan.
          out += '<div class="fineprint" style="margin:0 0 8px">Runs in the shared daily scan.</div>';
        }
        secs[ix.key] = out; out = out0;
        return;
      }
      var newCt = scanNewList(ix.key).length;
      var countTxt = isNum(z.scored) ? z.scored + ' stocks scored' + (newCt ? ' \u00b7 ' + newCt + ' new' : '') : '';
      out += '<div class="scan-group">' + esc(ix.label) + (countTxt ? ' <span class="scan-count">' + countTxt + '</span>' : '') + '</div>';
      if (!rows.length) { out += '<div class="status">No scored stocks came back.</div>'; }
      rows.forEach(function (row, i) {
        out += '<button type="button" class="scan-row" data-scan-research="' + esc(row.t) + '">' +
          '<span class="scan-rank">' + (i + 1) + '</span>' +
          logoTile(row.t, 'sm') + '<span class="scan-id"><span class="scan-tline"><b>' + esc(row.t) + '</b>' + scanNewPill(ix.key, row.t) + (isNum(row.sev) && row.sev >= 0.5 ? ' <span class="scan-cyc">Cyclical</span>' : '') + (row.partial ? ' <span class="scan-cyc partial">partial</span>' : '') + '</span><span class="scan-sub"><span class="scan-nm">' + esc(row.name) + '</span></span></span>' +
          '<span class="scan-px">' + (isNum(row.price) ? fmtMoney(row.price) : '\u2014') + '</span>' +
          '<span class="scan-score"' + scanScoreStyle(row.score) + '>Score ' + row.score + '</span></button>';
      });
      secs[ix.key] = out; out = out0;
    });
    return (secs.tot || '') + scanIxDropdownHtml((secs.spx || '') + (secs.rut || ''));
  };
  if (pendingGate) {
    // Today's lists exist only as an unchecked preliminary ranking:
    // show the last checked list (or a checking note) until the
    // deep-dive lands -- never the prelim scores (2026-11-12).
    html += prevListsHtml();
    if (snapC) {
      html += '<div class="scan-foot">Checking today\u2019s stocks\u2026<button type="button" class="btn-mini" id="scan-rescan">Rescan</button></div>';
    } else {
      html += '<div class="status"><span class="spinner"></span>Running today\u2019s checks\u2026</div>';
    }
  } else if (s.done && s.results) {
    html += listsHtml();
    html += '<div class="scan-foot">' +
      (s.shared
        ? 'Shared scan \u00b7 ' + esc(new Date(s.sharedAsOf).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) + ' \u00b7 same for everyone'
        : s.fromData
        ? 'Data from ' + esc(s.dataAsOf || '') + (s.refreshed === null ? ' \u00b7 refreshing\u2026' : ' \u00b7 ' + (s.refreshed || 0) + ' refreshed today')
        : 'Full scan \u00b7 today') +
      '<button type="button" class="btn-mini" id="scan-rescan">Rescan</button></div>';
  } else if (s.partial && s.results) {
    var scoredSum = 0, totalSum = 0, droppedSum = 0;
    SCAN_IDXS.forEach(function (ix) {
      var z = s.idx[ix.key];
      if (z.started === false) return;
      scoredSum += z.scored || 0;
      totalSum += z.total || 0;
      droppedSum += z.dropped.length;
    });
    html += '<div class="status err">Partial scan \u2014 Finviz throttled (' + scoredSum + ' of ' + totalSum + ' stocks in). Provisional lists.</div>' +
      '<button type="button" class="btn-ghost" id="scan-resume">Resume the scan</button>';
    html += listsHtml();
    html += '<div class="scan-foot"><button type="button" class="btn-mini" id="scan-rescan">Start over</button></div>';
  } else {
    var pages = 0, stocks = 0, pending = 0;
    SCAN_IDXS.forEach(function (ix) {
      var z = s.idx[ix.key];
      pages += z.pages; pending += z.pending.length + z.dropped.length;
      stocks += Object.keys(z.merged).length;
    });
    if (pages === 0 && pending === 0 && !scanRunning) {
      html += '<div class="status err">The scan couldn\'t reach the data source.</div><button type="button" class="btn-ghost" id="scan-retry">Retry the scan</button>';
    } else {
      var pct = (pages + pending) > 0 ? Math.round(pages / (pages + pending) * 100) : 0;
      var cooling = scanCoolUntil > Date.now();
      var rutOn = s.idx.rut && s.idx.rut.started !== false;
      html += '<div class="status"><span class="spinner"></span>' + (cooling ? 'Finviz throttling \u2014 cooling down\u2026' : ((rutOn ? 'Scanning S&P 500 + Russell 2000' : 'Scanning S&P 500') + ' \u00b7 ' + pages + ' pages in')) + '</div>' +
        '<div class="scan-bar"><i style="width:' + pct + '%"></i></div>' +
        '<button type="button" class="btn-ghost" id="scan-use-snapshot" style="margin-top:8px">Stop scan \u2014 load the ready-made S&P 500 list</button>';
    }
    html += prevListsHtml();
  }
  html += '</div>';
  box.innerHTML = html;
  var rs = $('scan-rescan');
  if (rs) rs.addEventListener('click', function () { scanRestart(); });
  var rt = $('scan-retry');
  if (rt) rt.addEventListener('click', function () { scanRestart(); });
  var rm = $('scan-resume');
  if (rm) rm.addEventListener('click', function () { scanResume(); });
  var sr2 = $('scan-start-rut');
  if (sr2) sr2.addEventListener('click', function () { scanStartIndex('rut'); });
  var su = $('scan-use-snapshot');
  if (su) su.addEventListener('click', function () {
    // Stop the grind and show the stored lists NOW. Two sources:
    // this device's own dataset (a completed scan stored one) or the
    // hosted snapshot. The first version silently returned when a
    // dataset existed -- a button that does nothing is a bug
    // (Justin's report, 2026-10-29).
    scanRunning = false;
    scanBootstrapping = false;
    scanDiag('manual snapshot load tapped');
    var card = $('scan-card');
    if (card) card.innerHTML = '<div class="status"><span class="spinner"></span>Loading the ready-made S&P 500 list\u2026</div>';
    if (getScanData()) { scanRefreshReporters(); return; }
    scanBootstrapFromHosted();
  });
  box.querySelectorAll('[data-scan-research]').forEach(function (b) {
    b.addEventListener('click', function () {
      var T = b.getAttribute('data-scan-research');
      switchTab('scorecard');
      $('search-input').value = T;
      runSearch(T);
    });
  });
  wireScanIxToggle(box);
}

/* ---------- custom screener (over the stored scan dataset) ----------
 * Filters the records the daily scan already stored (sr_scan_data_v1)
 * with the app's own value screen fields, scored by the same
 * 60% value + 40% safety blend as the daily Top 10. Runs entirely
 * on-device against stored data — no new fetching. */
var SCR_FIELDS = ['fpe', 'peg', 'mcap', 'growth', 'below', 'de', 'beta', 'pm', 'cr', 'dy'];
var SCR_SAVED_KEY = 'sr_screens_v1';
function scanRecordScore(rec) {
  if (!(isNum(rec.forwardPE) && rec.forwardPE > 0)) return null;
  var s = scoreStock(rec, STD_W);
  if (!s || !isNum(s.score)) return null;
  var rk = riskScore(rec, STD_W); // no revPath on records: boom-bust sits out, same as the scan
  if (!rk || !isNum(rk.score)) return null;
  return { val: s.score, risk: rk.score, combined: Math.round(0.6 * s.score + 0.4 * (100 - rk.score)) };
}
function scrReadControls() {
  /* Russell 2000 is back in the Index select (2026-11-08): the
   * shared scan's Russell crawl now runs on StockAnalysis instead
   * of the Finviz-walled screener crawl, so the stored dataset
   * holds Russell records again and the option is real. (It was
   * removed 2026-11-07 while the Russell data never ran.) */
  var ixv = $('scr-ix').value;
  var f = { ix: (ixv === 'spx' || ixv === 'rut' || ixv === 'tot') ? ixv : 'both', sort: $('scr-sort').value, sector: $('scr-sector') ? $('scr-sector').value : 'all' };
  SCR_FIELDS.forEach(function (k) {
    var v = parseFloat($('scr-' + k).value);
    f[k] = isNum(v) ? v : null;
  });
  if (isNum(f.dy) && f.dy <= 0) f.dy = null;
  return f;
}
function scrApplyControls(f) {
  $('scr-ix').value = (f.ix === 'spx' || f.ix === 'rut' || f.ix === 'tot') ? f.ix : 'both'; // saved index screens reopen on their own index
  $('scr-sort').value = f.sort || 'combined';
  var ss = $('scr-sector'); if (ss) ss.value = f.sector || 'all';
  SCR_FIELDS.forEach(function (k) { $('scr-' + k).value = isNum(f[k]) ? f[k] : ''; });
}
function scrPasses(rec, f) {
  if (f.ix !== 'both' && !scanRecIx(rec, f.ix)) return false;
  if (f.sector && f.sector !== 'all' && sectorOf(rec) !== f.sector) return false;
  if (isNum(f.fpe) && !(isNum(rec.forwardPE) && rec.forwardPE <= f.fpe)) return false;
  if (isNum(f.peg) && !(isNum(rec.peg) && rec.peg <= f.peg)) return false;
  if (isNum(f.mcap) && !(isNum(rec.marketCap) && rec.marketCap >= f.mcap * 1e9)) return false;
  if (isNum(f.growth) && !(isNum(rec.epsGrowthNextY) && rec.epsGrowthNextY >= f.growth)) return false;
  if (isNum(f.below) && !(isNum(rec.pctBelowHigh) && rec.pctBelowHigh >= f.below)) return false;
  if (isNum(f.de) && !(isNum(rec.debtEq) && rec.debtEq <= f.de)) return false;
  if (isNum(f.beta) && !(isNum(rec.beta) && rec.beta <= f.beta)) return false;
  if (isNum(f.pm) && !(isNum(rec.profitMargin) && rec.profitMargin >= f.pm)) return false;
  if (isNum(f.cr) && !(isNum(rec.currentRatio) && rec.currentRatio >= f.cr)) return false;
  if (isNum(f.dy) && !(isNum(rec.divYield) && rec.divYield >= f.dy)) return false;
  return true;
}
function runScreener() {
  var box = $('scr-results');
  if (!box) return;
  var ds = getScanData();
  if (!ds || !ds.recs || !Object.keys(ds.recs).length) {
    box.innerHTML = '<div class="status">No stored scan data yet \u2014 the daily scan builds it.</div>' +
      '<button type="button" class="btn-ghost" id="scr-close2" style="margin-top:8px">Back to the scan card</button>';
    var c = $('scr-close2');
    if (c) c.addEventListener('click', function () { switchTab('watchlist'); });
    return;
  }
  var ss = $('scr-sector');
  if (ss) {
    var cur = ss.value || 'all';
    var secs = {};
    Object.keys(ds.recs).forEach(function (t) { secs[sectorOf(ds.recs[t])] = true; });
    var secNames = Object.keys(secs).filter(function (x) { return x !== 'Other'; }).sort();
    if (secs.Other) secNames.push('Other');
    ss.innerHTML = '<option value="all">All sectors</option>' + secNames.map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + '</option>'; }).join('');
    ss.value = (cur === 'all' || secNames.indexOf(cur) >= 0) ? cur : 'all';
  }
  var f = scrReadControls();
  var out = [];
  var anyYield = false, anyInd = false;
  Object.keys(ds.recs).forEach(function (t) {
    var rec = ds.recs[t];
    if (isNum(rec.divYield)) anyYield = true;
    if (rec.industry) anyInd = true;
    if (!scrPasses(rec, f)) return;
    var sc = scanRecordScore(rec);
    if (!sc) return;
    out.push({ t: t, name: rec.name, price: rec.price, forwardPE: rec.forwardPE, epsGrowthNextY: rec.epsGrowthNextY, pctBelowHigh: rec.pctBelowHigh, marketCap: rec.marketCap, score: sc.combined, sector: sectorOf(rec) });
  });
  var sorters = {
    combined: function (a, b) { return b.score - a.score; },
    fpe: function (a, b) { return a.forwardPE - b.forwardPE; },
    growth: function (a, b) { return (isNum(b.epsGrowthNextY) ? b.epsGrowthNextY : -1e9) - (isNum(a.epsGrowthNextY) ? a.epsGrowthNextY : -1e9); },
    below: function (a, b) { return (isNum(b.pctBelowHigh) ? b.pctBelowHigh : -1) - (isNum(a.pctBelowHigh) ? a.pctBelowHigh : -1); },
    mcap: function (a, b) { return (isNum(b.marketCap) ? b.marketCap : 0) - (isNum(a.marketCap) ? a.marketCap : 0); },
    sector: function (a, b) { var sa = a.sector === 'Other' ? 'ZZZ' : a.sector, sb = b.sector === 'Other' ? 'ZZZ' : b.sector; return sa < sb ? -1 : sa > sb ? 1 : (b.score - a.score); }
  };
  out.sort(sorters[f.sort] || sorters.combined);
  var html = '<div class="fineprint" style="margin:10px 0 4px">' + out.length + ' matches \u00b7 stored data from ' + esc(ds.asOf || 'an earlier scan') + '</div>';
  var sectorCounts = {};
  if (f.sort === 'sector') out.forEach(function (row) { sectorCounts[row.sector] = (sectorCounts[row.sector] || 0) + 1; });
  var lastSector = null;
  out.slice(0, 100).forEach(function (row, i) {
    if (f.sort === 'sector' && row.sector !== lastSector) {
      lastSector = row.sector;
      html += '<div class="scan-group">' + esc(row.sector) + ' <span class="scan-count">' + sectorCounts[row.sector] + ' stocks</span></div>';
    }
    html += '<button type="button" class="scan-row" data-scr-research="' + esc(row.t) + '">' +
      '<span class="scan-rank">' + (i + 1) + '</span>' +
      logoTile(row.t, 'sm') + '<span class="scan-id"><b>' + esc(row.t) + '</b><span>' + esc(row.name || row.t) + (row.sector !== 'Other' ? ' \u00b7 ' + esc(row.sector) : '') + '</span></span>' +
      '<span class="scan-px">' + (isNum(row.price) ? fmtMoney(row.price) : '\u2014') + '</span>' +
      '<span class="scan-score"' + scanScoreStyle(row.score) + '>Score ' + row.score + '</span></button>';
  });
  if (!out.length && isNum(f.dy) && !anyYield) html += '<div class="status">Dividend yield isn\'t in the stored data yet \u2014 it arrives with the next scan, or tap Rescan on the Watchlist scan card to get it now. <button type="button" class="link-btn" data-scr-gocard="1">Open the scan card</button></div>';
  else if (!out.length && f.sector && f.sector !== 'all' && !anyInd) html += '<div class="status">Sector data isn\'t in the stored data yet \u2014 it arrives with the next scan, or tap Rescan on the Watchlist scan card to get it now. <button type="button" class="link-btn" data-scr-gocard="1">Open the scan card</button></div>';
  else if (!out.length) html += '<div class="status">No stored stocks match those filters. <button type="button" class="link-btn" data-scr-clear="1">Clear the filters</button></div>';
  box.innerHTML = html;
  var scb = box.querySelector('[data-scr-clear]');
  if (scb) scb.addEventListener('click', function () { scrApplyControls({ ix: 'both', sort: 'combined' }); runScreener(); });
  var sgb = box.querySelector('[data-scr-gocard]');
  if (sgb) sgb.addEventListener('click', function () { switchTab('watchlist'); });
  box.querySelectorAll('[data-scr-research]').forEach(function (b) {
    b.addEventListener('click', function () {
      var T = b.getAttribute('data-scr-research');
      switchTab('scorecard');
      $('search-input').value = T;
      runSearch(T);
    });
  });
}
function getSavedScreens() { return lsGet(SCR_SAVED_KEY, []); }
function renderSavedScreens() {
  var box = $('scr-saved');
  if (!box) return;
  var list = getSavedScreens();
  if (!list.length) { box.innerHTML = ''; return; }
  var html = '';
  list.forEach(function (s, i) {
    html += '<span class="scr-chip"><button type="button" class="scr-chip-load" data-scr-load="' + i + '">' + esc(s.name) + '</button>' +
      '<button type="button" class="scr-chip-x" data-scr-del="' + i + '" aria-label="Delete saved screen">\u2715</button></span>';
  });
  box.innerHTML = html;
  box.querySelectorAll('[data-scr-load]').forEach(function (b) {
    b.addEventListener('click', function () {
      var s = getSavedScreens()[parseInt(b.getAttribute('data-scr-load'), 10)];
      if (s) { scrApplyControls(s.f); runScreener(); }
    });
  });
  box.querySelectorAll('[data-scr-del]').forEach(function (b) {
    b.addEventListener('click', function () {
      var list2 = getSavedScreens();
      var s = list2[parseInt(b.getAttribute('data-scr-del'), 10)];
      if (s && window.confirm('Delete saved screen "' + s.name + '"?')) {
        list2.splice(parseInt(b.getAttribute('data-scr-del'), 10), 1);
        lsSet(SCR_SAVED_KEY, list2);
        renderSavedScreens();
      }
    });
  });
}
/* The screener is a Tools sub-page (moved out of its watchlist
 * slide-over, Justin's ask, 2026-10-30); setTool('scr') activates it. */
function scrActivate() {
  renderSavedScreens();
  runScreener();
}

/* ---------- full-screen stock overview (watchlist tap) ----------
 * Justin's ask (2026-10-29): tapping a watchlist row opens a
 * full-screen overview of the stock -- a condensed scorecard
 * (verdicts, both screens, key stats, EPS path) with one-tap jumps
 * to the full scorecard and the Projection Builder. */
var ovTicker = null;
var ovReturnTicker = null;
var jrReturnTab = 'portfolio';
function showBackChips() {
  ['sc-back', 'tool-back'].forEach(function (id) {
    var b = $(id);
    if (b && ovReturnTicker) { b.textContent = '\u2190 Back to ' + ovReturnTicker + ' overview'; b.hidden = false; }
  });
}
function clearBackChips() {
  ovReturnTicker = null;
  ['sc-back', 'tool-back'].forEach(function (id) { var b = $(id); if (b) b.hidden = true; });
}
var toastTimer = null;
function showToast(msg) {
  var t = $('toast-bubble');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  void t.offsetWidth;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    t.classList.remove('show');
    setTimeout(function () { t.hidden = true; }, 280);
  }, 2600);
}
function goBackToOverview() {
  var T = ovReturnTicker;
  clearBackChips();
  switchTab('watchlist');
  if (T) openOverview(T);
}
function renderOverview(d, item) {
  var sc = scoreStock(d);
  var rk = riskScore(d);
  var chgCls = isNum(d.dayChangePct) ? (d.dayChangePct >= 0 ? 'up' : 'down') : '';
  var html = '<div class="card">';
  html += '<div class="sc-head"><div class="sc-head-l">' + logoTile(d.ticker, 'lg') + '<div><div class="sc-name">' + esc(d.companyName || d.ticker) + ' <span class="gold-text">' + esc(d.ticker) + '</span></div>' +
    '<div class="sc-sub">' + esc([d.exchange, d.sector, d.industry].filter(Boolean).join(' \u00b7 ')) + '</div></div></div>' +
    '<div class="sc-price"><div class="p">' + fmtMoney(d.price) + '</div>' +
    '<div class="chg ' + chgCls + '">' + (isNum(d.dayChangePct) ? fmtPct(d.dayChangePct) + ' today' : '') + '</div></div></div>';
  html += projStripHtml('ov-proj', d.ticker);
  html += earnLineHtml(d);
  html += ceoBlockHtml(d);
  if (item && isNum(item.target) && item.target > 0 && isNum(d.price)) {
    var above = (d.price / item.target - 1) * 100;
    html += '<p class="fineprint" style="margin:2px 0 8px">Your target buy: ' + fmtMoney(item.target) + ' \u2014 ' +
      (d.price <= item.target ? 'price is at or below it' : fmtNum(above, 1) + '% above it') + '.</p>';
  }
  html += fvBarHtml(d);
  if (sc.score != null) {
    var vClass = sc.verdict === 'Undervalued' ? 'undervalued' : (sc.verdict === 'Fairly valued' || sc.verdict === 'Value (cyclical peak risk)') ? 'fair' : 'overpriced';
    html += '<div class="verdict ' + vClass + '"><div><div class="v-label">Valuation verdict</div>' +
      '<div class="v-word">' + esc(sc.verdict) + '</div></div>' +
      '<button type="button" class="v-score pts-btn" data-mathbtn data-mathtarget="math-ovv" aria-expanded="false">' + sc.score + '<small> / 100</small></button></div>';
    html += '<div class="score-bar"><div style="width:' + sc.score + '%"></div></div>';
    if (weightsAreCustom()) {
      var ovScStd = scoreStock(d, STD_W);
      if (ovScStd.score != null && ovScStd.rawScore !== sc.rawScore) html += '<p class="fineprint">Your scoring weights \u00b7 standard weights score this ' + ovScStd.rawScore + '.</p>';
    }
    var ovScMath = 'Score = ' + sc.got + ' pts earned \u00f7 ' + sc.maxAvailable + ' pts available \u00d7 100 = ' + sc.rawScore + '.';
    if (sc.cycCapped) ovScMath += ' Capped at 70: cyclical severity ' + fmtNum(sc.severity, 2) + ' is 0.5 or higher (peak-earnings risk).';
    html += '<div class="math-box banner-math" id="math-ovv" hidden>' + esc(ovScMath) + '</div>';
  }
  if (rk.score != null) {
    var rClass = rk.score <= 25 ? 'risk-low' : rk.score <= 45 ? 'risk-mod' : rk.score <= 65 ? 'risk-elev' : 'risk-high';
    html += '<div class="verdict ' + rClass + '"><div><div class="v-label">Risk score</div>' +
      '<div class="v-word">' + esc(rk.verdict) + '</div></div>' +
      '<button type="button" class="v-score pts-btn" data-mathbtn data-mathtarget="math-ovr" aria-expanded="false">' + rk.score + '<small> / 100</small></button></div>';
    html += '<div class="score-bar risk-bar"><div style="width:' + rk.score + '%"></div></div>';
    if (weightsAreCustom()) {
      var ovRkStd = riskScore(d, STD_W);
      if (ovRkStd.score != null && ovRkStd.score !== rk.score) html += '<p class="fineprint">Your scoring weights \u00b7 standard weights put the risk at ' + ovRkStd.score + '.</p>';
    }
    var ovRkMath = 'Base = ' + rk.got + ' pts \u00f7 ' + rk.maxAvailable + ' pts available \u00d7 100 = ' + rk.base + '.';
    if (rk.cyc && rk.cyc.severity > 0) ovRkMath += ' Cyclical overlay: ' + rk.base + ' + (100 \u2212 ' + rk.base + ') \u00d7 ' + fmtNum(rk.cyc.severity, 2) + ' \u00d7 0.6 = ' + rk.score + '.';
    html += '<div class="math-box banner-math" id="math-ovr" hidden>' + esc(ovRkMath) + '</div>';
  }
  var ovAxes = radarAxes(d);
  if (radarCount(ovAxes) >= 3) {
    html += '<div class="section-h" style="margin-top:12px">At a glance</div>' + radarFlexHtml(ovAxes, cliffFlag(d), true);
  }
  var pw = epsProfitWarning(d);
  if (pw) html += '<div class="alert warn">' + esc(pw) + '</div>';
  var traj = epsTrajectory(d);
  if (traj.warning) html += '<div class="alert warn">' + esc(traj.warning) + '</div>';
  if (traj.points && traj.points.length) {
    html += '<div class="section-h">EPS <span class="gold-text">path</span></div>' +
      '<p style="margin:0 0 4px">' + traj.points.map(function (p) { return esc(p.label) + ' ' + fmtNum(p.eps); }).join(' \u2192 ') + '</p>';
  }
  var screen = valueScreen(d);
  var passCount = screen.filter(function (s) { return s.test === true; }).length;
  var knownCount = screen.filter(function (s) { return s.test !== null; }).length;
  html += '<div class="section-h">Your value screen \u2014 <span class="gold-text">' + passCount + ' of ' + knownCount + '</span></div><div class="screen-chips">';
  screen.forEach(function (s) {
    var cls = s.test === null ? '' : s.test ? 'pass' : 'fail';
    var mark = s.test === null ? '?' : s.test ? '\u2713 PASS' : '\u2717';
    html += '<div class="chip ' + cls + '"><span>' + esc(s.label) + '<br><span class="factor-note">' + esc(s.value) + '</span></span><span class="mark">' + mark + '</span></div>';
  });
  html += '</div>';
  var rScreen = riskScreen(d);
  var rPass = rScreen.filter(function (s) { return s.test === true; }).length;
  var rKnown = rScreen.filter(function (s) { return s.test !== null; }).length;
  html += '<div class="section-h">Risk screen \u2014 <span class="gold-text">' + rPass + ' of ' + rKnown + ' clear</span></div><div class="screen-chips">';
  rScreen.forEach(function (s) {
    var cls = s.test === null ? '' : s.test ? 'pass' : 'fail';
    var mark = s.test === null ? '?' : s.test ? '\u2713 CLEAR' : '\u2717 FLAG';
    html += '<div class="chip ' + cls + '"><span>' + esc(s.label) + '<br><span class="factor-note">' + esc(s.value) + '</span></span><span class="mark">' + mark + '</span></div>';
  });
  html += '</div>';
  html += '<div class="section-h">Key <span class="gold-text">stats</span></div><div class="kv-grid">';
  html += kvItem('Market cap', fmtCap(d.marketCap), 'mktcap');
  html += kvItem('Forward P/E', isNum(d.forwardPE) ? fmtNum(d.forwardPE, 2) : '\u2014');
  html += kvItem('P/E (trailing)', isNum(d.pe) ? fmtNum(d.pe, 2) : '\u2014');
  html += kvItem('PEG', isNum(d.peg) ? fmtNum(d.peg, 2) : '\u2014');
  html += kvItem('EPS (trailing)', isNum(d.epsTTM) ? fmtNum(d.epsTTM) : '\u2014');
  html += kvItem('EPS growth next yr', isNum(d.epsGrowthNextY) ? fmtPct(d.epsGrowthNextY) : '\u2014');
  html += kvItem('Revenue growth (TTM)', isNum(d.salesGrowthTTM) ? fmtPct(d.salesGrowthTTM) : '\u2014');
  html += kvItem('Profit margin', isNum(d.profitMargin) ? fmtNum(d.profitMargin, 1) + '%' : '\u2014');
  html += kvItem('Gross margin', isNum(d.grossMargin) ? fmtNum(d.grossMargin, 1) + '%' : '\u2014');
  html += kvItem('Debt / Equity', isNum(d.debtEq) ? fmtNum(d.debtEq, 2) : '\u2014');
  html += kvItem('Beta', isNum(d.beta) ? fmtNum(d.beta, 2) : '\u2014');
  html += kvItem('Current ratio', isNum(d.currentRatio) ? fmtNum(d.currentRatio, 2) : '\u2014');
  html += kvItem('Below 52-wk high', isNum(d.pctBelowHigh) ? fmtNum(d.pctBelowHigh, 1) + '%' : '\u2014');
  html += '</div>';
  html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">' +
    '<button type="button" class="btn-ghost" id="ov-scorecard">Full scorecard</button>' +
    '<button type="button" class="btn-ghost" id="ov-project">Projection</button>' +
    '<button type="button" class="btn-ghost" id="ov-edit-target">Edit target</button>' +
    '<button type="button" class="btn-ghost" id="ov-remove">Remove</button>' +
    '<a class="btn-ghost" style="text-decoration:none" href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&ticker=' + encodeURIComponent(d.ticker) + '&type=10-Q&dateb=&owner=include&count=10" target="_blank" rel="noopener">Earnings report</a>' +
    '<a class="btn-ghost" style="text-decoration:none" href="https://www.youtube.com/results?search_query=' + encodeURIComponent(d.ticker + ' earnings call') + '" target="_blank" rel="noopener">Earnings call</a></div>';
  html += stockNewsSectionHtml('ov', d.ticker);
  html += '</div>';
  return html;
}

function closeOverview() {
  ovTicker = null;
  var p = $('tab-overview');
  if (p) p.classList.remove('open');
}

function wireOverviewActions(d) {
  projStripFill('ov-proj', d.ticker);
  loadStockNews('ov', d.ticker);
  var sc = $('ov-scorecard');
  if (sc) sc.addEventListener('click', function () { ovReturnTicker = d.ticker; showBackChips(); closeOverview(); switchTab('scorecard'); $('search-input').value = d.ticker; runSearch(d.ticker); });
  var pj = $('ov-project');
  if (pj) pj.addEventListener('click', function () {
    ovReturnTicker = d.ticker; showBackChips();
    closeOverview();
    switchTab('tools');
    setTool('pj');
    // Same behavior the row's Projection button had: a saved
    // projection restores; otherwise the builder loads fresh data.
    if (getProjections()[d.ticker]) {
      pjRestore(d.ticker);
      var el = $('pj-result');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' });
    } else {
      $('pj-ticker').value = d.ticker;
      loadProjectionTicker();
    }
  });
  var et = $('ov-edit-target');
  if (et) et.addEventListener('click', function () {
    var cur = getWatchlist().filter(function (x) { return x.ticker === d.ticker; })[0];
    var v = window.prompt('Target buy price for ' + d.ticker + ' ($):', cur && isNum(cur.target) ? cur.target : '');
    if (v === null) return;
    var n = parseFloat(v);
    var wl2 = getWatchlist();
    wl2.forEach(function (x) { if (x.ticker === d.ticker) x.target = isNum(n) ? n : null; });
    setWatchlist(wl2);
    renderWatchlist(false);
    openOverview(d.ticker);
  });
  var rm = $('ov-remove');
  if (rm) rm.addEventListener('click', function () {
    setWatchlist(getWatchlist().filter(function (x) { return x.ticker !== d.ticker; }));
    closeOverview();
    renderWatchlist(false);
  });
}

function openOverview(T) {
  ovTicker = T;
  var item = null;
  getWatchlist().forEach(function (w) { if (w.ticker === T) item = w; });
  var panel = $('tab-overview');
  if (panel) { panel.scrollTop = 0; panel.classList.add('open'); }
  var body = $('ov-body');
  var cache = lsGet(CACHE_KEY, {});
  var hit = cache[T];
  if (hit && hit.data) {
    body.innerHTML = renderOverview(hit.data, item);
    wireOverviewActions(hit.data);
  } else {
    body.innerHTML = '<div class="card"><div class="status"><span class="spinner"></span>Loading ' + esc(T) + '\u2026</div></div>';
  }
  fetchStock(T).then(function (d) {
    if (ovTicker !== T) return;
    body.innerHTML = renderOverview(d, item);
    wireOverviewActions(d);
  }).catch(function (e) {
    if (ovTicker !== T || (hit && hit.data)) return;
    body.innerHTML = '<div class="card"><div class="alert warn">Could not load ' + esc(T) + ' \u2014 ' + esc((e && e.message) || 'fetch failed') + '</div><button type="button" class="btn-gold" id="ov-retry">Retry</button></div>';
    var rb = $('ov-retry');
    if (rb) rb.addEventListener('click', function () { openOverview(T); });
  });
}

async function renderWatchlist(refresh) {
  renderEarnCard();
  var wl = getWatchlist();
  var box = $('wl-list');
  if (!wl.length) {
    // Zero-moment fix (2026-11-12): example chips pre-fill the add
    // form above — they never add anything on their own.
    box.innerHTML = '<div class="empty-note"><h2>Nothing here yet</h2><p>Add a ticker and the buy price you\'re waiting for.</p>' +
      '<div class="ex-row">' +
      '<button type="button" class="w-chip" data-wl-ex="AAPL">Try AAPL</button>' +
      '<button type="button" class="w-chip" data-wl-ex="NVDA">Try NVDA</button>' +
      '<button type="button" class="w-chip" data-wl-ex="MSFT">Try MSFT</button>' +
      '</div></div>';
    box.querySelectorAll('[data-wl-ex]').forEach(function (b) {
      b.addEventListener('click', function () {
        var ti = $('wl-ticker'), tg = $('wl-target'), fm = $('wl-form');
        if (ti) ti.value = b.getAttribute('data-wl-ex');
        if (fm) fm.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (tg) { try { tg.focus({ preventScroll: true }); } catch (e) { tg.focus(); } }
      });
    });
    return;
  }
  if (refresh) $('wl-status').innerHTML = '<span class="spinner"></span>Refreshing\u2026';
  // Gather prices first so the list can be sorted on real numbers.
  var rows = [];
  for (var i = 0; i < wl.length; i++) {
    var item = wl[i];
    var price = null, err = null;
    try { price = await fetchLightPrice(item.ticker); } catch (e) { err = e.message; }
    var projMap = getProjections();
    var projEnt = wlProjEntry(item.ticker);
    rows.push({ item: item, price: price, err: err, val: wlValuationDisplay(item.ticker), proj: !!projMap[item.ticker], projCagr: projMap[item.ticker] ? pjSavedCagr(item.ticker) : null, autoCagr: projEnt ? projEnt.cagr : null });
  }
  // Stale or missing scores are filled by the paced background pass
  // after the rows paint (see wlFillPass) -- never by blocking here.
  var staleTickers = [];
  if (refresh) {
    rows.forEach(function (r) {
      if (!(r.val && r.val.fresh && isNum(r.val.risk))) staleTickers.push(r.item.ticker);
    });
  }
  var mode = getWlSort();
  rows.sort(function (a, b) {
    if (mode === 'valuation') {
      var sa = a.val ? a.val.score : -1, sb = b.val ? b.val.score : -1;
      return sb - sa;
    }
    if (mode === 'valuation-asc') {
      var sa2 = a.val ? a.val.score : 1000, sb2 = b.val ? b.val.score : 1000;
      return sa2 - sb2;
    }
    if (mode === 'target') {
      var da = (isNum(a.price) && isNum(a.item.target) && a.item.target > 0) ? (a.price / a.item.target - 1) : Infinity;
      var db = (isNum(b.price) && isNum(b.item.target) && b.item.target > 0) ? (b.price / b.item.target - 1) : Infinity;
      return da - db;
    }
    if (mode === 'riskreward') {
      var ca = wlDispCagr(a), cb = wlDispCagr(b);
      var ra = (isNum(ca) && a.val && isNum(a.val.risk) && a.val.risk > 0) ? ca / a.val.risk : -Infinity;
      var rb = (isNum(cb) && b.val && isNum(b.val.risk) && b.val.risk > 0) ? cb / b.val.risk : -Infinity;
      return rb - ra;
    }
    if (mode === 'cagr') {
      // Raw base-case CAGR alone (Justin's ask, 2026-11-12): the
      // risk/reward sort divides by risk; this one ranks on the
      // growth figure itself. No CAGR (no analyst path) sorts last.
      var ga = wlDispCagr(a), gb = wlDispCagr(b);
      return (isNum(gb) ? gb : -Infinity) - (isNum(ga) ? ga : -Infinity);
    }
    if (mode === 'ticker') return a.item.ticker.localeCompare(b.item.ticker);
    return (a.item.addedAt || 0) - (b.item.addedAt || 0);
  });
  var html = '';
  rows.forEach(function (r) {
    var item = r.item, price = r.price;
    // Thumbnail-clean rows (Justin's ask, 2026-10-29): ticker, price
    // and the valuation/risk line only. Target, distance-to-target,
    // projection and the action menu all live in the full-screen
    // overview a tap opens.
    html += '<div class="wl-row" data-ticker="' + esc(item.ticker) + '">' + logoTile(item.ticker) + '<div class="wl-left"><span class="wl-t">' + esc(item.ticker) + '</span>' +
      '<div class="wl-meta wl-val">' + (r.val ? wlValInner(r.val) : '') + '</div>' +
      '<div class="wl-meta wl-proj">' + wlProjInner(wlDispCagr(r), r.val) + '</div>' +
      '</div>' +
      '<div class="wl-right"><div class="wl-price">' + (isNum(price) ? fmtMoney(price) : '\u2014') + '</div>' +
      (r.err ? '<div style="text-align:right"><span class="factor-note">price unavailable</span></div>' : '') +
      '</div></div>';
  });
  $('wl-status').textContent = '';
  box.innerHTML = html;
  if (staleTickers.length) wlFillPass(staleTickers);
  var missProj = [];
  rows.forEach(function (r) { if (!wlProjEntry(r.item.ticker)) missProj.push(r.item.ticker); });
  if (missProj.length) wlProjPass(missProj);
  box.querySelectorAll('.wl-row').forEach(function (row) {
    row.addEventListener('click', function (e) {
      if (e.target.closest('button, a, select, input')) return;
      var T = row.getAttribute('data-ticker');
      if (T) openOverview(T);
    });
  });
}


/* ============================== portfolio ============================== */
/* Manual holdings tracker. The app asks how many shares are owned and
 * whether dividends are reinvested (DRIP); average cost is optional and
 * powers the gain/loss figures. Prices and dividend yields come from the
 * same light Finviz pass the watchlist valuation uses, and the last
 * known quotes are cached so the tab paints instantly. */
var PF_KEY = 'sr_portfolio_v1';
var PF_PX_KEY = 'sr_pfpx_v1';
var pfFetchedOnce = false;
function getPortfolio() { return lsGet(PF_KEY, []); }
function setPortfolio(p) { lsSet(PF_KEY, p); }
function pfQuotes() { return lsGet(PF_PX_KEY, {}); }
function fmtShares(v) { return isNum(v) ? String(parseFloat(v.toFixed(4))) : '—'; }

async function fetchPfQuote(T) {
  var html = await relayFetch('https://finviz.com/quote.ashx?t=' + encodeURIComponent(T));
  var d = { ticker: T, sources: [], errors: [] };
  fillFromFinviz(d, html);
  if (!isNum(d.price)) throw new Error('no price');
  var chg = d.sourceFinviz ? parseNum(d.sourceFinviz['Change %']) : null;
  return { price: d.price, divYield: isNum(d.divYield) ? d.divYield : null,
           dayChg: isNum(chg) ? chg : null, name: d.companyName || null, ts: Date.now() };
}

var pfOpen = {};
/* The user's Coolors palette (deep navy -> pale sky). When there are
 * more slices than palette colors, new colors are interpolated between
 * neighbouring palette stops so the gradient just gets finer. */
var PF_PALETTE = ['#012A4A', '#013A63', '#01497C', '#014F86', '#2A6F97', '#2C7DA0', '#468FAF', '#61A5C2', '#89C2D9', '#A9D6E5', '#95D5B2', '#F4E285', '#FFD6A5', '#FBC4D6'];
function pfPaletteColors(n) {
  // Always spread the picks across the whole palette (not just its
  // first stops), so the lighter, varied tones show even with only a
  // handful of holdings; extra colors are blended between stops.
  if (n <= 1) return PF_PALETTE.slice(0, Math.max(n, 0));
  function hx(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
  var stops = PF_PALETTE.map(hx), out = [];
  for (var i = 0; i < n; i++) {
    var t = i / (n - 1) * (stops.length - 1);
    var k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
    var rgb = stops[k].map(function (v, j) { return Math.round(v + (stops[k + 1][j] - v) * f); });
    out.push('#' + rgb.map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('').toUpperCase());
  }
  return out;
}
/* Readable initial-letter color on a palette disc: white on the dark
 * blues, near-black on the pale ones. */
function pfInk(hex) {
  var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.45 ? '#141414' : '#FFFFFF';
}
/* Estimated purchase date for a holding: the most recent day in the
 * cached daily history whose close sat within 3% of the average cost
 * the user entered. Returns a YYYYMMDD key, or null when the price
 * never came near the cost in the available history. */
function pfEstBuyKey(pts, cost) {
  if (!pts || !isNum(cost) || cost <= 0) return null;
  for (var i = pts.length - 1; i >= 0; i--) {
    if (Math.abs(pts[i][1] - cost) / cost <= 0.03) return pts[i][0];
  }
  return null;
}
function pfEstKeyFor(p, hh) {
  if (p.estOverride) { var dk = pfDkey(new Date(p.estOverride + 'T12:00:00')); if (isNum(dk) && dk > 0) return dk; }
  return (hh && isNum(p.cost)) ? pfEstBuyKey(hh.pts, p.cost) : null;
}
function pfSoldShares(p) { return (p.sells || []).reduce(function (a, s) { return a + s.sh; }, 0); }

/* Fully sold = the sales log covers everything the position ever
 * accounted for: the logged purchases when they exist, otherwise the
 * share count itself. (Before this, a position counted as closed
 * only if the user ALSO zeroed the share count by hand -- so selling
 * all 22 shares of NOW left it sitting in the open list, still
 * adding its value to the totals.) */
function pfIsClosed(pos) {
  var sold = pfSoldShares(pos);
  if (!(sold > 0)) return false;
  var bought = (pos.buys || []).reduce(function (a, b) { return a + (b.sh || 0); }, 0);
  var total = bought > 0 ? bought : (pos.shares || 0);
  return sold >= total - 1e-9;
}
function pfPriceAt(pts, key) {
  if (!pts || !pts.length) return null;
  var last = null;
  for (var i = 0; i < pts.length && pts[i][0] <= key; i++) last = pts[i][1];
  return last != null ? last : pts[0][1];
}
/* Realized result of a position's logged sales: proceeds from the
 * recorded sale prices (or that day's close), basis from the average
 * cost if given, else the weighted price of the logged buys. */
function pfRealized(p, hh) {
  if (!p.sells || !p.sells.length) return null;
  var soldSh = 0, proceeds = 0;
  p.sells.forEach(function (s) {
    var px = isNum(s.px) ? s.px : (hh ? pfPriceAt(hh.pts, pfDkey(new Date(s.d + 'T12:00:00'))) : null);
    if (isNum(px)) { proceeds += s.sh * px; soldSh += s.sh; }
  });
  if (!soldSh) return null;
  var basisPer = null;
  if (isNum(p.cost)) basisPer = p.cost;
  else if (p.buys && p.buys.length && hh) {
    var tb = 0, ts = 0;
    p.buys.forEach(function (b) { var bp = pfPriceAt(hh.pts, pfDkey(new Date(b.d + 'T12:00:00'))); if (isNum(bp)) { tb += b.sh * bp; ts += b.sh; } });
    if (ts > 0) basisPer = tb / ts;
  }
  var gain = isNum(basisPer) ? proceeds - basisPer * soldSh : null;
  return { proceeds: proceeds, gain: gain, pct: (isNum(gain) && basisPer > 0) ? gain / (basisPer * soldSh) * 100 : null, sh: soldSh };
}
function pfFmtDate(key) {
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return MON[(Math.floor(key / 100) % 100) - 1] + ' ' + (key % 100) + ', ' + Math.floor(key / 10000);
}
function pfKeyToISO(key) {
  return Math.floor(key / 10000) + '-' + String(Math.floor(key / 100) % 100).padStart(2, '0') + '-' + String(key % 100).padStart(2, '0');
}
function pfLogoErr(img) {
  var fb = img.getAttribute('data-fb');
  if (fb) { img.removeAttribute('data-fb'); img.removeAttribute('crossorigin'); img.src = fb; }
  else img.style.display = 'none';
}
/* A logo can "load" yet be invisible: FMP serves some logos (e.g. RH)
 * as all-white artwork, which vanishes on the white tile and never
 * triggers onerror. Sample the pixels; if nothing visible is darker
 * than near-white, treat it as a failed load and fall back. */
function pfLogoOk(img) {
  try {
    var c = document.createElement('canvas');
    c.width = 24; c.height = 24;
    var ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 24, 24);
    var px = ctx.getImageData(0, 0, 24, 24).data, visible = 0, nonWhite = 0;
    for (var i = 0; i < px.length; i += 4) {
      if (px[i + 3] > 24) { visible++; if (px[i] < 235 || px[i + 1] < 235 || px[i + 2] < 235) nonWhite++; }
    }
    if (!visible || !nonWhite) pfLogoErr(img);
  } catch (e) { /* no CORS on the fallback CDN: canvas tainted, keep image */ }
}
/* Company logo tile (Justin's rollout, 2026-10-30): white rounded
 * tile, ticker initial behind the image; pfLogoImg/p pfLogoErr give
 * the FMP -> Parqet -> letter fallback chain the Profile tab uses. */
function logoTile(ticker, cls) {
  var t = String(ticker || '?').toUpperCase();
  var base = cls === 'lg' ? 19 : cls === 'sm' ? 13 : 16;
  var f = t.length <= 2 ? 1 : t.length === 3 ? 0.8 : t.length === 4 ? 0.66 : 0.56;
  return '<span class="logo-tile ' + (cls || '') + '" aria-hidden="true"><span class="logo-txt" style="font-size:' + Math.round(base * f) + 'px">' + esc(t) + '</span>' + pfLogoImg(ticker) + '</span>';
}
function pfLogoImg(ticker) {
  return '<img class="pf-logo" src="https://financialmodelingprep.com/image-stock/' + encodeURIComponent(ticker) + '.png" data-fb="https://assets.parqet.com/logos/symbol/' + encodeURIComponent(ticker) + '?format=png" crossorigin="anonymous" onload="pfLogoOk(this)" onerror="pfLogoErr(this)" alt="">';
}
function pfKv(k, v) { return '<div class="pf-kv"><span>' + k + '</span><b>' + v + '</b></div>'; }

/* ============================== portfolio news ==============================
 * A News view inside the Portfolio tab: the latest headlines for the
 * stocks he actually holds, from Yahoo Finance's per-ticker RSS feeds
 * (through the relay), newest first, each tappable through to the
 * article. Cached on-device for 3 hours; a changed holdings list
 * counts as stale. Parsing is regex-based, same as the relay's own
 * headline reader. */
var PF_NEWS_TTL = 3 * 3600 * 1000;
var pfNewsLoading = false;

function pfNewsDecode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(parseInt(n, 10)); })
    .trim();
}

function parseYahooRss(xml, T) {
  var out = [];
  var itemRe = /<item>([\s\S]*?)<\/item>/g, m;
  while ((m = itemRe.exec(String(xml || ''))) !== null) {
    var body = m[1];
    var title = body.match(/<title>([\s\S]*?)<\/title>/);
    var link = body.match(/<link>([\s\S]*?)<\/link>/);
    var date = body.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    var source = body.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    if (!title || !link) continue;
    var ts = date ? Date.parse(pfNewsDecode(date[1])) : NaN;
    out.push({
      t: T,
      title: pfNewsDecode(title[1]),
      link: pfNewsDecode(link[1]),
      source: source ? pfNewsDecode(source[1]) : '',
      ts: isNum(ts) ? ts : 0
    });
  }
  return out;
}

function pfNewsAgo(ts) {
  if (!ts) return '';
  var mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return mins + 'm ago';
  var hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  var days = Math.round(hrs / 24);
  return days + (days === 1 ? ' day ago' : ' days ago');
}

function getPfNews() {
  try { return JSON.parse(localStorage.getItem('sr_pfnews_v1') || 'null'); } catch (e) { return null; }
}
function setPfNews(c) { try { localStorage.setItem('sr_pfnews_v1', JSON.stringify(c)); } catch (e) {} }
function pfNewsTickers() {
  return getPortfolio().filter(function (p) { return p.shares > 0 && !pfIsClosed(p); }).map(function (p) { return p.ticker; });
}
function pfNewsStale() {
  var c = getPfNews();
  if (!c) return true;
  if (c.tickersKey !== pfNewsTickers().join(',')) return true;
  return (Date.now() - (c.fetchedAt || 0)) > PF_NEWS_TTL;
}

function renderPfNews() {
  var box = $('pf-news');
  if (!box) return;
  var tickers = pfNewsTickers();
  var head = '<div class="row-between"><span class="scan-h">News for your holdings</span>' +
    '<button type="button" class="btn-mini" id="pf-news-refresh">Refresh</button></div>';
  if (!tickers.length) {
    box.innerHTML = head + '<div class="empty-note"><p>Add a holding and its latest headlines will show up here.</p><div class="ex-row"><button type="button" class="btn-gold" id="pf-news-add">Add a holding</button></div></div>';
  } else {
    var c = getPfNews();
    if (pfNewsLoading) {
      box.innerHTML = head + '<div class="status"><span class="spinner"></span>Fetching headlines for ' + tickers.length + ' holdings\u2026</div>';
    } else if (!c || !c.items) {
      box.innerHTML = head + '<div class="status">Tap Refresh to fetch today\'s headlines.</div>';
    } else if (!c.items.length) {
      box.innerHTML = head + '<div class="status">No headlines came back \u2014 try Refresh.</div>';
    } else {
      var updated = c.fetchedAt ? 'Updated ' + pfNewsAgo(c.fetchedAt) : '';
      var newsCols = pfPaletteColors(Math.max(1, tickers.length));
      var rowsHtml = c.items.map(function (it) {
        var meta = [it.source, pfNewsAgo(it.ts)].filter(Boolean).join(' \u00b7 ');
        var col = newsCols[Math.max(0, tickers.indexOf(it.t)) % newsCols.length];
        return '<a class="news-row" href="' + esc(it.link) + '" target="_blank" rel="noopener">' +
          '<span class="pf-avatar news-ava" style="background:' + col + ';color:' + pfInk(col) + '">' + esc(it.t.charAt(0)) + pfLogoImg(it.t) + '</span>' +
          '<span class="news-main"><b>' + esc(it.title) + '</b><span>' + esc(it.t) + (meta ? ' \u00b7 ' + esc(meta) : '') + '</span></span></a>';
      }).join('');
      box.innerHTML = head + (updated ? '<div class="status">' + updated + ' \u00b7 Yahoo Finance</div>' : '') + '<div class="card news-card">' + rowsHtml + '</div>';
    }
  }
  var rb = $('pf-news-refresh');
  if (rb) rb.addEventListener('click', function () { refreshPfNews(true); });
  var ab = $('pf-news-add');
  if (ab) ab.addEventListener('click', function () {
    // Jump to the Overview's add-a-holding form (same open state the
    // toggle controls) and put the cursor in the ticker box.
    pfSetView('overview');
    var fb = $('pf-add-body'), card = document.querySelector('.pf-add-card'), tg = $('pf-add-toggle');
    if (fb && fb.hidden) {
      fb.hidden = false;
      if (card) card.classList.add('open');
      if (tg) tg.setAttribute('aria-expanded', 'true');
    }
    var ti = $('pf-ticker');
    if (ti) { ti.scrollIntoView({ behavior: 'smooth', block: 'center' }); try { ti.focus({ preventScroll: true }); } catch (e) { ti.focus(); } }
  });
}

async function refreshPfNews(force) {
  if (pfNewsLoading) return;
  if (!force && !pfNewsStale()) { renderPfNews(); return; }
  var tickers = pfNewsTickers();
  if (!tickers.length) { renderPfNews(); return; }
  pfNewsLoading = true;
  renderPfNews();
  var per = await Promise.all(tickers.map(async function (T) {
    try {
      var xml = await relayFetch('https://feeds.finance.yahoo.com/rss/2.0/headline?s=' + encodeURIComponent(T) + '&region=US&lang=en-US');
      return parseYahooRss(xml, T).slice(0, 4);
    } catch (e) { return []; }
  }));
  var seen = {}, items = [];
  per.forEach(function (arr) {
    arr.forEach(function (it) {
      if (it.link && !seen[it.link]) { seen[it.link] = 1; items.push(it); }
    });
  });
  items.sort(function (a, b) { return b.ts - a.ts; });
  setPfNews({ fetchedAt: Date.now(), tickersKey: tickers.join(','), items: items.slice(0, 60) });
  pfNewsLoading = false;
  renderPfNews();
}

/* ====================== per-stock news (scorecard + overview) ======================
 * Justin's ask (2026-11-08): the same headlines treatment as the
 * Portfolio News view, but per stock — a "Latest news" section at the
 * bottom of the scorecard and of the watchlist overview drawer. Same
 * Yahoo RSS feed, parser and row markup as the holdings news above.
 * Cached on-device per ticker for 1 hour (device-only, never synced);
 * the section renders as a placeholder and fills in async, and a fetch
 * that resolves after the user moved to another stock never paints. */
var STOCK_NEWS_KEY = 'sr_stocknews_v1';
var STOCK_NEWS_TTL = 3600 * 1000;
var stockNewsPending = {}; // TICKER -> shared in-flight fetch promise

function stockNewsAll() { return lsGet(STOCK_NEWS_KEY, {}); }
function stockNewsEntry(T) {
  var e = stockNewsAll()[T];
  return (e && Array.isArray(e.items)) ? e : null;
}
function saveStockNews(T, items) {
  var all = stockNewsAll();
  all[T] = { fetchedAt: Date.now(), items: items.slice(0, 6) };
  var keys = Object.keys(all).sort(function (a, b) { return (all[b].fetchedAt || 0) - (all[a].fetchedAt || 0); });
  var out = {};
  keys.slice(0, 40).forEach(function (k) { out[k] = all[k]; });
  lsSet(STOCK_NEWS_KEY, out);
}
function stockNewsSectionHtml(scope, T) {
  return '<div class="section-h">Latest <span class="gold-text">news</span></div>' +
    '<div data-stocknews="' + scope + '" data-ticker="' + esc(T) + '"><div class="status">Loading headlines\u2026</div></div>';
}
function stockNewsRowsHtml(items) {
  var col = pfPaletteColors(1)[0];
  return items.map(function (it) {
    var meta = [it.source, pfNewsAgo(it.ts)].filter(Boolean).join(' \u00b7 ');
    return '<a class="news-row" href="' + esc(it.link) + '" target="_blank" rel="noopener">' +
      '<span class="pf-avatar news-ava" style="background:' + col + ';color:' + pfInk(col) + '">' + esc(it.t.charAt(0)) + pfLogoImg(it.t) + '</span>' +
      '<span class="news-main"><b>' + esc(it.title) + '</b><span>' + esc(meta) + '</span></span></a>';
  }).join('');
}
function paintStockNews(scope, T, items) {
  var box = document.querySelector('[data-stocknews="' + scope + '"]');
  if (!box || box.getAttribute('data-ticker') !== T) return;
  if (scope === 'sc' && (!lastStock || lastStock.ticker !== T)) return;
  if (scope === 'ov' && ovTicker !== T) return;
  box.innerHTML = (items && items.length)
    ? '<div class="card news-card">' + stockNewsRowsHtml(items) + '</div>'
    : '<p class="fineprint">No recent headlines.</p>';
}
function fetchStockNews(T) {
  if (stockNewsPending[T]) return stockNewsPending[T];
  var p = relayFetch('https://feeds.finance.yahoo.com/rss/2.0/headline?s=' + encodeURIComponent(T) + '&region=US&lang=en-US')
    .then(function (xml) {
      var items = parseYahooRss(xml, T).slice(0, 6);
      saveStockNews(T, items);
      return items;
    })
    .catch(function () {
      var e = stockNewsEntry(T);
      return e ? e.items : [];
    })
    .then(function (items) { delete stockNewsPending[T]; return items; });
  stockNewsPending[T] = p;
  return p;
}
async function loadStockNews(scope, T) {
  if (!T) return;
  var e = stockNewsEntry(T);
  if (e) {
    paintStockNews(scope, T, e.items);
    if (Date.now() - (e.fetchedAt || 0) <= STOCK_NEWS_TTL) return; // fresh cache: no fetch
  }
  var items = await fetchStockNews(T);
  paintStockNews(scope, T, items);
}

function pfView() { return localStorage.getItem('sr_pfview_v1') === 'news' ? 'news' : 'overview'; }
function pfSetView(v) {
  try { localStorage.setItem('sr_pfview_v1', v); } catch (e) {}
  var sec = $('tab-portfolio');
  if (sec) sec.classList.toggle('news-mode', v === 'news');
  var bo = $('pf-view-overview'), bn = $('pf-view-news'), news = $('pf-news');
  if (bo) bo.classList.toggle('on', v !== 'news');
  if (bn) bn.classList.toggle('on', v === 'news');
  if (news) news.hidden = v !== 'news';
  if (v === 'news') { renderPfNews(); refreshPfNews(false); }
}

async function renderPortfolio(doFetch) {
  var listBox = $('pf-list'), sumBox = $('pf-summary'), status = $('pf-status');
  if (!listBox || !sumBox) return;
  var positions = getPortfolio();
  if (!positions.length) {
    sumBox.innerHTML = '';
    var bb0 = $('pf-bench'); if (bb0) bb0.innerHTML = '';
    var cb0 = $('pf-closed'); if (cb0) cb0.innerHTML = '';
    listBox.innerHTML = '<div class="card"><h3 style="margin-top:0">Nothing here yet</h3><p class="fineprint" style="margin:0">Add a stock you own above and the app tracks its value and dividend income here.</p></div>';
    if (status) status.textContent = '';
    return;
  }
  if (doFetch) {
    if (status) status.innerHTML = '<span class="spinner"></span>Fetching live prices\u2026';
    var quotes = pfQuotes();
    await Promise.all(positions.map(async function (p) {
      if (!(p.shares > 0)) return;
      try { quotes[p.ticker] = await fetchPfQuote(p.ticker); } catch (e) {}
    }));
    lsSet(PF_PX_KEY, quotes);
    pfFetchedOnce = true;
    if (status) status.textContent = '';
  }
  var q = pfQuotes();
  // First pass: derive everything per holding and total it up.
  var totVal = 0, totInc = 0, totCost = 0, anyCost = false, dayNum = 0, dayDen = 0;
  var rows = positions.map(function (p) {
    var closed = pfIsClosed(p);
    var qt = q[p.ticker] || {};
    var px = isNum(qt.price) ? qt.price : null;
    var val = isNum(px) ? px * p.shares : null;
    var inc = (isNum(val) && isNum(qt.divYield)) ? val * qt.divYield / 100 : null;
    var costTot = isNum(p.cost) ? p.cost * p.shares : null;
    var gain = (isNum(val) && isNum(costTot)) ? val - costTot : null;
    var gainPct = (isNum(gain) && costTot > 0) ? gain / costTot * 100 : null;
    if (!closed) {
      if (isNum(val)) totVal += val;
      if (isNum(inc)) totInc += inc;
      if (isNum(costTot)) { totCost += costTot; anyCost = true; }
      if (isNum(val) && isNum(qt.dayChg)) { dayNum += val * qt.dayChg; dayDen += val; }
    }
    return { p: p, qt: qt, px: px, val: val, inc: inc, gain: gain, gainPct: gainPct, closed: closed };
  });
  var anyPx = totVal > 0;
  var dayPct = dayDen > 0 ? dayNum / dayDen : null;
  // Colors follow value rank so the chart, its labels and the rows agree.
  var ranked = rows.filter(function (r) { return !r.closed && isNum(r.val) && r.val > 0; }).slice().sort(function (a, b) { return b.val - a.val; });
  var sliceColors = pfPaletteColors(ranked.length);
  var colorOf = {};
  ranked.forEach(function (r, i) { colorOf[r.p.ticker] = sliceColors[i]; });
  // Holdings list: biggest first, like the reference.
  var ordered = rows.slice().sort(function (a, b) { return (b.val || 0) - (a.val || 0); });
  var html = '';
  ordered.forEach(function (r) {
    var p = r.p, qt = r.qt;
    var isClosed = r.closed;
    if (isClosed || (p.shares === 0 && pfSoldShares(p) > 0)) return;
    var rzH = isClosed ? pfRealized(p, pfHistAll()[p.ticker]) : null;
    var frac = (isNum(r.val) && totVal > 0) ? r.val / totVal * 100 : null;
    var open = !!pfOpen[p.ticker];
    var col = colorOf[p.ticker] || '#5A5A5E';
    var rowH = '<div class="wl-row pf-row' + (open ? ' open' : '') + '">' +
      '<button class="pf-head" data-pf-toggle="' + esc(p.ticker) + '" aria-expanded="' + open + '">' +
        '<span class="pf-avatar" style="background:' + col + ';color:' + pfInk(col) + '">' + esc(p.ticker.charAt(0)) + pfLogoImg(p.ticker) + '</span>' +
        '<span class="wl-left"><span class="wl-t">' + esc(p.ticker) + '</span>' +
        (qt.name ? '<span class="pf-name">' + esc(qt.name) + '</span>' : '') + '</span>' +
        '<span class="pf-alloc">' + (isClosed ? 'Closed' : isNum(frac) ? fmtNum(frac, 1) + '%' : '\u2014') + '</span>' +
        '<span class="wl-right"><span class="pf-valpill">' + (isClosed ? (rzH && isNum(rzH.gain) ? (rzH.gain >= 0 ? '+' : '') + fmtMoney(rzH.gain, 0) : 'Sold') : isNum(r.val) ? fmtMoney(r.val, 0) : '\u2014') + '</span>' +
        '<span class="wl-meta" style="text-align:right">' + (isClosed ? 'fully sold' : isNum(r.px) ? fmtMoney(r.px) + '/share' : 'price unavailable') + '</span></span>' +
        '<span class="pf-chev">\u25be</span>' +
      '</button>';
    if (open) {
      rowH += '<div class="pf-detail">' +
        pfKv('Shares', fmtShares(p.shares)) +
        (isNum(qt.dayChg) ? pfKv('Today', '<span class="' + (qt.dayChg >= 0 ? 'up' : 'down') + '">' + fmtPct(qt.dayChg) + '</span>') : '') +
        pfKv('Dividends', p.drip ? 'Reinvested (DRIP)' : 'Paid as cash') +
        (isNum(r.inc) ? pfKv('Est. dividend income', '\u2248 ' + fmtMoney(r.inc, 0) + '/yr') : '') +
        (p.drip && isNum(r.inc) && isNum(r.px) && r.px > 0 ? pfKv('DRIP buys', '\u2248 ' + fmtShares(r.inc / r.px) + ' shares/yr') : '') +
        '<div class="wl-actions"><button class="link-btn" data-pf-research="' + esc(p.ticker) + '">Research</button>' +
        '<button class="link-btn" data-pf-edit="' + esc(p.ticker) + '">Edit</button>' +
        '<button class="link-btn danger" data-pf-del="' + esc(p.ticker) + '">Remove</button></div>' +
      '</div>';
    }
    rowH += '</div>';
    html += rowH;
  });
  listBox.innerHTML = html;
  // Donut with label pills around it, Blossom-style. Slices group into
  // "Other" only when there are more than 8 holdings.
  var chartHtml = '';
  if (ranked.length && totVal > 0) {
    var slices = [], otherVal = 0, otherMembers = [];
    ranked.forEach(function (r, i) {
      if (ranked.length > 8 && i >= 7) { otherVal += r.val; otherMembers.push({ label: r.p.ticker, name: r.qt.name || r.p.ticker, val: r.val, col: colorOf[r.p.ticker] }); }
      else slices.push({ label: r.p.ticker, name: r.qt.name || r.p.ticker, val: r.val, col: colorOf[r.p.ticker], initial: r.p.ticker.charAt(0) });
    });
    if (otherVal > 0) slices.push({ label: 'Other', name: 'Other holdings', val: otherVal, col: '#5B7183', initial: '\u2022', members: otherMembers });
    var C = 2 * Math.PI * 78, off = 0, circles = '', pills = '';
    var mids = [];
    var sliceByLabel = {};
    slices.forEach(function (s) { sliceByLabel[s.label] = s; });
    slices.forEach(function (s) {
      var frac = s.val / totVal;
      var seg = Math.max(frac * C - 2, 0.5);
      circles += '<circle data-slice="' + esc(s.label) + '" cx="100" cy="100" r="78" fill="none" stroke="' + s.col + '" stroke-width="30" stroke-dasharray="' + seg.toFixed(1) + ' ' + (C - seg).toFixed(1) + '" stroke-dashoffset="' + (-off).toFixed(1) + '"/>';
      mids.push({ s: s, frac: frac, ang: (off + frac * C / 2) / C * 2 * Math.PI - Math.PI / 2 });
      off += frac * C;
    });
    // Label placement: every pill sits centered on its own slice's
    // mid-angle. Neighbours that would collide (tiny slices side by
    // side) are relaxed apart by the smallest possible nudge, split
    // evenly between the pair, so centering is preserved as closely
    // as physics allows.
    mids.sort(function (p, q2) { return p.ang - q2.ang; });
    var GAP = 0.30;
    for (var it = 0; it < 12 && mids.length > 1; it++) {
      var moved = false;
      for (var i3 = 1; i3 < mids.length; i3++) {
        var need = mids[i3 - 1].ang + GAP - mids[i3].ang;
        if (need > 0) { mids[i3 - 1].ang -= need / 2; mids[i3].ang += need / 2; moved = true; }
      }
      var wrapGap = (mids[0].ang + 2 * Math.PI) - mids[mids.length - 1].ang;
      if (wrapGap < GAP) { var wd = (GAP - wrapGap) / 2; mids[mids.length - 1].ang -= wd; mids[0].ang += wd; moved = true; }
      if (!moved) break;
    }
    mids.forEach(function (m) {
      var x = 50 + 44.5 * Math.cos(m.ang), y = 50 + 44.5 * Math.sin(m.ang);
      x = Math.min(90.5, Math.max(9.5, x)); y = Math.min(93.5, Math.max(6.5, y));
      pills += '<span class="pf-pill" style="left:' + x.toFixed(1) + '%;top:' + y.toFixed(1) + '%"><span class="pf-pill-dot" style="background:' + m.s.col + ';color:' + pfInk(m.s.col) + '">' + esc(m.s.initial) + (m.s.label !== 'Other' ? pfLogoImg(m.s.label) : '') + '</span>' + fmtNum(m.frac * 100, 0) + '%</span>';
    });
    // Donut center = today's move (Justin's pick, 2026-10-26): the
    // total value already headlines the card, so the center carries
    // the day's dollar move (big) and its weighted % (label).
    var dayDol = null;
    rows.forEach(function (r) {
      if (!r.closed && isNum(r.val) && isNum(r.qt.dayChg)) dayDol = (dayDol || 0) + r.val * r.qt.dayChg / (100 + r.qt.dayChg);
    });
    var center;
    if (isNum(dayDol) && isNum(dayPct)) {
      var dSign = dayDol > 0 ? '+' : (dayDol < 0 ? '\u2212' : '');
      var dFill = dayDol > 0 ? 'var(--neon-up)' : (dayDol < 0 ? 'var(--neon-dn)' : 'var(--chart-val)');
      center = '<text x="100" y="79" text-anchor="middle" class="pf-c-l">TODAY</text>' +
        '<text x="100" y="107" text-anchor="middle" class="pf-c-v" style="fill:' + dFill + '">' + fmtPct(dayPct) + '</text>' +
        '<text x="100" y="129" text-anchor="middle" class="pf-c-l">' + dSign + fmtMoney(Math.abs(dayDol), 0) + '</text>';
    } else {
      center = '<text x="100" y="92" text-anchor="middle" class="pf-c-l">TOTAL VALUE</text><text x="100" y="120" text-anchor="middle" class="pf-c-v">' + fmtMoney(totVal, 0) + '</text>';
    }
    chartHtml = '<div class="pf-donut"><svg viewBox="0 0 200 200" role="img" aria-label="Portfolio allocation chart"><g transform="rotate(-90 100 100)">' + circles + '</g>' + center + '</svg>' + pills + '</div><div class="pf-pop" hidden></div>';
  }
  var yld = (anyPx && totVal > 0) ? totInc / totVal * 100 : null;
  var totGain = totVal - totCost;
  sumBox.innerHTML = '<div class="card"><div class="pf-sum-v">' + (anyPx ? fmtMoney(totVal, 0) : '\u2014') + '</div>' +
    '<div class="wl-meta">Total value \u00b7 ' + rows.filter(function (r) { return !r.closed; }).length + ' holding' + (rows.filter(function (r) { return !r.closed; }).length === 1 ? '' : 's') + '</div>' +
    '<div class="pf-sum-row"><span>Est. dividends <b>' + fmtMoney(totInc, 0) + '/yr</b>' + (isNum(yld) ? ' \u00b7 ' + fmtNum(yld, 2) + '% yield' : '') + '</span>' +
    '</div>' + chartHtml + '</div>';
  var popEl = sumBox.querySelector('.pf-pop');
  var circEls = sumBox.querySelectorAll('[data-slice]');
  circEls.forEach(function (c) {
    c.addEventListener('click', function () {
      var label = c.getAttribute('data-slice');
      var wasOn = c.getAttribute('data-on') === '1';
      circEls.forEach(function (o) { o.style.opacity = ''; o.removeAttribute('data-on'); });
      if (wasOn) { if (popEl) popEl.hidden = true; return; }
      c.setAttribute('data-on', '1');
      circEls.forEach(function (o) { if (o !== c) o.style.opacity = '0.35'; });
      var s = sliceByLabel[label];
      if (popEl && s) {
        popEl.onclick = null;
        popEl.classList.remove('clickable');
        var popHtml = '<b>' + esc(s.name) + '</b><span>' + esc(s.label) + ' \u00b7 ' + fmtNum(s.val / totVal * 100, 1) + '% of portfolio \u00b7 ' + fmtMoney(s.val, 0) + '</span>';
        if (s.members && s.members.length) {
          popHtml += '<span class="pf-pop-hint">Tap here to see the holdings inside \u25be</span><div class="pf-pop-list" hidden>' +
            s.members.map(function (mb) {
              return '<div class="pf-pop-row"><span class="pf-pop-dot" style="background:' + mb.col + '"></span><b>' + esc(mb.label) + '</b><span class="pf-pop-row-n">' + esc(mb.name) + '</span><span>' + fmtNum(mb.val / totVal * 100, 1) + '% \u00b7 ' + fmtMoney(mb.val, 0) + '</span></div>';
            }).join('') + '</div>';
          popEl.classList.add('clickable');
          popEl.onclick = function () {
            var lst = popEl.querySelector('.pf-pop-list');
            var hint = popEl.querySelector('.pf-pop-hint');
            if (lst) {
              lst.hidden = !lst.hidden;
              if (hint) hint.textContent = lst.hidden ? 'Tap here to see the holdings inside \u25be' : 'Tap here to hide the holdings inside \u25b4';
            }
          };
        }
        popEl.innerHTML = popHtml;
        popEl.hidden = false;
      }
    });
  });
  document.querySelectorAll('[data-pf-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var T = b.getAttribute('data-pf-toggle');
      pfOpen[T] = !pfOpen[T];
      renderPortfolio(false);
    });
  });
  document.querySelectorAll('[data-pf-research]').forEach(function (b) {
    b.addEventListener('click', function () { switchTab('scorecard'); $('search-input').value = b.getAttribute('data-pf-research'); runSearch(b.getAttribute('data-pf-research')); });
  });
  document.querySelectorAll('[data-pf-del]').forEach(function (b) {
    b.addEventListener('click', function () {
      setPortfolio(getPortfolio().filter(function (x) { return x.ticker !== b.getAttribute('data-pf-del'); }));
      renderPortfolio(false);
    });
  });
  document.querySelectorAll('[data-pf-edit]').forEach(function (b) {
    b.addEventListener('click', function () {
      var T = b.getAttribute('data-pf-edit');
      var pf = getPortfolio();
      var pos = pf.filter(function (x) { return x.ticker === T; })[0];
      if (!pos) return;
      var s = window.prompt('How many shares of ' + T + ' do you own?', pos.shares);
      if (s === null) return;
      var ns = parseFloat(s);
      if (isNum(ns) && ns >= 0) pos.shares = ns;
      var dr = window.prompt('Are dividends reinvested for ' + T + '? Type yes or no:', pos.drip ? 'yes' : 'no');
      if (dr !== null) pos.drip = /^y/i.test(String(dr).trim());
      setPortfolio(pf);
      renderPortfolio(false);
    });
  });
}

/* ============================== portfolio vs S&P 500 ============================== */
/* Benchmark tracker: rebuilds the portfolio's daily value from the
 * share counts entered (held constant) and races it against SPY.
 * Price return only -- dividends are not in the lines. */
var PF_HIST_KEY = 'sr_pfhist_v1';
var PF_HIST5_KEY = 'sr_pfhist5_v1';
var PF_BENCH_KEY = 'sr_pfbench_v1';
var pfBenchBusy = false;
function pfHistAll() { return lsGet(PF_HIST_KEY, {}); }
function pfHist5All() { return lsGet(PF_HIST5_KEY, {}); }
/* Long comparison periods (5Y/10Y/15Y) share the weekly history cache;
 * returns the span in years, or 0 for the daily short periods. */
function pfLongYears(period) { return period === '5Y' ? 5 : period === '10Y' ? 10 : period === '15Y' ? 15 : 0; }
function pfBenchPeriod() { return lsGet(PF_BENCH_KEY, '1Y'); }
function pfDkey(dt) { return dt.getFullYear() * 10000 + (dt.getMonth() + 1) * 100 + dt.getDate(); }

async function fetchPfHist(T, range, interval) {
  var ch = await relayJSON('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(T) + '?range=' + (range || '1y') + '&interval=' + (interval || '1d'));
  var res = ch && ch.chart && ch.chart.result && ch.chart.result[0];
  if (!res || !res.timestamp) throw new Error('no history');
  var closes = (res.indicators && res.indicators.quote && res.indicators.quote[0].close) || [];
  var pts = [];
  res.timestamp.forEach(function (ts, i) {
    if (isNum(closes[i])) pts.push([pfDkey(new Date(ts * 1000)), Math.round(closes[i] * 100) / 100]);
  });
  if (pts.length < 10) throw new Error('thin history');
  return { ts: Date.now(), pts: pts };
}

function paintBench(box, hist, positions) {
  var spy = hist['SPY'];
  if (!spy || !spy.pts || spy.pts.length < 10) { box.innerHTML = ''; return; }
  var period = pfBenchPeriod();
  var days = period === '1M' ? 31 : period === '3M' ? 93 : period === '6M' ? 186 : period === '5Y' ? 1827 : period === '10Y' ? 3652 : period === '15Y' ? 5478 : 370;
  var endKey = spy.pts[spy.pts.length - 1][0];
  var endDt = new Date(Math.floor(endKey / 10000), Math.floor(endKey / 100) % 100 - 1, endKey % 100);
  var cutDt = new Date(endDt); cutDt.setDate(cutDt.getDate() - days);
  var cut = pfDkey(cutDt);
  var win = spy.pts.filter(function (p) { return p[0] >= cut; });
  if (win.length < 2) win = spy.pts.slice(-2);

  // Forward-fill price lookup over a [[dateKey, close], ...] series.
  function priceFn(pts) {
    var i = 0, last = null;
    return function (d) {
      if (!pts) return null;
      while (i < pts.length && pts[i][0] <= d) { last = pts[i][1]; i++; }
      return last;
    };
  }
  function priceAt(pts, d) {
    if (!pts) return null;
    var last = null;
    for (var i = 0; i < pts.length && pts[i][0] <= d; i++) last = pts[i][1];
    return last != null ? last : (pts.length ? pts[0][1] : null);
  }

  // Build purchase lots: the user's manual entries where they exist,
  // otherwise one estimated lot (all shares at the date the price last
  // matched the average cost). No lots at all -> constant-shares mode.
  var lots = [], sellEvents = [], excluded = 0, estUsed = 0, manualUsed = 0;
  var w0 = win[0][0];
  positions.forEach(function (p) {
    var hh = hist[p.ticker];
    var gross = p.shares + pfSoldShares(p);
    if (hh && p.sells) p.sells.forEach(function (s) { var sd = pfDkey(new Date(s.d + 'T12:00:00')); sellEvents.push({ d: sd, t: p.ticker, sh: s.sh, px: isNum(s.px) ? s.px : priceAt(hh.pts, sd) }); });
    if (p.buys && p.buys.length) {
      if (!hh) { excluded++; return; }
      var room = gross, firstD = null;
      p.buys.slice().sort(function (x, y) { return x.d < y.d ? -1 : 1; }).forEach(function (b) {
        if (room <= 0) return;
        var take = Math.min(b.sh, room);
        var bd = pfDkey(new Date(b.d + 'T12:00:00'));
        if (firstD === null) firstD = bd;
        var bp = priceAt(hh.pts, bd);
        lots.push({ d: bd, t: p.ticker, sh: take, amt: isNum(b.px) ? take * b.px : (isNum(bp) ? take * bp : (isNum(p.cost) ? take * p.cost : 0)), pre: bd < w0 });
        room -= take;
      });
      manualUsed++;
      if (room > 0) {
        var ek2 = pfEstKeyFor(p, hh);
        if (ek2) { var ep2 = priceAt(hh.pts, ek2); lots.push({ d: ek2, t: p.ticker, sh: room, amt: isNum(p.cost) ? room * p.cost : (isNum(ep2) ? room * ep2 : 0), pre: ek2 < w0 }); estUsed++; }
        else if (firstD !== null) { var fp = priceAt(hh.pts, firstD); lots.push({ d: firstD, t: p.ticker, sh: room, amt: isNum(fp) ? room * fp : 0, pre: firstD < w0 }); }
      }
    } else if (hh && (isNum(p.cost) || p.estOverride)) {
      var ek = pfEstKeyFor(p, hh);
      if (ek) { var ep = priceAt(hh.pts, ek); lots.push({ d: ek, t: p.ticker, sh: gross, amt: isNum(p.cost) ? gross * p.cost : (isNum(ep) ? gross * ep : 0), pre: ek < w0 }); estUsed++; }
      else excluded++;
    } else excluded++;
  });
  lots.sort(function (a, b) { return a.d - b.d; });

  var pfSeries = [], spySeries = [];
  if (lots.length) {
    // Fund-style (time-weighted) math: money enters the comparison on
    // the day it was spent, and a deposit never counts as a gain. The
    // line is a NAV that moves only with market performance; purchases
    // add holdings at cost without moving the NAV. The S&P line runs
    // the same span, so its NAV is the index's own price performance
    // while his money was invested.
    var owned = {};
    positions.forEach(function (p) { owned[p.ticker] = 0; });
    // One event stream (buys and sells in date order; sells first on a
    // tie). Sale proceeds become a cash balance inside the line and
    // fund later buys before any new money counts as injected.
    var evs = lots.map(function (l) { return { d: l.d, buy: true, lot: l }; })
      .concat(sellEvents.map(function (s) { return { d: s.d, buy: false, ev: s }; }))
      .sort(function (a, b) { return a.d - b.d || (a.buy === b.buy ? 0 : a.buy ? 1 : -1); });
    var cash = 0;
    function applyBuy(lot, fund) {
      if (fund) { var sp = Math.min(cash, lot.amt); cash -= sp; }
      owned[lot.t] += lot.sh;
    }
    function applySell(ev) {
      var take = Math.min(ev.sh, owned[ev.t] || 0);
      owned[ev.t] -= take;
      if (isNum(ev.px)) cash += take * ev.px;
    }
    var ei = 0;
    while (ei < evs.length && evs[ei].d < w0) { if (evs[ei].buy) applyBuy(evs[ei].lot, true); else applySell(evs[ei].ev); ei++; }
    var nav = 100, vPost = null, started = false;
    win.forEach(function (sp) {
      var d = sp[0];
      var V = cash;
      positions.forEach(function (p) {
        if (owned[p.ticker] > 0) { var px = priceAt(hist[p.ticker] ? hist[p.ticker].pts : null, d); if (isNum(px)) V += owned[p.ticker] * px; }
      });
      if (vPost != null && vPost > 0 && V > 0) nav *= V / vPost;
      var extFlow = 0;
      while (ei < evs.length && evs[ei].d <= d) {
        if (evs[ei].buy) { var before = cash; applyBuy(evs[ei].lot, true); extFlow += evs[ei].lot.amt - (before - cash); }
        else applySell(evs[ei].ev);
        ei++;
      }
      vPost = cash;
      positions.forEach(function (p) {
        if (owned[p.ticker] > 0) { var px2 = priceAt(hist[p.ticker] ? hist[p.ticker].pts : null, d); if (isNum(px2)) vPost += owned[p.ticker] * px2; }
      });
      if (!started && (V > 0 || vPost > 0)) started = true;
      pfSeries.push(started ? nav : null);
      spySeries.push(sp[1]);
    });
  } else {
    var series = positions.map(function (p) {
      var hh2 = hist[p.ticker];
      return { shares: p.shares, pts: hh2 ? hh2.pts : null, i: 0, last: null };
    });
    excluded = series.filter(function (s) { return !s.pts; }).length;
    win.forEach(function (sp) {
      var tot = 0, any = false;
      series.forEach(function (s) {
        if (!s.pts) return;
        while (s.i < s.pts.length && s.pts[s.i][0] <= sp[0]) { s.last = s.pts[s.i][1]; s.i++; }
        if (isNum(s.last)) { tot += s.shares * s.last; any = true; }
      });
      pfSeries.push(any ? tot : null);
      spySeries.push(sp[1]);
    });
  }
  var k0 = -1;
  for (var kk = 0; kk < win.length; kk++) { if (isNum(pfSeries[kk]) && isNum(spySeries[kk])) { k0 = kk; break; } }
  if (k0 < 0 || win.length - k0 < 2) { box.innerHTML = ''; return; }
  var pfIdx = [], spyIdx = [];
  for (var k = k0; k < win.length; k++) {
    pfIdx.push(pfSeries[k] / pfSeries[k0] * 100);
    spyIdx.push(spySeries[k] / spySeries[k0] * 100);
  }
  var pfLine = [], spyLine = [];
  for (var k2 = 0; k2 < win.length; k2++) {
    pfLine.push(k2 >= k0 && isNum(pfSeries[k2]) ? pfSeries[k2] / pfSeries[k0] * 100 : null);
    spyLine.push(k2 >= k0 && isNum(spySeries[k2]) ? spySeries[k2] / spySeries[k0] * 100 : null);
  }
  var pfRet = pfIdx[pfIdx.length - 1] - 100, spyRet = spyIdx[spyIdx.length - 1] - 100;
  var gap = pfRet - spyRet;
  var all = pfIdx.concat(spyIdx);
  var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all), pad = (hi - lo) * 0.08 + 0.5;
  lo -= pad; hi += pad;
  function X(i) { return (6 + i / (pfIdx.length - 1) * 328).toFixed(1); }
  function Y(v) { return (164 - (v - lo) / (hi - lo) * 158).toFixed(1); }
  function line(arr) { return arr.map(function (v, i) { return isNum(v) ? X(i) + ',' + Y(v) : null; }).filter(Boolean).join(' '); }
  // X-axis ticks: day numbers on the 1M view, months for the
  // sub-year ranges, years only on the 5Y view.
  var MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var tickIdx = [0, 0.25, 0.5, 0.75, 1].map(function (f) { return Math.round(f * (win.length - 1)); }).filter(function (v, i, a) { return a.indexOf(v) === i; });
  var prevYr = null;
  var ticksSvg = tickIdx.map(function (ti, ord) {
    var key = win[ti][0];
    var yr = Math.floor(key / 10000), mo = Math.floor(key / 100) % 100, dy = key % 100;
    var lab;
    if (pfLongYears(period)) lab = String(yr);
    else if (period === '1M') lab = MONS[mo - 1] + ' ' + dy;
    else { lab = MONS[mo - 1] + (prevYr === null || yr !== prevYr ? " '" + String(yr).slice(2) : ''); prevYr = yr; }
    var anchor = ord === 0 ? 'start' : ord === tickIdx.length - 1 ? 'end' : 'middle';
    var tx = ord === 0 ? 6 : ord === tickIdx.length - 1 ? 334 : X(ti - k0);
    return '<text x="' + tx + '" y="179" font-size="8.5" style="fill:var(--muted)" text-anchor="' + anchor + '">' + lab + '</text>';
  }).join('');
  var chips = ['1M', '3M', '6M', '1Y', '5Y', '10Y', '15Y'].map(function (p) {
    return '<button type="button" data-bench="' + p + '"' + (p === period ? ' class="active"' : '') + '>' + p + '</button>';
  }).join('');
  var modeNote = lots.length
    ? 'Fund-style math: money joins the comparison on the day you spent it, and a deposit never counts as a gain -- the percentages are pure performance of your money while it was invested, and sale proceeds sit as cash in your line until you re-spend them. The S&amp;P line is the index over the same span.' +
      (manualUsed ? ' ' + manualUsed + ' holding(s) use your entered purchase dates.' : '') +
      (estUsed ? ' ' + estUsed + ' use a date estimated from your average cost (the last day the price matched it).' : '') +
      ' Price return only, dividends not included.'
    : 'Both lines start at 100. Your line is rebuilt from the share counts you entered, held constant over the period -- add purchase dates (or an average cost) on a holding to date it properly. Price return only, dividends not included. S&amp;P 500 tracked via SPY.';
  box.innerHTML = '<div class="card">' +
    '<div class="pf-bench-head"><span class="pf-bench-title">Portfolio vs S&amp;P 500</span>' +
    '<span class="pf-bench-legend"><span><span class="pf-bench-dot" style="background:#F8C73D"></span>You</span><span><span class="pf-bench-dot" style="background:#61A5C2"></span>S&amp;P 500</span></span></div>' +
    '<div class="seg pf-bench-seg" role="group" aria-label="Benchmark period">' + chips + '</div>' +
    '<div id="pf-bench-read" class="pf-bench-read">Drag across the chart to see any day.</div>' +
    '<svg class="pf-bench-chart" viewBox="0 0 340 186" role="img" aria-label="Portfolio versus S&P 500 chart">' +
    '<polyline points="' + line(spyLine) + '" fill="none" stroke="#61A5C2" stroke-width="2" stroke-linejoin="round"/>' +
    '<polyline points="' + line(pfLine) + '" fill="none" stroke="#F8C73D" stroke-width="2.5" stroke-linejoin="round"/>' +
    '<circle cx="' + X(win.length - 1) + '" cy="' + Y(pfIdx[pfIdx.length - 1]) + '" r="3.2" fill="#F8C73D"/>' +
    '<circle cx="' + X(win.length - 1) + '" cy="' + Y(spyIdx[spyIdx.length - 1]) + '" r="3" fill="#61A5C2"/>' + ticksSvg +
    '<g id="pf-scrub" style="display:none"><line id="pf-scrub-line" y1="4" y2="166" stroke-width="1" stroke-dasharray="3 3" style="stroke:var(--muted)"/>' +
    '<circle id="pf-scrub-pf" r="4.2" fill="#F8C73D" stroke="#0d0d0f" stroke-width="1.5"/>' +
    '<circle id="pf-scrub-spy" r="3.8" fill="#61A5C2" stroke="#0d0d0f" stroke-width="1.5"/></g>' +
    '<rect id="pf-scrub-zone" x="0" y="0" width="340" height="172" fill="transparent" style="touch-action:none"/></svg>' +
    '<div class="pf-bench-stats"><span>You <b class="' + (pfRet >= 0 ? 'up' : 'down') + '">' + fmtPct(pfRet) + '</b></span>' +
    '<span>S&amp;P 500 <b class="' + (spyRet >= 0 ? 'up' : 'down') + '">' + fmtPct(spyRet) + '</b></span>' +
    '<span>' + (gap >= 0 ? 'Ahead by' : 'Behind by') + ' <b class="' + (gap >= 0 ? 'up' : 'down') + '">' + fmtNum(Math.abs(gap), 1) + ' pts</b></span></div>' +
    '<p class="fineprint" style="margin:8px 0 0">' + modeNote +
    (excluded ? ' ' + excluded + ' holding(s) left out (no purchase dates or average cost to date them).' : '') + '</p></div>';
  box.querySelectorAll('[data-bench]').forEach(function (b) {
    b.addEventListener('click', function () {
      lsSet(PF_BENCH_KEY, b.getAttribute('data-bench'));
      renderBench(false);
    });
  });
  var svgEl = box.querySelector('.pf-bench-chart');
  var zone = box.querySelector('#pf-scrub-zone');
  var grp = box.querySelector('#pf-scrub');
  var read = box.querySelector('#pf-bench-read');
  if (svgEl && zone && grp && read) {
    var sLn = box.querySelector('#pf-scrub-line');
    var cPf = box.querySelector('#pf-scrub-pf');
    var cSpy = box.querySelector('#pf-scrub-spy');
    var scrubbing = false;
    function scrubTo(clientX) {
      var rect = svgEl.getBoundingClientRect();
      if (!rect.width) return;
      var sx = (clientX - rect.left) / rect.width * 340;
      var i = Math.round((sx - 6) / 328 * (pfIdx.length - 1));
      i = Math.max(k0, Math.min(win.length - 1, i));
      while (i > k0 && !isNum(pfLine[i])) i--;
      if (!isNum(pfLine[i]) || !isNum(spyLine[i])) return;
      var x = X(i);
      grp.style.display = '';
      sLn.setAttribute('x1', x); sLn.setAttribute('x2', x);
      cPf.setAttribute('cx', x); cPf.setAttribute('cy', Y(pfLine[i]));
      cSpy.setAttribute('cx', x); cSpy.setAttribute('cy', Y(spyLine[i]));
      var key = win[i][0];
      var yr = Math.floor(key / 10000), mo = Math.floor(key / 100) % 100, dy = key % 100;
      var pv = pfLine[i] - 100, sv2 = spyLine[i] - 100;
      read.innerHTML = '<b class="pf-read-date">' + MONS[mo - 1] + ' ' + dy + ', ' + yr + '</b> \u00b7 You <b class="' + (pv >= 0 ? 'up' : 'down') + '">' + fmtPct(pv) + '</b> \u00b7 S&amp;P <b class="' + (sv2 >= 0 ? 'up' : 'down') + '">' + fmtPct(sv2) + '</b> \u00b7 ' + (pv - sv2 >= 0 ? 'Ahead' : 'Behind') + ' <b class="' + (pv - sv2 >= 0 ? 'up' : 'down') + '">' + fmtNum(Math.abs(pv - sv2), 1) + ' pts</b>';
    }
    zone.addEventListener('pointerdown', function (e) { scrubbing = true; try { zone.setPointerCapture(e.pointerId); } catch (err) {} scrubTo(e.clientX); e.preventDefault(); });
    zone.addEventListener('pointermove', function (e) { if (scrubbing) scrubTo(e.clientX); });
    zone.addEventListener('pointerup', function () { scrubbing = false; });
    zone.addEventListener('pointercancel', function () { scrubbing = false; });
  }
}

async function renderBench(force) {
  var box = $('pf-bench');
  if (!box) return;
  var positions = getPortfolio();
  if (!positions.length) { box.innerHTML = ''; return; }
  var period = pfBenchPeriod();
  var needYears = pfLongYears(period);
  var five = needYears > 0;
  var cacheKey = five ? PF_HIST5_KEY : PF_HIST_KEY;
  var hist = five ? pfHist5All() : pfHistAll();
  paintBench(box, hist, positions);
  var need = ['SPY'].concat(positions.map(function (p) { return p.ticker; }));
  var stale = need.some(function (t) { var hh = hist[t]; return !hh || (Date.now() - hh.ts > 12 * 3600 * 1000); });
  if (five) {
    var haveMeta = lsGet('sr_pfhist5_range', '');
    var haveYears = haveMeta === '15y' ? 15 : haveMeta === '5y' ? 5 : 0;
    if (haveYears < needYears) stale = true;
  }
  if ((force || stale) && !pfBenchBusy) {
    pfBenchBusy = true;
    if (!hist['SPY']) box.innerHTML = '<div class="card"><span class="spinner"></span>Loading the S&P 500 comparison\u2026</div>';
    var updated = {};
    Object.keys(hist).forEach(function (k) { updated[k] = hist[k]; });
    var fetchRange = five ? (Math.max(needYears, haveYears) <= 5 ? '5y' : '15y') : '1y';
    await Promise.all(need.map(async function (t) {
      try { updated[t] = await fetchPfHist(t, fetchRange, five ? '1wk' : '1d'); } catch (e) {}
    }));
    lsSet(cacheKey, updated);
    if (five) lsSet('sr_pfhist5_range', fetchRange);
    pfBenchBusy = false;
    if (pfLongYears(pfBenchPeriod()) > 0 === five) paintBench(box, five ? pfHist5All() : pfHistAll(), getPortfolio());
  }
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
    box.innerHTML = '<div class="empty-note"><h2>No journal entries yet</h2><p>Write down your thesis before you buy — future you will want to know what past you was thinking.</p>' +
      '<div class="ex-row"><button type="button" class="btn-gold" data-j-start="1">Write your first entry</button></div></div>';
    var jb = box.querySelector('[data-j-start]');
    if (jb) jb.addEventListener('click', function () {
      var card = $('journal-editor-card'), ti = $('j-ticker');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (ti) { try { ti.focus({ preventScroll: true }); } catch (e) { ti.focus(); } }
    });
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
  ['P/E ratio', 'The price of one share of stock divided by the earnings per one share of stock (EPS). What you pay for $1 of yearly profit. 20× means $20 per $1 of earnings.'],
  ['Forward P/E', 'The price of one share of stock divided by next year\'s expected earnings per one share of stock (EPS). Uses analyst estimates, so it\'s a guess about the future — cheaper-looking, but the estimate can be wrong.'],
  ['PEG ratio', 'P/E divided by the expected earnings growth rate. Tries to answer "am I overpaying for this growth?" Under 1 is traditionally "fair", under 0.75 is unusually cheap — or a warning that growth is about to fall off a cliff.'],
  ['Market cap', 'Share price × shares outstanding. The total price tag on the whole company. Your screen only looks at companies over $5B (large enough to be established).'],
  ['52-week high', 'The highest price in the last year. A stock 30% below it is on sale relative to recent sentiment — or something broke. Your screen wants 25%+ below, then the research decides which.'],
  ['EPS (earnings per share)', 'Company profits divided by all outstanding shares — how much of the profit belongs to each one share of stock. The single number most valuation math is built on. "TTM" = trailing twelve months (actual past). "Consensus" = the average of analyst estimates (guessed future).'],
  ['Outstanding shares', 'All the shares of the company that exist and are held by investors — the total number of pieces the company is split into. It is the divisor inside EPS (profits ÷ outstanding shares) and market cap (share price × outstanding shares). When the count rises, each share owns a smaller slice (see Dilution); when it falls, each share owns a bigger slice (see Buyback).'],
  ['Earnings cliff', 'When a cyclical company\'s earnings peak, then fall hard — memory chips, miners, commodities. The stock looks cheapest (lowest P/E) exactly at the peak, right before earnings collapse. The most common value trap there is.'],
  ['Gross margin', 'Revenue minus the direct cost of what was sold, as a % of revenue. High gross margin usually means pricing power — customers can\'t easily go elsewhere.'],
  ['Operating margin', 'Profit from the core business (after running costs, before interest and tax) as a % of revenue. Shows whether the business itself makes money.'],
  ['Profit margin', 'Final net profit as a % of revenue. What\'s left for shareholders after everything.'],
  ['Debt / Equity', 'Total debt divided by shareholder equity. Above ~2 means the company leans heavily on borrowed money — fine in good times, dangerous in bad ones.'],
  ['ROE (return on equity)', 'Profit divided by shareholder equity. How hard the owners\' money is working. Consistently above 15% is strong.'],
  ['Balance sheet', 'The snapshot of what a company owns and owes at one moment in time: assets on one side, liabilities and shareholder equity on the other — and the two sides always balance (assets = liabilities + equity). Unlike an earnings report, which covers a whole quarter or year, the balance sheet is a photograph, not a movie. It answers one question: how sturdy is this company right now?'],
  ['Assets', 'Everything a company owns that has value: cash, inventory, buildings, equipment, patents, and money customers owe it. One side of the balance sheet. The accounting equation ties it together: assets = liabilities + shareholder equity — everything a company owns is claimed by either its lenders or its owners.'],
  ['Liabilities', 'Everything a company owes: loans, bonds, unpaid bills, wages and taxes due. The other side of the balance sheet, across from assets. Paying liabilities down strengthens a company; piling them up is how the debt/equity ratio gets ugly.'],
  ['Shareholder equity', 'What would be left for the owners if the company sold everything it owns and paid off every debt: total assets minus total liabilities. Also called book value. It is the yardstick inside ROE and Debt/Equity — and it is an accounting number, not what the market will pay: market cap is the market\'s (usually much bigger) price tag on that same equity.'],
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
  ['Bear / Base / Bull case', 'Three versions of the same forecast: pessimistic, most likely, optimistic. In the Projection Builder they are your EPS path with growth shifted down 5 points, as-is, and up 5 points, with the exit P/E shifted down 20%, as-is, and up 20%.'],
  ['Implied price', 'The future price a projection works out to: future EPS × exit P/E. It is an "if these assumptions hold" number, not a prediction.'],
  ['Enterprise value', 'Market cap plus total debt minus cash. The cost of buying the whole business outright, debts and all. Better than market cap for comparing companies with very different borrowing.'],
  ['Buyback', 'When a company repurchases its own shares. Fewer shares means each remaining share owns a bigger slice of the profit, so EPS rises even if total profit doesn\'t.'],
  ['Dilution', 'The opposite of a buyback: the company issues more shares (often to pay employees in stock), so each share owns a smaller slice. Profit can grow while EPS shrinks.'],
  ['Drawdown', 'The fall from a peak. A stock 43.6% below its 52-week high is in a 43.6% drawdown from that high — deep enough to be opportunity or warning, which is what the research is for.']
];
/* Tiny line diagrams for the glossary (Justin's ask, 2026-10-29):
 * one simple visual per term, drawn in the app's two tones. */
var GLOSS_ART = {
'P/E ratio': '<rect x="14" y="8" width="118" height="27" class="ga"/><text x="73" y="26" class="gt" text-anchor="middle">PRICE $150</text><path d="M14 42h118"/><rect x="14" y="49" width="118" height="27"/><text x="73" y="67" class="gt" text-anchor="middle">EPS $5</text><text x="146" y="50" class="gt" font-size="15">=</text><text x="168" y="47" class="gtf" font-size="23">30\u00d7</text><text x="168" y="67" class="gt">PER $1 OF PROFIT</text>',
'Forward P/E': '<rect x="14" y="8" width="118" height="27" class="ga"/><text x="73" y="26" class="gt" text-anchor="middle">PRICE $150</text><path d="M14 42h118"/><rect x="14" y="49" width="118" height="27"/><text x="73" y="67" class="gt" text-anchor="middle">EPS $5</text><text x="146" y="50" class="gt" font-size="15">=</text><text x="168" y="47" class="gtf" font-size="23">30\u00d7</text><text x="168" y="67" class="gt">PER $1 OF PROFIT</text>',
'PEG ratio': '<path d="M150 14v42"/><path d="M98 56h104"/><path d="M150 14 106 28M150 14l44 14"/><path d="M90 28h32l-6 13H96Z"/><path d="M178 28h32l-6 13h-20Z"/><text x="94" y="20" class="gt">P/E</text><text x="172" y="20" class="gt">GROWTH</text><path d="M128 72h44"/>',
'Market cap': '<rect x="38" y="48" width="34" height="26"/><rect x="94" y="34" width="40" height="40" class="ga"/><rect x="156" y="16" width="48" height="58"/><path d="M22 74h256"/><text x="172" y="52" class="gtf">$</text><text x="222" y="40" class="gt">WHOLE COMPANY</text><text x="222" y="56" class="gt">VALUE</text>',
'52-week high': '<path d="M18 58h264"/><circle cx="52" cy="58" r="4" class="gaf"/><text x="32" y="76" class="gt">LOW</text><path d="M262 58V24"/><path d="M262 24l17 5-17 5" class="ga"/><text x="240" y="76" class="gt">HIGH</text><circle cx="166" cy="58" r="5" class="ga"/><text x="140" y="42" class="gt">PRICE NOW</text>',
'EPS (earnings per share)': '<circle cx="112" cy="42" r="30"/><path d="M112 42V12M112 42l26 17M112 42l-26 17"/><circle cx="212" cy="42" r="17" class="ga"/><text x="212" y="47" class="gtf" text-anchor="middle">$</text><text x="212" y="76" class="gt" text-anchor="middle">PER SHARE</text>',
'Outstanding shares': '<rect x="20" y="16" width="13" height="13"/><rect x="41" y="16" width="13" height="13" class="ga"/><rect x="62" y="16" width="13" height="13"/><rect x="20" y="35" width="13" height="13" class="ga"/><rect x="41" y="35" width="13" height="13"/><rect x="62" y="35" width="13" height="13" class="ga"/><rect x="20" y="54" width="13" height="13"/><rect x="41" y="54" width="13" height="13" class="ga"/><rect x="62" y="54" width="13" height="13"/><text x="96" y="38" class="gt">ALL THE SHARES</text><text x="96" y="56" class="gt">THAT EXIST</text>',
'Earnings cliff': '<path d="M16 66h50V50h50V32h50V16h36"/><path d="M202 16v42" class="ga"/><path d="M195 50l7 9 7-9" class="ga"/><path d="M218 66h64" stroke-dasharray="4 5"/><text x="222" y="50" class="gt">THE DROP</text>',
'Gross margin': '<rect x="18" y="30" width="264" height="22"/><rect x="18" y="30" width="158" height="22" class="gab"/><text x="18" y="20" class="gt">$1 OF SALES</text><text x="52" y="70" class="gt">KEPT 60%</text><text x="206" y="70" class="gt">COSTS</text>',
'Operating margin': '<rect x="18" y="30" width="264" height="22"/><rect x="18" y="30" width="79" height="22" class="gab"/><path d="M150 30v22M224 30v22"/><text x="18" y="20" class="gt">$1 OF SALES</text><text x="30" y="70" class="gt">KEPT 30%</text><text x="140" y="70" class="gt">RUNNING COSTS</text>',
'Profit margin': '<rect x="18" y="30" width="264" height="22"/><rect x="18" y="30" width="27" height="22" class="gab"/><text x="18" y="20" class="gt">$1 OF SALES</text><text x="18" y="70" class="gtf">KEPT 10%</text><text x="150" y="70" class="gt">EVERYTHING IT COSTS TO EARN IT</text>',
'Debt / Equity': '<path d="M148 10v16"/><path d="M64 34 148 26l84 6"/><path d="M64 34l-13 19h26Z" class="ga"/><path d="M232 32l-13 19h26Z"/><path d="M124 76h48"/><text x="36" y="70" class="gtf">DEBT</text><text x="206" y="70" class="gt">EQUITY</text>',
'ROE (return on equity)': '<circle cx="50" cy="42" r="18"/><text x="50" y="47" class="gtf" text-anchor="middle">$1</text><path d="M80 42h52" class="ga"/><path d="M124 34l10 8-10 8" class="ga"/><circle cx="182" cy="42" r="18" class="ga"/><text x="182" y="47" class="gtf" text-anchor="middle">$</text><text x="214" y="47" class="gtf">+15% A YEAR</text>',
'Balance sheet': '<rect x="82" y="10" width="132" height="64"/><path d="M148 10v64M82 26h132"/><text x="94" y="54" class="gt">OWNS</text><text x="158" y="48" class="gt">OWES</text><text x="158" y="64" class="gt">+ OWNERS</text>',
'Assets': '<path d="M38 74V36l24-15 24 15v38"/><path d="M30 74h64"/><circle cx="148" cy="46" r="20" class="ga"/><text x="148" y="51" class="gtf" text-anchor="middle">$</text><rect x="204" y="30" width="54" height="44"/><path d="M204 45h54M204 59h54"/><text x="38" y="14" class="gt">THINGS OF VALUE IT OWNS</text>',
'Liabilities': '<path d="M92 12h84v58l-8.4-6-8.4 6-8.4-6-8.4 6-8.4-6-8.4 6L117 70l-8.4-6-8.4 6-8.2-6Z"/><path d="M108 30h52M108 44h52"/><text x="192" y="40" class="gt">BILLS AND</text><text x="192" y="56" class="gt">DEBTS OWED</text>',
'Shareholder equity': '<circle cx="106" cy="42" r="30"/><path d="M106 42V12a30 30 0 0 1 26 15Z" class="gab"/><path d="M106 42V12M106 42l26 15"/><text x="160" y="38" class="gt">LEFT OVER</text><text x="160" y="54" class="gt">FOR THE OWNERS</text>',
'Free cash flow': '<path d="M44 14h46v11H64v9"/><path d="M55 34h19"/><path d="M64 45c5 7 5 10 0 14-5-4-5-7 0-14Z" class="ga"/><path d="M158 42h66l-7 32h-52Z"/><path d="M150 42h82"/><text x="196" y="30" class="gt" text-anchor="middle">CASH LEFT OVER</text>',
'Beta': '<path d="M14 56 88 48 162 52 236 42 286 46"/><path d="M14 64 60 28 106 68 152 20 198 64 244 26 286 54" class="ga"/><text x="14" y="14" class="gt">MARKET</text><text x="196" y="14" class="gtf">STOCK, BETA 2</text>',
'Moat': '<path d="M116 72V38h10V27h12v11h24V27h12v11h10v34"/><path d="M138 72V56a12 12 0 0 1 24 0v16"/><ellipse cx="150" cy="76" rx="88" ry="6" class="ga"/><text x="196" y="34" class="gt">HARD TO</text><text x="196" y="49" class="gt">ATTACK</text>',
'CAGR': '<path d="M18 70C90 66 150 40 282 13" class="ga"/><path d="M18 70 282 13" stroke-dasharray="4 5"/><circle cx="18" cy="70" r="3.5" class="gaf"/><circle cx="150" cy="46" r="3.5" class="gaf"/><circle cx="282" cy="13" r="3.5" class="gaf"/><text x="282" y="76" class="gt" text-anchor="end">SAME % EVERY YEAR, ON AVERAGE</text>',
'Dividend yield': '<rect x="28" y="10" width="60" height="60" class="gab"/><rect x="28" y="10" width="60" height="60" class="ga"/><rect x="76" y="58" width="10" height="10" class="gaf"/><path d="M90 63h21M105 57l6 6-6 6" class="ga"/><rect x="115" y="55" width="16" height="16" class="ga"/><rect x="118" y="58" width="10" height="10" class="gaf"/><text x="58" y="82" text-anchor="middle" class="gt">YOUR MONEY</text><text x="146" y="30" class="gt">CASH PAID TO YOU</text><text x="146" y="48" class="gt">EVERY YEAR</text><text x="146" y="66" class="gtf">YIELD 3%</text>',
'Analyst target': '<circle cx="126" cy="42" r="30"/><circle cx="126" cy="42" r="18" class="ga"/><circle cx="126" cy="42" r="5" class="gaf"/><path d="M218 68 144 49" class="ga"/><path d="M206 68h13M209 56l3 12" class="ga"/><text x="188" y="22" class="gt">WHERE ANALYSTS AIM</text>',
'TTM (trailing twelve months)': '<path d="M28 28h224v24H28Z"/><path d="M47 28v24M65 28v24M84 28v24M102 28v24M121 28v24M140 28v24M158 28v24M177 28v24M196 28v24M214 28v24M233 28v24"/><path d="M28 64h224" class="ga"/><text x="140" y="79" class="gt" text-anchor="middle">THE LAST 12 MONTHS</text>',
'YoY (year over year)': '<path d="M22 74h256"/><rect x="82" y="36" width="36" height="38"/><rect x="178" y="18" width="36" height="56" class="ga"/><text x="64" y="26" class="gt">LAST YEAR</text><text x="164" y="10" class="gt">THIS YEAR</text><path d="M130 46 166 28" class="ga"/><path d="M154 26h13v13" class="ga"/>',
'Consensus estimate': '<circle cx="92" cy="28" r="3" class="gaf"/><circle cx="126" cy="46" r="3" class="gaf"/><circle cx="158" cy="24" r="3" class="gaf"/><circle cx="190" cy="42" r="3" class="gaf"/><circle cx="224" cy="30" r="3" class="gaf"/><path d="M84 60 232 34" stroke-dasharray="4 5"/><text x="150" y="78" class="gt" text-anchor="middle">MANY ANALYSTS, ONE AVERAGE</text>',
'Earnings surprise': '<path d="M28 54h176" stroke-dasharray="5 4"/><text x="28" y="42" class="gt">EXPECTED <tspan class="gtf">100</tspan></text><circle cx="240" cy="24" r="6" class="gaf"/><path d="M240 34v16" class="ga"/><text x="254" y="29" class="gtf">110</text><text x="222" y="66" class="gtf">BEAT!</text>',
'Adjusted (non-GAAP) EPS': '<rect x="28" y="16" width="182" height="16"/><rect x="162" y="16" width="48" height="16"/><path d="M168 38l36-16M168 22l36 16" class="ga"/><rect x="28" y="52" width="132" height="16" class="ga"/><text x="222" y="28" class="gt">ONE-OFF</text><text x="222" y="64" class="gt">REMOVED</text>',
'Guidance': '<path d="M104 76V14"/><path d="M104 20h86l11 10-11 10h-86" class="ga"/><text x="150" y="62" class="gt" text-anchor="middle">ITS OWN FORECAST FOR WHAT IS NEXT</text>',
'Fiscal year': '<rect x="86" y="12" width="118" height="60"/><path d="M86 27h118M115 12v60M145 12v60M174 12v60M86 42h118M86 57h118"/><circle cx="159" cy="49" r="10" class="ga"/><text x="216" y="40" class="gt">STARTS HERE,</text><text x="216" y="56" class="gt">NOT ALWAYS JAN</text>',
'Cyclical': '<path d="M12 42c22-30 38-30 60 0s38 30 60 0 38-30 60 0 38 30 60 0" class="ga"/><text x="16" y="11" class="gt">BOOM</text><text x="80" y="80" class="gt">BUST</text><text x="152" y="11" class="gt">BOOM</text><text x="228" y="80" class="gt">BUST</text>',
'Value trap': '<path d="M50 16h46l30 30-34 34-30-30V16Z"/><circle cx="64" cy="30" r="4"/><text x="76" y="64" class="gt">CHEAP!</text><path d="M192 16v42" class="ga"/><path d="M182 48l10 12 10-12" class="ga"/><text x="210" y="40" class="gt">STILL</text><text x="210" y="56" class="gt">FALLING</text>',
'Margin of safety': '<path d="M18 24h264"/><text x="18" y="15" class="gt">REAL VALUE</text><path d="M18 62h264" class="ga"/><text x="18" y="79" class="gtf">PRICE YOU PAY</text><path d="M252 29v27M245 37l7-8 7 8M245 48l7 8 7-8" class="ga"/><text x="120" y="48" class="gt">THE CUSHION</text>',
'SWOT analysis': '<rect x="84" y="8" width="132" height="68"/><path d="M150 8v68M84 42h132"/><text x="117" y="31" class="gtf" text-anchor="middle">S</text><text x="183" y="31" class="gt" text-anchor="middle">W</text><text x="117" y="65" class="gt" text-anchor="middle">O</text><text x="183" y="65" class="gtf" text-anchor="middle">T</text>',
'Exit P/E (exit multiple)': '<path d="M16 66C80 60 140 40 214 26"/><path d="M228 58V14" class="ga"/><path d="M228 14l27 7-27 7" class="gab"/><text x="196" y="78" class="gt">AT THE EXIT YEAR</text>',
'Bear / Base / Bull case': '<path d="M18 14l46 14 46-2"/><text x="226" y="26" class="gt">BEAR</text><path d="M18 44l46-2 46 2"/><text x="226" y="50" class="gt">BASE</text><path d="M18 72l46-13 46 3" class="ga"/><text x="226" y="76" class="gtf">BULL</text>',
'Implied price': '<path d="M22 62C88 58 158 40 220 26" stroke-dasharray="5 5" class="ga"/><circle cx="22" cy="62" r="4" class="gaf"/><rect x="236" y="12" width="38" height="22" class="ga"/><text x="255" y="28" class="gtf" text-anchor="middle">$?</text><text x="22" y="80" class="gt">TODAY</text><text x="196" y="56" class="gt">IF THE PLAN WORKS</text>',
'Enterprise value': '<path d="M34 74V34l22-13 22 13v40"/><text x="102" y="54" class="gtf">+</text><path d="M126 74V44h34v30M126 59h34"/><text x="186" y="54" class="gtf">-</text><circle cx="222" cy="48" r="15" class="ga"/><text x="222" y="53" class="gtf" text-anchor="middle">$</text><text x="112" y="20" class="gt">DEBT</text><text x="200" y="20" class="gt">CASH</text><text x="252" y="54" class="gt">TOTAL PRICE</text>',
'Buyback': '<circle cx="92" cy="42" r="26"/><path d="M92 42V16M92 42l22 13"/><path d="M206 18a27 27 0 1 1-9 15" class="ga"/><path d="M188 10l9 12 11-7" class="ga"/><text x="196" y="80" class="gt" text-anchor="middle">FEWER SHARES LEFT</text>',
'Dilution': '<g transform="translate(0,-2)"><circle cx="72" cy="42" r="26"/><path d="M72 16v52M46 42h52"/><path d="M112 42h26" class="ga"/><path d="M132 35l8 7-8 7" class="ga"/><circle cx="198" cy="42" r="26" class="ga"/><path d="M198 16v52M172 42h52M180 24l36 36M216 24l-36 36" class="ga"/></g><text x="146" y="80" class="gt" text-anchor="middle">SAME PIE, MORE SLICES</text>',
'Drawdown': '<path d="M14 22 82 13 148 56 214 47 286 26"/><circle cx="82" cy="13" r="4" class="gaf"/><circle cx="148" cy="56" r="4" class="gaf"/><path d="M112 19v30M105 26l7-8 7 8M105 42l7 7 7-7" class="ga"/><text x="126" y="42" class="gtf">-35%</text>'
};


/* Glossary diagrams are fixed 300-unit-wide SVGs whose labels are placed
 * at absolute x positions — a long label placed mid-diagram runs past the
 * right edge and gets clipped by the viewBox (Justin's screenshot,
 * 2026-10-29: Profit margin's "EVERYTHING IT COSTS TO EARN IT" cut off).
 * Root fix: measure every label after render and shrink its font just
 * enough to fit inside the viewBox, honoring its text-anchor. Applies to
 * every diagram, present and future; wording and layout are untouched. */
function fitGlossText() {
  var svgs = document.querySelectorAll('#gloss-list .gloss-art svg');
  for (var i = 0; i < svgs.length; i++) {
    var texts = svgs[i].querySelectorAll('text');
    for (var j = 0; j < texts.length; j++) {
      var el = texts[j];
      try {
        var bb = el.getBBox();
        if (!bb || !bb.width) continue; /* hidden tab: retried on switchTab */
        var anchor = el.getAttribute('text-anchor') || 'start';
        var allowed;
        if (anchor === 'middle') allowed = 2 * Math.min(bb.x + bb.width / 2 - 2, 298 - (bb.x + bb.width / 2));
        else if (anchor === 'end') allowed = bb.x + bb.width - 2;
        else allowed = 298 - bb.x;
        if (allowed < bb.width) {
          var fs = parseFloat(window.getComputedStyle(el).fontSize) || 10.5;
          el.style.fontSize = Math.max(6, fs * (allowed / bb.width) * 0.99) + 'px';
        }
      } catch (e) {}
    }
  }
}

function renderGlossary(filter, exactTerm) {
  var f = (filter || '').toLowerCase();
  var html = '';
  GLOSSARY.forEach(function (g) {
    if (exactTerm) { if (g[0] !== exactTerm) return; }
    else if (f && g[0].toLowerCase().indexOf(f) === -1 && g[1].toLowerCase().indexOf(f) === -1) return;
    html += '<div class="g-item" data-term="' + esc(g[0]) + '"><div class="g-term">' + esc(g[0]) + '</div>' +
      (GLOSS_ART[g[0]] ? '<div class="gloss-art"><svg viewBox="0 0 300 84" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + GLOSS_ART[g[0]] + '</svg></div>' : '') +
      '<div class="g-def">' + glossLinkify(g[1], g[0]) + '</div></div>';
  });
  $('gloss-list').innerHTML = html || '<div class="empty-note"><h2>No matches</h2><p>No glossary term matches that search.</p><div class="ex-row"><button type="button" class="btn-gold" id="gloss-clear">Clear search</button></div></div>';
  var gc = $('gloss-clear');
  if (gc) gc.addEventListener('click', function () {
    var gs = $('gloss-search'); if (gs) gs.value = '';
    renderGlossary('');
  });
  fitGlossText();
}

/* ============================== data backup ============================== */
function collectBackup() {
  return { app: 'stock-research', version: 1, exportedAt: new Date().toISOString(),
           watchlist: getWatchlist(), portfolio: getPortfolio(), journal: getJournal(), aiSwots: lsGet(AI_SWOT_KEY, {}), projections: getProjections() };
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
  var pf = obj && Array.isArray(obj.portfolio) ? obj.portfolio : null;
  var pj = obj && obj.projections && typeof obj.projections === 'object' && !Array.isArray(obj.projections) ? obj.projections : null;
  if (!wl && !j && !ai && !pf && !pj) {
    status.className = 'status err';
    status.textContent = 'That file has no watchlist, portfolio, journal or AI SWOTs in it — not a Stock Research backup.';
    return;
  }
  if (!window.confirm('Replace your current watchlist, portfolio, journal and saved AI SWOTs with this backup?')) return;
  if (wl) setWatchlist(wl);
  if (pj) setProjections(pj);
  if (pf) setPortfolio(pf);
  if (j) setJournal(j);
  if (ai) lsSet(AI_SWOT_KEY, ai);
  renderWatchlist(false);
  renderPortfolio(false);
  renderJournal();
  renderPjSaved();
  if (lastStock) renderScorecard(lastStock);
  status.className = 'status';
  status.textContent = 'Backup restored: ' + (wl ? wl.length : 0) + ' watchlist item(s), ' + (pf ? pf.length : 0) + ' portfolio holding(s), ' + (j ? Object.keys(j).length : 0) + ' journal entr(ies)' + (ai ? ', ' + Object.keys(ai).length + ' AI SWOT(s)' : '') + '.';
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

/* ============================== ticker autocomplete ============================== */
/* Suggestion dropdown for ticker inputs: type a company name ("apple",
 * "sofi tech") or a partial ticker and pick the right symbol. Sources:
 * Yahoo symbol search, falling back to Nasdaq's autocomplete — both ride
 * the same relay race as the rest of the app. */
async function tickerSuggestions(q) {
  var query = String(q || '').trim();
  if (query.length < 2) return [];
  try {
    var y = await relayJSON('https://query2.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(query) + '&quotesCount=7&newsCount=0');
    var yq = ((y && y.quotes) || []).filter(function (x) {
      return x && x.symbol && (x.quoteType === 'EQUITY' || x.quoteType === 'ETF');
    }).map(function (x) {
      return { symbol: x.symbol, name: x.longname || x.shortname || '', exch: x.exchDisp || x.exchange || '' };
    });
    if (yq.length) return yq.slice(0, 7);
  } catch (e) {}
  try {
    var n = await relayJSON('https://api.nasdaq.com/api/autocomplete/slookup/10?search=' + encodeURIComponent(query));
    return ((n && n.data) || []).filter(function (x) {
      return x && x.symbol && x.asset === 'STOCKS';
    }).slice(0, 7).map(function (x) {
      return { symbol: x.symbol, name: (x.name || '').replace(/\s+Common Stock$/i, ''), exch: x.exchange || '' };
    });
  } catch (e) {}
  return [];
}
/* Resolve free text to a ticker (2026-11-05, Justin's ask): typing a
 * company NAME ("Micron") used to be treated as a ticker symbol, and
 * the load spun forever on an empty result. Now the same suggestions
 * behind the dropdown decide: an exact symbol match wins; otherwise
 * the dropdown's top pick is used automatically. Ticker-shaped input
 * already known locally (the loaded stock, watchlist, portfolio)
 * skips the lookup, and any lookup failure falls back to the raw
 * text, exactly as before. */
function looksKnownTicker(T) {
  if (!/^[A-Z]{1,5}([.\-][A-Z])?$/.test(T)) return false;
  try {
    if (typeof lastStock !== 'undefined' && lastStock && lastStock.ticker === T) return true;
    if (getWatchlist().some(function (w) { return w.ticker === T; })) return true;
    if (getPortfolio().some(function (p) { return p.ticker === T; })) return true;
  } catch (e) {}
  return false;
}

async function resolveTickerInput(raw) {
  var q = String(raw || '').trim();
  if (!q) return '';
  var up = q.toUpperCase();
  if (looksKnownTicker(up)) return up;
  var items = [];
  try { items = await tickerSuggestions(q); } catch (e) {}
  if (items && items.length) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].symbol && items[i].symbol.toUpperCase() === up) return items[i].symbol.toUpperCase();
    }
    if (items[0].symbol) return items[0].symbol.toUpperCase();
  }
  return up;
}

/* Bound a promise so no load can spin forever on a hung route. */
function withTimeout(p, ms, msg) {
  return Promise.race([p, new Promise(function (_, rej) {
    setTimeout(function () { rej(new Error(msg)); }, ms);
  })]);
}

function attachAutocomplete(input, onPick) {
  if (!input) return;
  var list = document.createElement('div');
  list.className = 'ac-list';
  list.style.display = 'none';
  document.body.appendChild(list);
  var seq = 0, timer = null;
  function hide() { list.style.display = 'none'; }
  function place() {
    var r = input.getBoundingClientRect();
    var vv = window.visualViewport;
    var vw = vv ? vv.width : window.innerWidth;
    var vh = vv ? vv.height : window.innerHeight;
    var vL = vv ? vv.offsetLeft : 0;
    var vT = vv ? vv.offsetTop : 0;
    // Wider than narrow inputs so full company names fit, but never
    // wider than the screen and never hanging off either edge.
    var w = Math.min(Math.max(r.width, 270), vw - 16);
    var left = Math.min(Math.max(r.left, vL + 8), vL + vw - w - 8);
    list.style.left = left + 'px';
    list.style.width = w + 'px';
    // Cap the height to the space that is actually visible (an open
    // keyboard shrinks it), open toward whichever side has more room,
    // and clamp the result inside the viewport: the options can never
    // run off the top or bottom of the screen again. Extra options
    // scroll inside the list.
    var below = (vT + vh) - r.bottom - 10;
    var above = r.top - vT - 10;
    var openUp = below < 200 && above > below;
    list.style.maxHeight = Math.max(90, Math.min(302, openUp ? above : below)) + 'px';
    var wasHidden = list.style.display === 'none';
    if (wasHidden) { list.style.visibility = 'hidden'; list.style.display = 'block'; }
    var h = list.offsetHeight;
    var top = openUp ? r.top - 4 - h : r.bottom + 4;
    var lo = vT + 6, hi = vT + vh - h - 6;
    var tbEl = document.querySelector('.topbar');
    if (tbEl) lo = Math.max(lo, tbEl.getBoundingClientRect().bottom + 4);
    if (hi < lo) hi = lo;
    list.style.top = Math.min(Math.max(top, lo), hi) + 'px';
    if (wasHidden) { list.style.display = 'none'; list.style.visibility = ''; }
  }
  function show(items) {
    if (!items.length) { hide(); return; }
    list.innerHTML = items.map(function (it) {
      return '<button type="button" class="ac-item" data-sym="' + esc(it.symbol) + '">' +
        '<span class="ac-top"><span class="ac-sym">' + esc(it.symbol) + '</span>' +
        (it.exch ? '<span class="ac-exch">' + esc(it.exch) + '</span>' : '') + '</span>' +
        '<span class="ac-name">' + esc(it.name) + '</span></button>';
    }).join('');
    place();
    list.style.display = 'block';
    list.querySelectorAll('.ac-item').forEach(function (b) {
      b.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        var sym = b.getAttribute('data-sym');
        input.value = sym;
        hide();
        input.blur();
        if (onPick) onPick(sym);
      });
    });
  }
  input.addEventListener('input', function () {
    var q = input.value;
    var my = ++seq;
    if (timer) clearTimeout(timer);
    if (String(q).trim().length < 2) { hide(); return; }
    timer = setTimeout(async function () {
      var items = await tickerSuggestions(q);
      if (my !== seq) return;
      show(items);
    }, 220);
  });
  input.addEventListener('focus', function () {
    // Inputs low on the screen (Quarterly Metrics sits below the
    // Projection Builder) used to get a dropdown flipped up over the
    // header; the other inputs all sit high and open downward. Bring
    // a low input up to the same zone on focus so its list opens
    // downward, attached, like everywhere else.
    setTimeout(function () {
      var r = input.getBoundingClientRect();
      var vv = window.visualViewport;
      var vh = vv ? vv.height : window.innerHeight;
      var vT = vv ? vv.offsetTop : 0;
      if (r.top <= vT + vh * 0.45) return;
      var main = document.querySelector('main');
      var tb = document.querySelector('.topbar');
      var headB = tb ? tb.getBoundingClientRect().bottom : vT + 56;
      if (main) main.scrollTop += r.top - headB - 14;
    }, 350);
  });
  input.addEventListener('blur', function () { setTimeout(hide, 180); });
  input.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
  window.addEventListener('resize', function () { if (list.style.display !== 'none') place(); });
  var mainEl = document.querySelector('main');
  if (mainEl) mainEl.addEventListener('scroll', function () { if (list.style.display !== 'none') place(); }, { passive: true });
}

/* ============================== tabs & init ============================== */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function (s) { s.classList.toggle('active', s.id === 'tab-' + name); });
  document.querySelectorAll('.tabbar button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === name); });
  document.querySelectorAll('.tabbar').forEach(function (n) { n.classList.remove('mini'); });
  var mn = document.querySelector('main');
  if (mn) mn.scrollTop = 0;
  var ti = document.querySelector('.tool-intro');
  if (ti) {
    if (ti.classList.contains('locked')) {
      ti.style.maxHeight = '0px'; ti.style.opacity = '0'; ti.style.marginBottom = '0px';
      var ib = $('intro-bar');
      if (ib) { ib.classList.remove('open'); ib.setAttribute('aria-expanded', 'false'); }
    } else { ti.style.maxHeight = ''; ti.style.opacity = ''; ti.style.marginBottom = ''; }
  }
  /* The glossary renders at init while its tab is hidden (getBBox is 0
   * there), so re-run the label fit once the tab is actually visible. */
  if (name === 'glossary' && typeof fitGlossText === 'function') fitGlossText();
}
/* Tools tab sub-pages (Justin's ask, 2026-10-30): the three tools
 * live behind a sliding segmented bar, one tool per page. The last
 * tool used is remembered; jumps into the builder land on its page. */
var TOOL_KEY = 'sr_tool_v1';
function setTool(name) {
  var names = ['pj', 'charts', 'cc', 'scr'];
  if (names.indexOf(name) === -1) name = 'pj';
  try { localStorage.setItem(TOOL_KEY, name); } catch (e) {}
  document.querySelectorAll('.toolseg button').forEach(function (b, i) {
    var on = b.getAttribute('data-tool') === name;
    b.classList.toggle('active', on);
    if (on) { var pill = $('toolseg-pill'); if (pill) pill.style.transform = 'translateX(' + (i * 100) + '%)'; }
  });
  names.forEach(function (n) {
    var pg = $('tool-' + n);
    if (pg) pg.classList.toggle('active', n === name);
  });
  if (name === 'scr') scrActivate();
  var mn = document.querySelector('main');
  if (mn && document.querySelector('#tab-tools.active')) mn.scrollTop = 0;
}
/* iOS standalone quirk: 100dvh intermittently resolves SHORT at
 * launch/resume, leaving the tab bar floating above a dead black
 * strip (Justin, 2026-10-26). Pin the shell height to the measured
 * inner height and re-measure on every lifecycle event that can
 * change it. Keyboard-safe: innerHeight ignores the keyboard. */
function fitShell() {
  try {
    var h = window.innerHeight || 0;
    // iOS standalone reports a SHORT innerHeight after an in-app
    // reload (it never re-fires resize), so trust the physical
    // screen height when running from the home screen in portrait:
    // the shell is supposed to fill exactly that.
    var standalone = (window.navigator && window.navigator.standalone) ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    if (standalone && window.screen && window.screen.height && window.innerHeight >= window.innerWidth) {
      h = Math.max(h, window.screen.height);
    }
    if (h > 0) document.documentElement.style.setProperty('--app-h', h + 'px');
  } catch (e) {}
}
window.addEventListener('resize', fitShell);
window.addEventListener('orientationchange', fitShell);
window.addEventListener('pageshow', fitShell);
window.addEventListener('load', fitShell);
window.addEventListener('focus', fitShell);
document.addEventListener('visibilitychange', function () { if (!document.hidden) fitShell(); });
fitShell();
setTimeout(fitShell, 300);
setTimeout(fitShell, 1200);
setTimeout(fitShell, 2500);

function initApp() {
  document.querySelectorAll('.tabbar button').forEach(function (b) {
    b.addEventListener('click', function () { clearBackChips(); switchTab(b.getAttribute('data-tab')); });
  });
  $('sc-back').addEventListener('click', goBackToOverview);
  $('jr-back').addEventListener('click', function () { switchTab(jrReturnTab); });
  $('gl-back').addEventListener('click', function () {
    if (glossStack.length) {
      var backTerm = glossStack.pop();
      var gs2 = $('gloss-search'); if (gs2) gs2.value = '';
      renderGlossary('');
      glossSyncBack();
      var it = document.querySelector('#gloss-list .g-item[data-term="' + backTerm + '"]');
      if (it) { it.scrollIntoView({ block: 'start' }); it.classList.add('flash'); }
      return;
    }
    var st = glossReturnState; glossReturnState = null;
    if (!st) { switchTab(glossReturn); return; }
    switchTab(st.tab);
    if (st.ov) { openOverview(st.ov); return; }
    var mn = document.querySelector('main');
    if (mn) { var y = st.scroll; requestAnimationFrame(function () { mn.scrollTop = y; }); }
  });
  $('privacy-back').addEventListener('click', function () { switchTab('portfolio'); });
  $('terms-back').addEventListener('click', function () { switchTab('portfolio'); });
  $('disclaimer-back').addEventListener('click', function () { switchTab('portfolio'); });
  $('tool-back').addEventListener('click', goBackToOverview);
  $('search-form').addEventListener('submit', function (e) {
    e.preventDefault();
    clearBackChips();
    runSearch($('search-input').value);
    $('search-input').blur();
  });
  attachAutocomplete($('search-input'), function (sym) { runSearch(sym); });
  attachAutocomplete($('pj-ticker'), function () { loadProjectionTicker(); });
  attachAutocomplete($('wl-ticker'), null);
  attachAutocomplete($('cmp-1'), null);
  attachAutocomplete($('cmp-2'), null);
  attachAutocomplete($('cmp-3'), null);
  attachAutocomplete($('j-ticker'), null);
  attachAutocomplete($('pf-ticker'), null);
  var pfAddBody = $('pf-add-body');
  function pfSetForm(open) {
    pfAddBody.hidden = !open;
    document.querySelector('.pf-add-card').classList.toggle('open', open);
    $('pf-add-toggle').setAttribute('aria-expanded', String(open));
  }
  $('pf-add-toggle').addEventListener('click', function () { pfSetForm(pfAddBody.hidden); });
  $('pf-view-overview').addEventListener('click', function () { pfSetView('overview'); });
  $('pf-view-news').addEventListener('click', function () { pfSetView('news'); });
  pfSetView(pfView());
  if (!getPortfolio().length) pfSetForm(true);
  $('pf-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var T = ($('pf-ticker').value || '').trim().toUpperCase();
    var shares = parseFloat($('pf-shares').value);
    var status = $('pf-status');
    if (!T) { status.className = 'status err'; status.textContent = 'Enter a ticker first.'; return; }
    if (!isNum(shares) || shares < 0) { status.className = 'status err'; status.textContent = 'Enter how many shares you own.'; return; }
    var pf = getPortfolio().filter(function (x) { return x.ticker !== T; });
    pf.push({ ticker: T, shares: shares, drip: $('pf-drip').value === 'yes', addedAt: Date.now() });
    setPortfolio(pf);
    $('pf-ticker').value = ''; $('pf-shares').value = '';
    status.className = 'status'; status.textContent = '';
    pfSetForm(false);
    renderPortfolio(true);
  });
  $('pf-refresh').addEventListener('click', function () { renderPortfolio(true); });
  var pfBtn = document.querySelector('.tabbar button[data-tab="portfolio"]');
  if (pfBtn) pfBtn.addEventListener('click', function () { renderPortfolio(!pfFetchedOnce); });
  renderPortfolio(false);
  $('compare-form').addEventListener('submit', function (e) { e.preventDefault(); runCompare(); });
  /* Zero-moment examples (2026-11-12): the static empty states offer
   * one-tap real lookups instead of dead ends. The scorecard chips run
   * the lookup; the compare example fills all three boxes and runs. */
  document.querySelectorAll('#score-empty [data-ex]').forEach(function (b) {
    b.addEventListener('click', function () {
      var T = b.getAttribute('data-ex');
      if (!T) return;
      $('search-input').value = T;
      runSearch(T);
    });
  });
  var cmpEx = document.querySelector('[data-cmp-ex]');
  if (cmpEx) cmpEx.addEventListener('click', function () {
    $('cmp-1').value = 'AAPL'; $('cmp-2').value = 'MSFT'; $('cmp-3').value = 'NVDA';
    runCompare();
  });
  document.querySelectorAll('.toolseg button').forEach(function (b) {
    b.addEventListener('click', function () { setTool(b.getAttribute('data-tool')); });
  });
  setTool(localStorage.getItem(TOOL_KEY) || 'pj');
  $('pj-run').addEventListener('click', runProjection);
  $('pj-path').addEventListener('change', onPjPathEdit);
  /* Years edits sync the year-by-year rows only (Justin's refined
   * ask, 2026-10-29): committing the Years box (the keyboard check)
   * grows or trims the path rows to match, extrapolating new rows
   * with the fade rule. The projection itself still runs only when
   * Build projection is clicked. */
  $('pj-years').addEventListener('change', function () {
    $('pj-years').value = pjYearsWanted();
    renderPjPath();
  });
  $('pj-growth').addEventListener('change', function () { if (!pjPathFromForecast) pjSynthPath(); renderPjPath(); });
  $('pj-eps').addEventListener('change', function () { if (!pjPathFromForecast) pjSynthPath(); renderPjPath(); });
  renderPjPath();
  $('pj-load-form').addEventListener('submit', function (e) {
    e.preventDefault();
    clearBackChips();
    loadProjectionTicker();
    $('pj-ticker').blur();
  });
  $('cc-run').addEventListener('click', runCompound);
  runCompound();
  attachAutocomplete($('qm-ticker'), function (sym) { $('qm-ticker').value = sym; loadQm(); });
  $('qm-load-form').addEventListener('submit', function (e) { e.preventDefault(); loadQm(); $('qm-ticker').blur(); });
  $('qm-csv').addEventListener('click', qmExportCsv);
  document.querySelectorAll('[data-qm]').forEach(function (b) {
    b.addEventListener('click', function () {
      qmMetric = b.getAttribute('data-qm');
      var list = $('qm-metric-list'), btn = $('qm-metric-btn');
      if (list) list.hidden = true;
      if (btn) btn.setAttribute('aria-expanded', 'false');
      renderQm();
    });
  });
  var qmBtn = $('qm-metric-btn');
  if (qmBtn) qmBtn.addEventListener('click', function () {
    var list = $('qm-metric-list');
    if (!list) return;
    list.hidden = !list.hidden;
    qmBtn.setAttribute('aria-expanded', list.hidden ? 'false' : 'true');
  });
  try { qmFreq = lsGet('sr_qmfreq', 'q') === 'y' ? 'y' : 'q'; } catch (e) {}
  try { var qw = parseInt(lsGet('sr_qmwin', 2), 10); if (QM_WIN_CHOICES.indexOf(qw) >= 0) qmWin = qw; } catch (e) {}
  document.querySelectorAll('[data-qmwin]').forEach(function (b) {
    b.addEventListener('click', function () {
      var v = parseInt(b.getAttribute('data-qmwin'), 10);
      if (QM_WIN_CHOICES.indexOf(v) < 0) return;
      qmWin = v;
      lsSet('sr_qmwin', v);
      renderQm();
    });
  });
  document.querySelectorAll('[data-qmfreq]').forEach(function (b) {
    b.addEventListener('click', function () {
      qmFreq = b.getAttribute('data-qmfreq');
      lsSet('sr_qmfreq', qmFreq);
      if (qmStore.ticker) loadQm();
    });
  });
  ensureQmWiring();
  $('wl-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var t = $('wl-ticker').value, target = parseFloat($('wl-target').value);
    if (!t.trim()) return;
    t = await resolveTickerInput(t);
    if (!t) return;
    addToWatchlist(t, isNum(target) ? target : null);
    $('wl-ticker').value = ''; $('wl-target').value = '';
  });
  $('wl-refresh').addEventListener('click', function () { renderWatchlist(true); });
  maybeStartScan();
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
  $('menu-glossary').addEventListener('click', function () {
    glossReturn = 'portfolio';
    glossReturnState = null;
    glossStack = [];
    glossSyncBack();
    settingsMenu.hidden = true;
    $('btn-settings').setAttribute('aria-expanded', 'false');
    switchTab('glossary');
  });
  $('menu-journal').addEventListener('click', function () {
    jrReturnTab = 'portfolio';
    settingsMenu.hidden = true;
    $('btn-settings').setAttribute('aria-expanded', 'false');
    switchTab('journal');
  });
  $('menu-privacy').addEventListener('click', function () {
    settingsMenu.hidden = true;
    $('btn-settings').setAttribute('aria-expanded', 'false');
    switchTab('privacy');
  });
  $('menu-terms').addEventListener('click', function () {
    settingsMenu.hidden = true;
    $('btn-settings').setAttribute('aria-expanded', 'false');
    switchTab('terms');
  });
  $('menu-disclaimer').addEventListener('click', function () {
    settingsMenu.hidden = true;
    $('btn-settings').setAttribute('aria-expanded', 'false');
    switchTab('disclaimer');
  });
  $('ov-back').addEventListener('click', function () { closeOverview(); });
  $('scr-run').addEventListener('click', function () { runScreener(); });
  $('scr-clear').addEventListener('click', function () { scrApplyControls({ ix: 'both', sort: 'combined' }); runScreener(); });
  $('scr-save').addEventListener('click', function () {
    var name = window.prompt('Name this screen:', '');
    if (name === null) return;
    name = String(name).trim();
    if (!name) return;
    var list = getSavedScreens();
    list.push({ name: name, f: scrReadControls() });
    lsSet(SCR_SAVED_KEY, list);
    renderSavedScreens();
  });
  $('scr-ix').addEventListener('change', function () { runScreener(); });
  $('scr-sort').addEventListener('change', function () { runScreener(); });
  if ($('scr-sector')) $('scr-sector').addEventListener('change', function () { runScreener(); });
  /* Floating nav shrinks while scrolling down (Instagram-style) and
   * restores on scroll up or near the top (Justin's ask, 2026-10-29). */
  var navEl = document.querySelector('.tabbar');
  var mainEl = document.querySelector('main');
  var introEl = document.querySelector('.tool-intro');
  var introBar = $('intro-bar');
  var introH = 0;
  var introLocked = false;
  function introCollapse() {
    introEl.style.maxHeight = '0px';
    introEl.style.opacity = '0';
    introEl.style.marginBottom = '0px';
  }
  function lockIntro() {
    introLocked = true;
    introEl.classList.add('locked');
    introCollapse();
    if (introBar) { introBar.hidden = false; introBar.classList.remove('open'); introBar.setAttribute('aria-expanded', 'false'); }
  }
  if (introBar && introEl) introBar.addEventListener('click', function () {
    var open = !introBar.classList.contains('open');
    introBar.classList.toggle('open', open);
    introBar.setAttribute('aria-expanded', String(open));
    if (open) {
      introH = introEl.scrollHeight || introH;
      introEl.style.maxHeight = introH + 'px';
      introEl.style.opacity = '1';
      introEl.style.marginBottom = '12px';
    } else introCollapse();
  });
  if (navEl && mainEl) {
    var lastSt = 0;
    mainEl.addEventListener('scroll', function () {
      var st = mainEl.scrollTop;
      if (st < 24) navEl.classList.remove('mini');
      else if (st > lastSt + 4 && st > 80) navEl.classList.add('mini');
      else if (st < lastSt - 4) navEl.classList.remove('mini');
      lastSt = st;
      /* The tab's intro text folds into itself over the first ~150px
       * of scrolling and unfolds again back at the top (Justin's ask,
       * 2026-10-29). Height is re-measured at the top, where the
       * inline styles are cleared and the text sits natural. */
      if (introEl) {
        if (introLocked) {
          /* Locked away (Justin's refinement, 2026-10-30): scrolling
           * back up no longer unfolds it; only the dropdown bar's
           * triangle reopens it. Scrolling down closes an open one. */
          if (introBar && introBar.classList.contains('open') && st > 60) {
            introBar.classList.remove('open');
            introBar.setAttribute('aria-expanded', 'false');
            introCollapse();
          }
        } else {
          if (st < 2) introH = introEl.scrollHeight;
          if (introH) {
            var p = Math.max(0, Math.min(1, st / 150));
            if (p >= 1) lockIntro();
            else if (p <= 0) {
              introEl.style.maxHeight = '';
              introEl.style.opacity = '';
              introEl.style.marginBottom = '';
            } else {
              introEl.style.maxHeight = (introH * (1 - p)) + 'px';
              introEl.style.opacity = String(1 - p);
              introEl.style.marginBottom = (12 * (1 - p)) + 'px';
            }
          }
        }
      }
    }, { passive: true });
  }
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
  document.addEventListener('click', function (e) {
    var gl = e.target && e.target.closest ? e.target.closest('.info-gloss-link') : null;
    if (gl) { e.preventDefault(); e.stopPropagation(); openGlossaryTerm(gl.getAttribute('data-gloss')); return; }
    var dot = e.target && e.target.closest ? e.target.closest('.info-dot') : null;
    if (!dot) return;
    e.preventDefault();
    e.stopPropagation();
    var key = dot.getAttribute('data-info');
    var txt = null, node = dot;
    for (var up = 0; up < 6 && !txt; up++) {
      node = node.parentElement;
      if (!node) break;
      txt = node.querySelector('.info-text[data-info-text="' + key + '"]');
      if (!txt && node.nextElementSibling && node.nextElementSibling.classList.contains('info-text') &&
          node.nextElementSibling.getAttribute('data-info-text') === key) txt = node.nextElementSibling;
    }
    if (txt) setInfoOpen(txt, !txt.classList.contains('open'));
  });
  document.addEventListener('click', function (e) {
    var mb = e.target && e.target.closest ? e.target.closest('[data-mathbtn]') : null;
    if (!mb) return;
    var mt = document.getElementById(mb.getAttribute('data-mathtarget'));
    if (!mt) return;
    mt.hidden = !mt.hidden;
    mb.setAttribute('aria-expanded', mt.hidden ? 'false' : 'true');
  });
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-ceotoggle]') : null;
    if (!b) return;
    var body = b.nextElementSibling;
    if (!body || !body.classList.contains('ceo-body')) return;
    body.hidden = !body.hidden;
    b.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
  });
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-moretoggle]') : null;
    if (!b) return;
    var body = b.nextElementSibling;
    if (!body || !body.classList.contains('more-body')) return;
    body.hidden = !body.hidden;
    b.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
  });
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-biztoggle]') : null;
    if (!b) return;
    var body = b.nextElementSibling;
    if (!body || !body.classList.contains('biz-body')) return;
    body.hidden = !body.hidden;
    b.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
  });
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-pjmore]') : null;
    if (!t) return;
    var body = t.nextElementSibling;
    if (!body) return;
    var open = body.classList.toggle('open');
    t.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  /* Scoring weights panel: presets + per-factor steppers + reset.
   * Every change saves immediately, re-renders the panel, and
   * re-scores the open scorecard (renderScorecard is self-contained)
   * so the effect is visible without a reload. */
  function weightsPresetKey(w) {
    var keys = Object.keys(SCORE_PRESETS);
    for (var i = 0; i < keys.length; i++) {
      if (JSON.stringify(SCORE_PRESETS[keys[i]]) === JSON.stringify(w)) return keys[i];
    }
    return 'custom';
  }
  function renderWeightsPanel() {
    var w = getScoreWeights();
    var pk = weightsPresetKey(w);
    document.querySelectorAll('[data-preset]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-preset') === pk);
    });
    ['val', 'risk'].forEach(function (side) {
      var box = $(side === 'val' ? 'weights-val' : 'weights-risk');
      if (!box) return;
      var defs = side === 'val' ? VAL_FACTOR_DEFS : RISK_FACTOR_DEFS;
      var html = '';
      defs.forEach(function (f) {
        var cur = w[side][f.name];
        html += '<div class="w-row"><span class="w-name">' + esc(f.name) + '</span>' +
          '<span class="w-step"><button type="button" class="w-btn" data-wadj="' + side + '|' + esc(f.name) + '|-1" aria-label="Count ' + esc(f.name) + ' less">\u2212</button>' +
          '<span class="w-val' + (cur === 0 ? ' off' : '') + '">' + cur + '</span>' +
          '<button type="button" class="w-btn" data-wadj="' + side + '|' + esc(f.name) + '|1" aria-label="Count ' + esc(f.name) + ' more">+</button></span></div>';
      });
      box.innerHTML = html;
    });
    var st = $('weights-state');
    if (st) st.textContent = pk === 'balanced' ? 'Standard weights \u2014 every score uses the shared rubric.'
      : pk === 'custom' ? 'Your custom weights are on. The scorecard shows the standard score next to yours.'
      : SCORE_PRESET_LABELS[pk] + ' weights are on. The scorecard shows the standard score next to yours.';
  }
  function afterWeightsChange() {
    renderWeightsPanel();
    if (lastStock) { try { renderScorecard(lastStock); } catch (e) {} }
  }
  document.querySelectorAll('[data-preset]').forEach(function (b) {
    b.addEventListener('click', function () {
      setScoreWeights(JSON.parse(JSON.stringify(SCORE_PRESETS[b.getAttribute('data-preset')])));
      afterWeightsChange();
    });
  });
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-wadj]') : null;
    if (!btn) return;
    var parts = btn.getAttribute('data-wadj').split('|');
    var side = parts[0], name = parts[1], delta = Number(parts[2]);
    var defs = side === 'val' ? VAL_FACTOR_DEFS : RISK_FACTOR_DEFS;
    var def = null;
    defs.forEach(function (f) { if (f.name === name) def = f; });
    if (!def) return;
    var w = getScoreWeights();
    var next = Math.max(0, Math.min(def.def * 2, (w[side][name] || 0) + delta));
    if (next === w[side][name]) return;
    w[side][name] = next;
    setScoreWeights(w);
    afterWeightsChange();
  });
  var wReset = $('weights-reset');
  if (wReset) wReset.addEventListener('click', function () {
    if (!window.confirm('Reset scoring weights to the standard rubric?')) return;
    setScoreWeights(stdWeights());
    afterWeightsChange();
  });
  renderWeightsPanel();
  $('set-clear-ai').addEventListener('click', function () {
    if (!window.confirm('Are you sure you\u2019d like to clear saved AI SWOTs?')) return;
    try { localStorage.removeItem(AI_SWOT_KEY); } catch (e) {}
    $('settings-note').textContent = 'Saved AI SWOTs cleared — regenerate any of them from a scorecard.';
    if (lastStock) renderScorecard(lastStock);
  });
  $('set-clear-cache').addEventListener('click', function () {
    if (!window.confirm('Are you sure you\u2019d like to clear the price cache?')) return;
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
    $('settings-note').textContent = 'Price cache cleared — the next lookups fetch fresh data.';
  });
  $('set-reload').addEventListener('click', function () { location.reload(); });
  $('journal-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var T = ($('j-ticker').value || '').trim().toUpperCase();
    if (!T) {
      showToast('This won\u2019t save yet \u2014 type a stock ticker in the Ticker box first.');
      var jt = $('j-ticker');
      jt.classList.add('field-warn');
      if (jt.scrollIntoView) jt.scrollIntoView({ block: 'center', behavior: 'smooth' });
      try { jt.focus({ preventScroll: true }); } catch (e2) { jt.focus(); }
      setTimeout(function () { jt.classList.remove('field-warn'); }, 2400);
      return;
    }
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
  $('gloss-list').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-gterm]') : null;
    if (!b) return;
    var item = e.target.closest('.g-item');
    glossJumpTo(b.getAttribute('data-gterm'), item ? item.getAttribute('data-term') : null);
  });
  dyBackfill();
  sectorBackfill();
  renderGlossary('');
  renderJournal();
  renderPjSaved();
  renderWatchlist(true);
}
if (typeof document !== 'undefined' && document.getElementById) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
  else initApp();
}
/* ==================== Supabase cloud sync ====================
 * Ported into the live app 2026-10-28 from the verified test copy
 * (~/workspace/stock-research-supabase-test/) after sync was proven
 * end-to-end there (sign-up, push, private-tab pull).
 *
 * Contract:
 *  - Config lives in supabase-config.js (window.SR_SUPABASE_URL /
 *    window.SR_SUPABASE_ANON_KEY). If either is empty, this whole block
 *    returns without touching the UI, localStorage, or the network, so
 *    the app behaves EXACTLY as the live version.
 *  - localStorage is always the source of truth. Every Supabase call is
 *    wrapped so a down/slow/misconfigured backend can only ever produce
 *    a status line — never an app error.
 *  - Only personal, irreplaceable data syncs (see SR_SYNC_DEFS). Price,
 *    scan and chart caches are regenerable and are NEVER synced.
 *
 * Data formats (matching how the app itself stores each key):
 *  - kind 'json'   — the app stores JSON.stringify(value) (via lsSet);
 *                    the parsed value is stored in Supabase as jsonb.
 *  - kind 'string' — the app stores a raw string (direct setItem);
 *                    the string is stored in Supabase as a JSON string
 *                    and written back raw, never JSON-quoted.
 *
 * Sign-in reconciliation (v1, deliberately conservative):
 *  - remote has data + local is empty/default  -> pull remote into local
 *  - local has data + remote is empty          -> push local up
 *  - both have data                             -> keep BOTH untouched
 *    (no silent overwrite in either direction; from then on, any new
 *    local change debounce-pushes and becomes the cloud copy)
 *  - a synced key removed locally deletes its cloud row.
 */
(function srSupabaseSync() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (typeof localStorage === 'undefined') return;

  var SR_SYNC_DEFS = [
    { key: 'sr_watchlist_v1', kind: 'json' },
    { key: 'sr_portfolio_v1', kind: 'json' },
    { key: 'sr_journal_v1', kind: 'json' },
    { key: 'sr_projections_v1', kind: 'json' },
    { key: 'sr_aiswot_v1', kind: 'json' },
    { key: 'sr_weights_v1', kind: 'json' },
    { key: 'sr_theme', kind: 'string' },
    { key: 'sr_wlsort_v1', kind: 'string' },
    { key: 'sr_pfview_v1', kind: 'string' }
  ];
  var SR_SYNC_BY_KEY = {};
  SR_SYNC_DEFS.forEach(function (d) { SR_SYNC_BY_KEY[d.key] = d; });

  var url = String(window.SR_SUPABASE_URL || '').trim();
  var anonKey = String(window.SR_SUPABASE_ANON_KEY || '').trim();
  if (!url || !anonKey) return; // not configured: behave exactly as today

  var client = null;
  try {
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      throw new Error('Supabase library did not load');
    }
    client = window.supabase.createClient(url, anonKey);
  } catch (e) {
    client = null;
  }

  var section = document.getElementById('sync-section');
  if (section) section.hidden = false;

  var currentUser = null;
  var patchInstalled = false;
  var applyingRemote = false;
  var pushTimers = {};

  function setSyncStatus(msg, isErr) {
    try {
      var el = document.getElementById('sync-status');
      if (!el) return;
      el.className = 'status' + (isErr ? ' err' : '');
      el.textContent = msg || '';
    } catch (e) {}
  }

  /* ---- Beta member cap + waitlist ----------------------------------
   * The beta is capped at 50 Supabase ACCOUNTS. The cap gates NEW
   * account creation only: it never blocks sign-in, and the app stays
   * fully usable without an account. The count lives in the relay
   * Worker's KV (see /beta-status, /beta-claim, /beta-waitlist in
   * relay/worker.js). Every call here fails SILENTLY — if the status
   * can't be fetched, this section behaves exactly as it always has.
   * The one exception: a status that WAS fetched and says full swaps
   * the sign-up button for the waitlist blurb (sign-in untouched). */
  var BETA_WORKER = 'https://stock-research-relay.supplessayings-6e6.workers.dev';
  var betaFull = false;
  var betaFetchAt = 0;
  var betaFetchBusy = false;

  function betaApply(st) {
    try {
      if (!st || typeof st.open !== 'boolean') return;
      betaFull = !st.open;
      var signUpBtn = document.getElementById('sync-signup');
      var fullBlock = document.getElementById('sync-beta-full');
      var capNum = document.getElementById('beta-cap-num');
      if (capNum && typeof st.cap === 'number') capNum.textContent = String(st.cap);
      if (betaFull) {
        if (signUpBtn) signUpBtn.style.display = 'none';
        if (fullBlock) fullBlock.hidden = false;
      } else {
        if (signUpBtn) signUpBtn.style.display = '';
        if (fullBlock) fullBlock.hidden = true;
      }
    } catch (e) {}
  }

  function betaFetchStatus() {
    var now = Date.now();
    if (betaFetchBusy || (now - betaFetchAt) < 30000) return;
    betaFetchBusy = true;
    betaFetchAt = now;
    try {
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 4000) : null;
      fetch(BETA_WORKER + '/beta-status', ctrl ? { signal: ctrl.signal } : {})
        .then(function (r) { return r.json(); })
        .then(function (st) { betaApply(st); })
        .catch(function () { /* fail silent: behave exactly as today */ })
        .then(function () { if (timer) clearTimeout(timer); betaFetchBusy = false; });
    } catch (e) { betaFetchBusy = false; }
  }

  function betaClaim(userId) {
    /* Fire-and-forget: a failed claim never affects the session. */
    try {
      if (!userId) return;
      fetch(BETA_WORKER + '/beta-claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: String(userId) })
      }).catch(function () {});
    } catch (e) {}
  }

  function wireBetaWaitlist() {
    var btn = document.getElementById('beta-waitlist-btn');
    if (!btn || btn._wired) return;
    btn._wired = true;
    btn.addEventListener('click', async function () {
      var emEl = document.getElementById('beta-waitlist-email');
      var stEl = document.getElementById('beta-waitlist-status');
      function say(msg, isErr) {
        if (stEl) { stEl.className = 'status' + (isErr ? ' err' : ''); stEl.textContent = msg; }
      }
      var email = emEl ? String(emEl.value || '').trim() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        say('Enter a valid email address first.', true);
        return;
      }
      btn.disabled = true;
      say('Joining the waitlist…');
      try {
        var r = await fetch(BETA_WORKER + '/beta-waitlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email })
        });
        var j = null;
        try { j = await r.json(); } catch (e) {}
        if (!r.ok || !j || !j.ok) throw new Error('waitlist rejected');
        var body = document.getElementById('beta-waitlist-body');
        if (body) body.innerHTML = '<p class="fineprint" style="margin:0">You\u2019re on the list — we\u2019ll email you when signups open again.</p>';
      } catch (e) {
        btn.disabled = false;
        say('Could not join the waitlist — check your connection and try again.', true);
      }
    });
  }

  function isEmptyParsed(v) {
    if (v == null || v === '') return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v).length === 0;
    return false;
  }

  function readLocal(def) {
    var raw = null;
    try { raw = localStorage.getItem(def.key); } catch (e) {}
    if (raw == null || raw === '') return { present: false, empty: true, value: null };
    if (def.kind === 'string') return { present: true, empty: false, value: raw };
    try {
      var parsed = JSON.parse(raw);
      return { present: true, empty: isEmptyParsed(parsed), value: parsed };
    } catch (e) {
      return { present: true, empty: false, value: raw };
    }
  }

  function writeLocal(def, remoteValue) {
    applyingRemote = true;
    try {
      if (def.kind === 'string') localStorage.setItem(def.key, String(remoteValue));
      else localStorage.setItem(def.key, JSON.stringify(remoteValue));
    } catch (e) {} finally { applyingRemote = false; }
  }

  function refreshAfterPull() {
    applyingRemote = true;
    try {
      try {
        var t = localStorage.getItem('sr_theme');
        if ((t === 'light' || t === 'dark') && typeof applyTheme === 'function') applyTheme(t);
      } catch (e) {}
      try {
        var sortSel = document.getElementById('wl-sort');
        if (sortSel && typeof getWlSort === 'function') sortSel.value = getWlSort();
      } catch (e) {}
      try { if (typeof pfSetView === 'function' && typeof pfView === 'function') pfSetView(pfView()); } catch (e) {}
      try { if (typeof renderWatchlist === 'function') renderWatchlist(false); } catch (e) {}
      try { if (typeof renderPortfolio === 'function') renderPortfolio(false); } catch (e) {}
      try { if (typeof renderJournal === 'function') renderJournal(); } catch (e) {}
      try { if (typeof renderPjSaved === 'function') renderPjSaved(); } catch (e) {}
      try {
        if (typeof lastStock !== 'undefined' && lastStock && typeof renderScorecard === 'function') {
          renderScorecard(lastStock);
        }
      } catch (e) {}
    } finally { applyingRemote = false; }
  }

  async function pushKey(key) {
    if (!client || !currentUser) return;
    var def = SR_SYNC_BY_KEY[key];
    if (!def) return;
    try {
      var local = readLocal(def);
      var res;
      if (!local.present) {
        res = await client.from('user_data').delete()
          .eq('user_id', currentUser.id).eq('data_key', key);
      } else {
        res = await client.from('user_data').upsert({
          user_id: currentUser.id,
          data_key: key,
          value: local.value,
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id,data_key' });
      }
      if (res && res.error) throw res.error;
      setSyncStatus('Synced just now.');
    } catch (e) {
      setSyncStatus('Sync failed — changes are safe on this device and will retry on the next change.', true);
    }
  }

  function schedulePush(key) {
    if (!currentUser || applyingRemote) return;
    if (!SR_SYNC_BY_KEY[key]) return;
    if (pushTimers[key]) clearTimeout(pushTimers[key]);
    pushTimers[key] = setTimeout(function () {
      delete pushTimers[key];
      pushKey(key);
    }, 2000);
  }

  function installWritePatch() {
    if (patchInstalled) return;
    patchInstalled = true;
    try {
      var origSet = Storage.prototype.setItem;
      var origRemove = Storage.prototype.removeItem;
      Storage.prototype.setItem = function (k, v) {
        var out = origSet.call(this, k, v);
        try { if (this === localStorage) schedulePush(String(k)); } catch (e) {}
        return out;
      };
      Storage.prototype.removeItem = function (k) {
        var out = origRemove.call(this, k);
        try { if (this === localStorage) schedulePush(String(k)); } catch (e) {}
        return out;
      };
    } catch (e) {
      /* If the prototype cannot be patched on this browser, sign-in
       * reconciliation above still works; only live push is lost. */
    }
  }

  async function reconcile() {
    if (!client || !currentUser) return;
    setSyncStatus('Checking your cloud backup…');
    try {
      var res = await client.from('user_data')
        .select('data_key, value')
        .eq('user_id', currentUser.id);
      if (res && res.error) throw res.error;
      var remote = {};
      ((res && res.data) || []).forEach(function (row) { remote[row.data_key] = row.value; });

      var pulled = [], pushKeys = [], both = 0;
      SR_SYNC_DEFS.forEach(function (def) {
        var hasRemote = Object.prototype.hasOwnProperty.call(remote, def.key) &&
          remote[def.key] != null && !isEmptyParsed(remote[def.key]);
        var local = readLocal(def);
        if (hasRemote && local.empty) {
          writeLocal(def, remote[def.key]);
          pulled.push(def.key);
        } else if (!local.empty && !hasRemote) {
          pushKeys.push(def.key);
        } else if (!local.empty && hasRemote) {
          both++;
        }
      });
      for (var i = 0; i < pushKeys.length; i++) await pushKey(pushKeys[i]);
      if (pulled.length) refreshAfterPull();
      if (pulled.length || pushKeys.length) {
        setSyncStatus('Sync done — ' +
          (pulled.length ? pulled.length + ' item(s) restored from the cloud. ' : '') +
          (pushKeys.length ? pushKeys.length + ' item(s) backed up. ' : '') +
          (both ? both + ' item(s) exist in both places — kept this device\u2019s copy.' : ''));
      } else if (both) {
        setSyncStatus('Signed in. Your data here and in the cloud both exist — kept this device\u2019s copy; new changes sync from now on.');
      } else {
        setSyncStatus('Signed in. Nothing to sync yet — add something and it backs up automatically.');
      }
    } catch (e) {
      setSyncStatus('Could not reach Supabase — the app keeps working from this device.', true);
    }
  }

  function showAuthState() {
    try {
      var out = document.getElementById('sync-signed-out');
      var inn = document.getElementById('sync-signed-in');
      var userEl = document.getElementById('sync-user');
      if (currentUser) {
        if (out) out.hidden = true;
        if (inn) inn.hidden = false;
        if (userEl) userEl.textContent = currentUser.email || '';
      } else {
        if (out) out.hidden = false;
        if (inn) inn.hidden = true;
        if (userEl) userEl.textContent = '';
        /* Signed-out view is where sign-up lives: refresh beta state
         * (throttled inside betaFetchStatus; fails silently). */
        try { betaFetchStatus(); } catch (e) {}
      }
    } catch (e) {}
  }

  async function afterSignIn(user) {
    currentUser = user || null;
    showAuthState();
    if (!currentUser) return;
    installWritePatch();
    await reconcile();
  }

  function wireSyncUi() {
    var signInBtn = document.getElementById('sync-signin');
    var signUpBtn = document.getElementById('sync-signup');
    var signOutBtn = document.getElementById('sync-signout');
    var syncNowBtn = document.getElementById('sync-now');
    function creds() {
      var em = document.getElementById('sync-email');
      var pw = document.getElementById('sync-password');
      return {
        email: em ? String(em.value || '').trim() : '',
        password: pw ? String(pw.value || '') : ''
      };
    }
    if (signInBtn) signInBtn.addEventListener('click', async function () {
      if (!client) { setSyncStatus('Sync is unavailable right now — the app still works offline.', true); return; }
      var c = creds();
      if (!c.email || !c.password) { setSyncStatus('Enter your email and password first.', true); return; }
      setSyncStatus('Signing in…');
      try {
        var r = await client.auth.signInWithPassword(c);
        if (r.error) throw r.error;
        await afterSignIn(r.data && r.data.user);
      } catch (e) {
        setSyncStatus('Sign-in failed: ' + (e && e.message ? e.message : 'unknown error'), true);
      }
    });
    if (signUpBtn) signUpBtn.addEventListener('click', async function () {
      if (!client) { setSyncStatus('Sync is unavailable right now — the app still works offline.', true); return; }
      var c = creds();
      if (!c.email || !c.password) { setSyncStatus('Enter an email and a password first.', true); return; }
      setSyncStatus('Creating your account…');
      try {
        var r = await client.auth.signUp(c);
        if (r.error) throw r.error;
        /* Claim a beta spot for the new account (fire-and-forget).
         * Runs even if the beta was full on a stale status — the cap
         * is soft and a completed sign-up is never turned away. */
        try { if (r.data && r.data.user && r.data.user.id) betaClaim(r.data.user.id); } catch (e) {}
        if (r.data && r.data.session && r.data.user) {
          await afterSignIn(r.data.user);
        } else {
          setSyncStatus('Account created — confirm it from the email Supabase sent you, then sign in.');
        }
      } catch (e) {
        setSyncStatus('Sign-up failed: ' + (e && e.message ? e.message : 'unknown error'), true);
      }
    });
    if (signOutBtn) signOutBtn.addEventListener('click', async function () {
      try { if (client) await client.auth.signOut(); } catch (e) {}
      currentUser = null;
      showAuthState();
      setSyncStatus('Signed out — your data stays on this device.');
    });
    if (syncNowBtn) syncNowBtn.addEventListener('click', function () { reconcile(); });
    window.addEventListener('online', function () { if (currentUser) reconcile(); });
  }

  try {
    wireSyncUi();
    wireBetaWaitlist();
    betaFetchStatus();
    if (!client) {
      setSyncStatus('Sync is unavailable (library or connection problem) — the app still works from this device.', true);
      return;
    }
    showAuthState();
    setSyncStatus('Not signed in.');
    client.auth.getSession().then(function (r) {
      var session = r && r.data && r.data.session;
      if (session && session.user) return afterSignIn(session.user);
      return null;
    }).catch(function () {
      setSyncStatus('Could not reach Supabase — the app keeps working from this device.', true);
    });
    try {
      client.auth.onAuthStateChange(function (event) {
        if (event === 'SIGNED_OUT') {
          currentUser = null;
          showAuthState();
        }
      });
    } catch (e) {}
  } catch (e) {
    try { setSyncStatus('Sync failed to start — the app still works from this device.', true); } catch (e2) {}
  }
})();

/* ==================== Onboarding: The 5% Quiz ====================
 * First-launch overlay (markup: #ob-overlay in index.html). Shown ONCE
 * per device: the localStorage flag sr_onboard_v1 is LOCAL-ONLY — it is
 * deliberately NOT one of the Supabase synced keys, so finishing the
 * quiz never touches sync. The automatic first-launch showing is
 * UNSKIPPABLE (mode 'auto': the Skip control is hidden and guarded, so
 * the only exit is completing the flow via the final "Enter the app"
 * CTA, which sets the flag). Settings -> "The 5% Quiz"
 * replays it any time in mode 'replay', where Skip stays available and
 * leaving a replay never changes the flag.
 *
 * Every number on the chart comes from the same future-value-of-an-
 * annuity formula, computed live: $500/month = $6,000/year, annual
 * compounding, contributions at each year-end, FV = 6000*((1+r)^t-1)/r.
 * At t=40 that gives $2,655,555 at 10%, $10,674,542 at 15% and
 * $44,063,147 at 20% — the graph and the quiz answers can't disagree.
 * A failure anywhere in this block must never break the app, so the
 * whole thing is guarded and returns quietly. */
(function srOnboarding() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (typeof localStorage === 'undefined') return;
  try {
    var FLAG = 'sr_onboard_v1';
    var overlay = document.getElementById('ob-overlay');
    if (!overlay) return;
    var scroller = document.getElementById('ob-scroll');

    var YEARLY = 6000, YEARS = 40;
    function fv(rate, t) { return YEARLY * ((Math.pow(1 + rate, t) - 1) / rate); }
    function fmtM(v) { return '$' + (v / 1e6).toFixed(2) + 'M'; }

    var SERIES = [
      { key: '10', rate: 0.10, color: 'var(--muted)', label: '10%/yr' },
      { key: '15', rate: 0.15, color: 'var(--gold)', label: '15%/yr' },
      { key: '20', rate: 0.20, color: 'var(--neon-up)', label: '20%/yr' }
    ];
    /* Plot geometry inside the 360x220 viewBox. */
    var X0 = 6, X1 = 354, YTOP = 20, YBASE = 196;
    var visible = ['10'];

    function seriesByKey(k) {
      for (var i = 0; i < SERIES.length; i++) if (SERIES[i].key === k) return SERIES[i];
      return null;
    }
    function pathFor(s, yMax) {
      var d = '';
      for (var t = 0; t <= YEARS; t++) {
        var x = X0 + (X1 - X0) * (t / YEARS);
        var y = YBASE - (YBASE - YTOP) * (fv(s.rate, t) / yMax);
        d += (t === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
      }
      return d;
    }
    function renderChart(animateKey) {
      var yMax = 0;
      visible.forEach(function (k) { yMax = Math.max(yMax, fv(seriesByKey(k).rate, YEARS)); });
      var ymaxEl = document.getElementById('ob-ymax');
      if (ymaxEl) ymaxEl.textContent = fmtM(yMax);
      SERIES.forEach(function (s) {
        var path = document.getElementById('ob-line-' + s.key);
        var dot = document.getElementById('ob-dot-' + s.key);
        if (!path) return;
        var isVis = visible.indexOf(s.key) !== -1;
        path.hidden = !isVis;
        if (dot) dot.hidden = !isVis;
        if (!isVis) return;
        path.style.stroke = s.color;
        path.setAttribute('d', pathFor(s, yMax));
        if (dot) {
          dot.style.fill = s.color;
          dot.setAttribute('cx', X1.toFixed(1));
          dot.setAttribute('cy', (YBASE - (YBASE - YTOP) * (fv(s.rate, YEARS) / yMax)).toFixed(1));
        }
        path.style.transition = 'none';
        path.style.strokeDasharray = 'none';
        path.style.strokeDashoffset = '0';
        /* Emil review 2026-10-30: skip the line-draw under reduced motion. */
        if (animateKey === s.key && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) {
          try {
            var len = path.getTotalLength();
            path.style.strokeDasharray = String(len);
            path.style.strokeDashoffset = String(len);
            void path.getBoundingClientRect();
            path.style.transition = 'stroke-dashoffset 1.1s ease';
            path.style.strokeDashoffset = '0';
          } catch (e) {}
        }
      });
      var legend = document.getElementById('ob-legend');
      if (legend) {
        legend.innerHTML = '';
        visible.forEach(function (k) {
          var s = seriesByKey(k);
          var item = document.createElement('span');
          item.className = 'ob-leg';
          var sw = document.createElement('i');
          sw.style.background = s.color;
          item.appendChild(sw);
          item.appendChild(document.createTextNode(s.label + ' \u2192 ' + fmtM(fv(s.rate, YEARS))));
          legend.appendChild(item);
        });
      }
    }

    /* Progress header (signage only): stage 1 = question 1 (incl. its
     * reveal), stage 2 = question 2, stage 3 = final screen ("Done"). */
    function setProgress(stage) {
      var label = document.getElementById('ob-step-label');
      var seg1 = document.getElementById('ob-seg-1');
      var seg2 = document.getElementById('ob-seg-2');
      if (seg1) seg1.classList.toggle('on', stage >= 1);
      if (seg2) seg2.classList.toggle('on', stage >= 2);
      if (label) label.textContent = stage >= 3 ? 'Done' : 'Question ' + Math.min(stage, 2) + ' of 2';
    }

    function resetQuiz() {
      visible = ['10'];
      overlay.classList.remove('ob-q1-done');
      var intro = document.getElementById('ob-intro');
      var p1 = document.getElementById('ob-panel-1');
      var p2 = document.getElementById('ob-panel-2');
      if (intro) intro.hidden = false;
      if (p1) p1.hidden = false;
      if (p2) p2.hidden = true;
      ['ob-reveal-1', 'ob-reveal-2'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.hidden = true;
      });
      ['ob-opts-1', 'ob-opts-2'].forEach(function (id) {
        var wrap = document.getElementById(id);
        if (!wrap) return;
        wrap.classList.remove('locked');
        var opts = wrap.querySelectorAll('.ob-opt');
        for (var i = 0; i < opts.length; i++) {
          opts[i].disabled = false;
          opts[i].classList.remove('right', 'wrong', 'dim');
        }
      });
      ['ob-hint-1', 'ob-hint-2'].forEach(function (id) {
        var h = document.getElementById(id);
        if (h) h.hidden = false;
      });
      setProgress(1);
      if (scroller) scroller.scrollTop = 0;
      renderChart('10');
    }
    /* Two ways the quiz can be open:
     * 'auto'   — the automatic first-launch showing. UNSKIPPABLE: the
     *            overlay gets the .ob-locked class (CSS hides the Skip
     *            control) and dismissQuiz() refuses to close, so the
     *            only way out is finishing via the final CTA.
     * 'replay' — opened manually from Settings by a returning user.
     *            Skip stays visible and closes the overlay without
     *            touching the flag (it is already set). */
    var quizMode = 'replay';
    function openQuiz(m) {
      quizMode = (m === 'auto') ? 'auto' : 'replay';
      overlay.classList.toggle('ob-locked', quizMode === 'auto');
      resetQuiz();
      overlay.hidden = false;
    }
    function dismissQuiz() {
      if (quizMode === 'auto') return; /* unskippable on first launch */
      overlay.hidden = true;
    }
    function finishQuiz() {
      overlay.hidden = true;
      try { localStorage.setItem(FLAG, '1'); } catch (e) {}
      /* Broadcast the finish (with the mode) so other modules can
       * react — the install prompt keys off the FIRST-run finish,
       * mode 'auto'; replay finishes carry mode 'replay'. */
      try {
        var ev;
        try { ev = new CustomEvent('sr-quiz-finished', { detail: { mode: quizMode } }); }
        catch (e2) {
          ev = document.createEvent('Event');
          ev.initEvent('sr-quiz-finished', true, false);
          ev.detail = { mode: quizMode };
        }
        window.dispatchEvent(ev);
      } catch (e) {}
    }
    function reveal(id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.hidden = false;
      setTimeout(function () {
        try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
      }, 400);
    }
    function answer(q, btn) {
      var wrap = document.getElementById('ob-opts-' + q);
      if (!wrap || wrap.classList.contains('locked')) return;
      wrap.classList.add('locked');
      var hint = document.getElementById('ob-hint-' + q);
      if (hint) hint.hidden = true; /* replaced by the reveal's button */
      var opts = wrap.querySelectorAll('.ob-opt');
      for (var i = 0; i < opts.length; i++) {
        opts[i].disabled = true;
        if (opts[i].hasAttribute('data-correct')) opts[i].classList.add('right');
        else if (opts[i] === btn) opts[i].classList.add('wrong');
        else opts[i].classList.add('dim');
      }
      if (q === 1) {
        visible = ['10', '15'];
        /* No-scroll fit: compact the intro for the reveal so the
         * callout + Next button share Q1's screen (see .ob-q1-done). */
        overlay.classList.add('ob-q1-done');
        renderChart('15');
        reveal('ob-reveal-1');
      } else {
        visible = ['10', '15', '20'];
        renderChart('20');
        setProgress(3); /* final screen */
        reveal('ob-reveal-2');
      }
    }

    var optsAll = overlay.querySelectorAll('.ob-opt');
    for (var i = 0; i < optsAll.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          answer(parseInt(btn.getAttribute('data-obq'), 10), btn);
        });
      })(optsAll[i]);
    }
    var skipBtn = document.getElementById('ob-skip');
    if (skipBtn) skipBtn.addEventListener('click', dismissQuiz);
    var ctaBtn = document.getElementById('ob-cta');
    if (ctaBtn) ctaBtn.addEventListener('click', finishQuiz);
    var nextBtn = document.getElementById('ob-next-1');
    if (nextBtn) nextBtn.addEventListener('click', function () {
      var intro = document.getElementById('ob-intro');
      var p1 = document.getElementById('ob-panel-1');
      var p2 = document.getElementById('ob-panel-2');
      if (intro) intro.hidden = true;
      if (p1) p1.hidden = true;
      if (p2) p2.hidden = false;
      setProgress(2);
      if (scroller) { try { scroller.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { scroller.scrollTop = 0; } }
    });
    var replayBtn = document.getElementById('menu-quiz');
    if (replayBtn) replayBtn.addEventListener('click', function () {
      var menu = document.getElementById('settings-menu');
      if (menu) menu.hidden = true;
      var gear = document.getElementById('btn-settings');
      if (gear) gear.setAttribute('aria-expanded', 'false');
      openQuiz('replay');
    });

    var seen = false;
    try { seen = !!localStorage.getItem(FLAG); } catch (e) { seen = true; }
    if (!seen) openQuiz('auto');
  } catch (e) {}
})();

/* ==================== First-save account prompt ====================
 * Value first, account second (Justin's call, 2026-10-31): the quiz
 * and the app stay fully open — no account wall anywhere. The FIRST
 * time a signed-out user saves something real (adds a watchlist stock
 * or a portfolio position), a bottom sheet offers a free Cloud Sync
 * account as a backup. Each trigger fires at most once per device,
 * ever: the localStorage flags in sr_acctprompt_v1 are LOCAL-ONLY and
 * deliberately NOT one of the Supabase synced keys.
 *
 * Detection is passive and cannot break a save: this block wraps
 * Storage.prototype.setItem (the same technique the sync layer uses),
 * calls the original first, and only then diffs the ticker sets of
 * sr_watchlist_v1 / sr_portfolio_v1 writes to spot a genuinely new
 * ticker. The sheet itself appears ~700ms after the save, once the
 * add has fully completed and rendered.
 *
 * Signed-in state is never guessed. detectSignedIn() returns true
 * (signed in), false (confidently signed out), or null (unknown) and
 * the prompt only shows on an explicit false: a Supabase session
 * token in localStorage (sb-<ref>-auth-token, written by the auth
 * library itself) or the sync section's signed-in panel both mean
 * signed in; an unreadable token or any ambiguity suppresses the
 * prompt — a missed pitch beats nagging a signed-in user. */
(function srAccountPrompt() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (typeof localStorage === 'undefined' || typeof Storage === 'undefined') return;

  var FLAG_KEY = 'sr_acctprompt_v1';
  var WL_KEY_L = 'sr_watchlist_v1';
  var PF_KEY_L = 'sr_portfolio_v1';
  var sheetEl = null;
  var timer = null;

  function readFlags() {
    try {
      var v = JSON.parse(localStorage.getItem(FLAG_KEY) || '{}');
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    } catch (e) { return {}; }
  }
  function alreadyShown(kind) {
    try { return !!readFlags()[kind]; } catch (e) { return true; }
  }
  function markShown(kind) {
    try {
      var f = readFlags();
      f[kind] = 1;
      localStorage.setItem(FLAG_KEY, JSON.stringify(f));
    } catch (e) {}
  }

  function detectSignedIn() {
    try {
      var url = String(window.SR_SUPABASE_URL || '').trim();
      var anon = String(window.SR_SUPABASE_ANON_KEY || '').trim();
      if (!url || !anon) return null; // sync not configured: no account to pitch
      var section = document.getElementById('sync-section');
      if (!section || section.hidden) return null;
      var tokenUser = false;
      var tokenBad = false;
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (!k || k.indexOf('sb-') !== 0 || k.slice(-11) !== '-auth-token') continue;
          try {
            var parsed = JSON.parse(localStorage.getItem(k) || 'null');
            var sess = null;
            if (parsed && typeof parsed === 'object') {
              if (parsed.user) sess = parsed;
              else if (parsed.currentSession && parsed.currentSession.user) sess = parsed.currentSession;
              else if (parsed.session && parsed.session.user) sess = parsed.session;
            }
            if (sess && sess.user && (sess.user.id || sess.user.email)) tokenUser = true;
          } catch (e) { tokenBad = true; }
        }
      } catch (e) { return null; }
      if (tokenUser) return true;
      if (tokenBad) return null;
      var inn = document.getElementById('sync-signed-in');
      var out = document.getElementById('sync-signed-out');
      if (inn && !inn.hidden) return true;
      if (out && !out.hidden) return false;
      return null;
    } catch (e) { return null; }
  }

  function tickerSet(raw) {
    var set = {};
    try {
      var arr = JSON.parse(raw || '[]');
      if (Array.isArray(arr)) {
        arr.forEach(function (x) {
          if (x && x.ticker) set[String(x.ticker).toUpperCase()] = 1;
        });
      }
    } catch (e) {}
    return set;
  }

  function onSaveWrite(kind, beforeRaw, afterRaw) {
    try {
      if (alreadyShown(kind)) return;
      var before = tickerSet(beforeRaw);
      var after = tickerSet(afterRaw);
      var added = false;
      for (var t in after) { if (!before[t]) { added = true; break; } }
      if (added) schedule(kind);
    } catch (e) {}
  }

  function schedule(kind) {
    if (timer || sheetEl) return; // one prompt at a time, ever
    timer = setTimeout(function () {
      timer = null;
      try { tryShow(kind); } catch (e) {}
    }, 700);
  }

  function quizOpen() {
    try {
      var ov = document.getElementById('ob-overlay');
      return !!ov && !ov.hidden;
    } catch (e) { return false; }
  }

  function tryShow(kind) {
    if (sheetEl) return;
    if (alreadyShown(kind)) return;
    if (quizOpen()) return; // never during the onboarding quiz
    if (detectSignedIn() !== false) return; // signed in, or unsure: stay silent
    markShown(kind); // shown once = consumed, whatever they tap
    buildSheet();
  }

  function closeSheet() {
    try {
      if (sheetEl && sheetEl.parentNode) sheetEl.parentNode.removeChild(sheetEl);
    } catch (e) {}
    sheetEl = null;
  }

  function gotoSyncSignup() {
    try { if (typeof switchTab === 'function') switchTab('portfolio'); } catch (e) {}
    /* The menu opens on a tick, not synchronously: the app closes the
     * settings menu on any document click outside it, and the CTA tap
     * that brought us here is still bubbling toward document — opening
     * the menu inside that same dispatch would close it instantly. */
    setTimeout(function () {
      try {
        var menu = document.getElementById('settings-menu');
        var gear = document.getElementById('btn-settings');
        if (menu) menu.hidden = false;
        if (gear) gear.setAttribute('aria-expanded', 'true');
        var sec = document.getElementById('sync-section');
        if (sec && sec.scrollIntoView) sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) {}
      setTimeout(function () {
        try {
          var em = document.getElementById('sync-email');
          if (em) em.focus();
        } catch (e) {}
      }, 400);
    }, 80);
  }

  function buildSheet() {
    var bg = document.createElement('div');
    bg.className = 'pf-sheet-bg';
    bg.innerHTML = '<div class="pf-sheet" role="dialog" aria-modal="true" aria-label="Back this up">' +
      '<h4>Back this up</h4>' +
      '<p class="ap-body">Create a free account and your watchlist, portfolio, and research sync to the cloud.</p>' +
      '<div class="pf-sheet-row" style="margin-top:12px">' +
      '<button type="button" class="btn-ghost" id="ap-notnow" style="flex:1">Not now</button>' +
      '<button type="button" class="pf-sh-save" id="ap-cta" style="flex:1">Create free account</button>' +
      '</div></div>';
    document.body.appendChild(bg);
    sheetEl = bg;
    var cta = bg.querySelector('#ap-cta');
    if (cta) cta.addEventListener('click', function (e) { if (e) e.stopPropagation(); closeSheet(); gotoSyncSignup(); });
    var nn = bg.querySelector('#ap-notnow');
    if (nn) nn.addEventListener('click', function () { closeSheet(); });
    bg.addEventListener('click', function (e) { if (e.target === bg) closeSheet(); });
  }

  /* Passive save observer: the original write always runs first and
   * its result is always returned; observation is fully guarded so a
   * failure here can never break a watchlist/portfolio save. Chains
   * cleanly with the sync layer's own setItem patch (install order
   * does not matter — each wrapper calls the previous one). */
  try {
    var origSetItem = Storage.prototype.setItem;
    if (!origSetItem.__srAcctPrompt) {
      var wrappedSetItem = function (k, v) {
        var watch = false;
        var before = null;
        try {
          watch = (this === localStorage) && (k === WL_KEY_L || k === PF_KEY_L);
          if (watch) { try { before = this.getItem(k); } catch (e) { before = null; } }
        } catch (e) { watch = false; }
        var out = origSetItem.apply(this, arguments);
        if (watch) {
          try { onSaveWrite(k === WL_KEY_L ? 'wl' : 'pf', before, v); } catch (e) {}
        }
        return out;
      };
      wrappedSetItem.__srAcctPrompt = true;
      Storage.prototype.setItem = wrappedSetItem;
    }
  } catch (e) {}
})();

/* ==================== Smart install prompt ====================
 * The app is distributed by link and runs fine in a browser, but the
 * full-screen Home Screen install is the experience we want people
 * living in. Installing differs by where the visitor opened the
 * link, so this sheet teaches the right move for THEIR situation:
 * a real one-tap Install on Android Chrome (captured
 * beforeinstallprompt), numbered Share-sheet steps in iOS Safari,
 * and "open in Safari first" guidance inside in-app browsers and
 * other iOS browsers, which cannot install at all.
 *
 * Timing follows the same value-first rule as the account prompt:
 * the automatic showing happens ONCE per device (flag
 * sr_installprompt_v1, LOCAL-ONLY, deliberately NOT a synced key),
 * shortly after the FIRST-run quiz is finished — the onboarding
 * block broadcasts 'sr-quiz-finished' with its mode, and only mode
 * 'auto' counts; replay finishes never re-trigger it. A permanent
 * manual route lives in Settings -> "Add to Home Screen". The sheet
 * never appears when the app is already installed (standalone) or
 * on desktop, and if another sheet (e.g. the account prompt) is up
 * when the moment comes it retries once, then stays silent.
 * Everything is guarded: a failure here must never affect the app. */
(function srInstallPrompt() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (typeof localStorage === 'undefined') return;

  var FLAG_KEY = 'sr_installprompt_v1';
  var sheetEl = null;
  var timer = null;
  var retries = 0;
  var deferredBIP = null;

  /* Chromium fires beforeinstallprompt once when the page becomes
   * installable; stash the event so the sheet's Install button can
   * trigger the real browser prompt later. */
  try {
    window.addEventListener('beforeinstallprompt', function (e) {
      try { e.preventDefault(); } catch (err) {}
      deferredBIP = e;
    });
    window.addEventListener('appinstalled', function () {
      deferredBIP = null;
      markShown();
      closeSheet();
    });
  } catch (e) {}

  function markShown() {
    try { localStorage.setItem(FLAG_KEY, '1'); } catch (e) {}
  }
  function alreadyShown() {
    try { return !!localStorage.getItem(FLAG_KEY); } catch (e) { return true; }
  }

  function isStandalone() {
    try {
      if (window.navigator && window.navigator.standalone === true) return true;
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (e) {}
    return false;
  }

  function ua() { try { return String(window.navigator.userAgent || ''); } catch (e) { return ''; } }
  function isIOS() {
    var u = ua();
    if (/iPhone|iPad|iPod/i.test(u)) return true;
    /* iPadOS 13+ sends a Macintosh UA; touch points give it away. */
    try { return /Macintosh/.test(u) && window.navigator.maxTouchPoints > 1; } catch (e) { return false; }
  }
  function isAndroid() { return /Android/i.test(ua()); }

  /* Real iOS Safari carries BOTH the Version/ and Safari/ tokens and
   * none of the markers other iOS browsers (CriOS, FxiOS, ...) or
   * in-app webviews (Instagram, FBAN/FBAV, TikTok, ...) add. Anything
   * else on iOS cannot install, so its guidance is "open in Safari"
   * — when in doubt, that is also the safe answer. */
  function iosVariant() {
    var u = ua();
    var other = /(CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|Instagram|FBAN|FBAV|FB_IAB|FBIOS|TikTok|musical_ly|Snapchat|Pinterest|LinkedInApp|MicroMessenger|Twitter)/i.test(u);
    if (!other && /Version\//.test(u) && /Safari\//.test(u)) return 'ios-safari';
    return 'ios-open';
  }

  function detectVariant() {
    if (isStandalone()) return 'standalone';
    if (isAndroid()) return deferredBIP ? 'android-install' : 'android-steps';
    if (isIOS()) return iosVariant();
    return 'desktop';
  }

  function otherSheetOpen() {
    try { return !!document.querySelector('.pf-sheet-bg'); } catch (e) { return false; }
  }
  function quizOpen() {
    try {
      var ov = document.getElementById('ob-overlay');
      return !!ov && !ov.hidden;
    } catch (e) { return false; }
  }

  var SHARE_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px" aria-hidden="true"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>';

  function stepsHtml(items) {
    var h = '<ol class="ip-steps">';
    for (var i = 0; i < items.length; i++) {
      h += '<li><span class="ip-num">' + (i + 1) + '</span><span>' + items[i] + '</span></li>';
    }
    return h + '</ol>';
  }

  function gotItRow() {
    return '<div class="pf-sheet-row" style="margin-top:12px"><button type="button" class="pf-sh-save" id="ip-ok" style="flex:1">Got it</button></div>';
  }

  function buildSheet(variant) {
    var inner;
    if (variant === 'android-install') {
      inner = '<div class="pf-sheet-row" style="margin-top:12px">' +
        '<button type="button" class="btn-ghost" id="ip-notnow" style="flex:1">Not now</button>' +
        '<button type="button" class="pf-sh-save" id="ip-install" style="flex:1">Install</button></div>';
    } else if (variant === 'android-steps') {
      inner = stepsHtml([
        'Tap <b>\u22ee</b> (the browser menu)',
        'Tap <b>\u201cAdd to Home screen\u201d</b> or <b>\u201cInstall app\u201d</b>',
        'Tap <b>Install</b> to confirm \u2014 the icon lands on your Home Screen.'
      ]) + gotItRow();
    } else if (variant === 'ios-safari') {
      inner = stepsHtml([
        'Tap the <b>Share</b> button ' + SHARE_SVG + ' in Safari\u2019s toolbar',
        'Tap <b>\u201cAdd to Home Screen\u201d</b>',
        'Tap <b>\u201cAdd\u201d</b> \u2014 the app icon lands on your Home Screen.'
      ]) + gotItRow();
    } else { /* ios-open */
      inner = '<p class="ap-body">You\u2019re viewing this inside another app\u2019s browser, where \u201cAdd to Home Screen\u201d isn\u2019t available. Open this page in Safari first:</p>' +
        stepsHtml([
          'Tap <b>\u22ef</b> or the <b>Share</b> button ' + SHARE_SVG,
          'Choose <b>\u201cOpen in Safari\u201d</b>',
          'Then <b>Share</b> \u2192 <b>Add to Home Screen</b>'
        ]) + gotItRow();
    }
    var bg = document.createElement('div');
    bg.className = 'pf-sheet-bg';
    bg.innerHTML = '<div class="pf-sheet" role="dialog" aria-modal="true" aria-label="Get the app on your Home Screen">' +
      '<div class="ip-head"><img class="ip-icon" src="icon-192.png" alt="" width="54" height="54">' +
      '<div><h4 style="margin:0">Get the app on your Home Screen</h4>' +
      '<p class="ap-body ip-benefit">One tap from your Home Screen, full-screen \u2014 no browser bars.</p></div></div>' +
      inner + '</div>';
    document.body.appendChild(bg);
    sheetEl = bg;
    var ok = bg.querySelector('#ip-ok');
    if (ok) ok.addEventListener('click', function () { closeSheet(); });
    var nn = bg.querySelector('#ip-notnow');
    if (nn) nn.addEventListener('click', function () { closeSheet(); });
    var inst = bg.querySelector('#ip-install');
    if (inst) inst.addEventListener('click', function () {
      var ev = deferredBIP;
      deferredBIP = null; /* a captured prompt can only be used once */
      closeSheet();
      if (!ev) return;
      try {
        var p = ev.prompt();
        if (p && p.then) p.then(function () {}, function () {});
        if (ev.userChoice && ev.userChoice.then) ev.userChoice.then(function () {}, function () {});
      } catch (e) {}
    });
    bg.addEventListener('click', function (e) { if (e.target === bg) closeSheet(); });
  }

  function closeSheet() {
    try {
      if (sheetEl && sheetEl.parentNode) sheetEl.parentNode.removeChild(sheetEl);
    } catch (e) {}
    sheetEl = null;
  }

  function openSheet() {
    if (sheetEl) return;
    var v = detectVariant();
    if (v === 'standalone' || v === 'desktop') return;
    buildSheet(v);
  }

  /* Automatic showing, at most once per device. If another sheet is
   * up when the moment comes, wait once and retry; if it is still
   * busy, stay silent \u2014 Settings keeps the manual route. */
  function tryAutoShow() {
    if (sheetEl) return;
    if (alreadyShown()) return;
    if (isStandalone() || detectVariant() === 'desktop') { markShown(); return; }
    if (quizOpen()) return;
    if (otherSheetOpen()) {
      if (retries < 1) {
        retries++;
        timer = setTimeout(function () { timer = null; try { tryAutoShow(); } catch (e) {} }, 3500);
      }
      return;
    }
    markShown(); /* shown once = consumed, whatever they tap */
    openSheet();
  }

  try {
    window.addEventListener('sr-quiz-finished', function (e) {
      try {
        if (!e || !e.detail || e.detail.mode !== 'auto') return;
        if (timer || sheetEl) return;
        retries = 0;
        timer = setTimeout(function () {
          timer = null;
          try { tryAutoShow(); } catch (err) {}
        }, 2000);
      } catch (err) {}
    });
  } catch (e) {}

  /* Manual route: Settings -> Add to Home Screen. Hidden entirely
   * when the app is already installed (standalone), and on desktop
   * where there is nothing useful to show. */
  try {
    var item = document.getElementById('menu-install');
    if (item) {
      if (isStandalone() || (!isIOS() && !isAndroid())) {
        item.hidden = true;
      } else {
        item.addEventListener('click', function () {
          var menu = document.getElementById('settings-menu');
          if (menu) menu.hidden = true;
          var gear = document.getElementById('btn-settings');
          if (gear) gear.setAttribute('aria-expanded', 'false');
          setTimeout(function () { try { openSheet(); } catch (err) {} }, 60);
        });
      }
    }
  } catch (e) {}
})();

/* ---- Usage counters (privacy-minimal) ------------------------------
 * Two of the three tallies live here ('landing' fires on the landing
 * page). This module POSTs to the relay Worker's /stats-hit, which
 * keeps ONE integer per event type per America/New_York day — no
 * identity, no device info, nothing per-user ever leaves the phone.
 *   'open' — the app opened, ONCE per browser session (a
 *            sessionStorage flag, so reloads and in-app navigation
 *            don't double count; a fresh visit counts again).
 *   'quiz' — the 5% Quiz COMPLETED on a first run. The onboarding
 *            block broadcasts 'sr-quiz-finished' with its mode; only
 *            mode 'auto' counts — Settings replays never do.
 * Every call is fire-and-forget and fails silently: counting must
 * never affect the app. */
(function srUsageStats() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  var STATS_URL = 'https://stock-research-relay.supplessayings-6e6.workers.dev/stats-hit';
  function hit(type) {
    try {
      fetch(STATS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type }),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }
  try {
    if (!sessionStorage.getItem('sr_stat_open')) {
      sessionStorage.setItem('sr_stat_open', '1');
      hit('open');
    }
  } catch (e) {}
  try {
    window.addEventListener('sr-quiz-finished', function (e) {
      try {
        if (e && e.detail && e.detail.mode === 'auto') hit('quiz');
      } catch (err) {}
    });
  } catch (e) {}
})();

/* Node export for offline pipeline tests (ignored in the browser). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseFinviz: parseFinviz, scoreStock: scoreStock, valueScreen: valueScreen, epsTrajectory: epsTrajectory, parseNum: parseNum, parseCapStr: parseCapStr, fetchStock: fetchStock, relayFetch: relayFetch, relayJSON: relayJSON, fillProjection: fillProjection, pjGrowths: pjGrowths, pjCaseEps: pjCaseEps, parseMBEarnings: parseMBEarnings, epsRecordStats: epsRecordStats, parseRevStr: parseRevStr, buildSwot: buildSwot, tickerSuggestions: tickerSuggestions, pfPaletteColors: pfPaletteColors, parseSAPeHistory: parseSAPeHistory, fetchPe5yAvg: fetchPe5yAvg };
}
