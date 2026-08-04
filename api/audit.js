import * as cheerio from 'cheerio';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Vercel Hobby hard limit is 10s — stay under with margin for response serialization
const REQUEST_BUDGET_MS = 9000;
const BROWSER_RENDER_TIMEOUT_MS = 4000;
const PAGESPEED_TIMEOUT_MS = 6000;

const PAGESPEED_SKIPPED = {
  error: 'Unavailable for JS-rendered sites',
  mobileScore: null,
  loadTime: null,
  issues: []
};

class DeadlineError extends Error {
  constructor(message = 'Request deadline exceeded') {
    super(message);
    this.code = 'DEADLINE_EXCEEDED';
  }
}

function createDeadline(startTime, budgetMs = REQUEST_BUDGET_MS) {
  return {
    startTime,
    budgetMs,
    remaining() {
      return Math.max(0, budgetMs - (Date.now() - startTime));
    },
    expired() {
      return this.remaining() <= 0;
    },
    budgetFor(stepMs) {
      return Math.min(stepMs, this.remaining());
    },
    assertTime(label) {
      if (this.expired()) {
        throw new DeadlineError(`${label}: request deadline exceeded`);
      }
    }
  };
}

function createAuditContext(url) {
  return {
    url,
    html: null,
    visibleText: '',
    links: [],
    htmlError: null,
    renderMethod: 'fetch',
    renderWarning: null,
    pageSpeed: null,
    brokenLinks: [],
    unverifiedLinks: [],
    linksError: null,
    linksPartial: false,
    spellingIssues: { issues: [], error: null },
    spellingError: null,
    spellingPartial: false,
    technicalChecks: {
      isHttps: url.startsWith('https://'),
      hasTelLink: false,
      hasViewport: false
    },
    scanIncomplete: false,
    deadlineExceeded: false
  };
}

function buildAuditResponse(ctx, startTime) {
  const totalTime = Date.now() - startTime;
  const partialScan = !!ctx.htmlError || ctx.scanIncomplete || ctx.linksPartial || ctx.spellingPartial;
  const htmlError = ctx.htmlError || (ctx.deadlineExceeded ? 'Scan incomplete — time budget exceeded' : null);

  return {
    brokenLinks: {
      count: ctx.brokenLinks.length,
      links: ctx.brokenLinks,
      error: ctx.linksError
    },
    unverifiedLinks: {
      count: ctx.unverifiedLinks.length,
      links: ctx.unverifiedLinks
    },
    pageSpeed: {
      mobileScore: ctx.pageSpeed?.mobileScore ?? null,
      loadTime: ctx.pageSpeed?.loadTime ?? null,
      issues: ctx.pageSpeed?.issues ?? [],
      error: ctx.pageSpeed?.error ?? null
    },
    spellingIssues: {
      count: ctx.spellingIssues.issues?.length ?? 0,
      issues: ctx.spellingIssues.issues ?? [],
      error: ctx.spellingError
    },
    technicalChecks: ctx.technicalChecks,
    auditMeta: {
      url: ctx.url,
      timestamp: new Date().toISOString(),
      linksChecked: ctx.links.length,
      totalLinksFound: ctx.links.length,
      partialScan,
      scanIncomplete: ctx.scanIncomplete || ctx.deadlineExceeded,
      htmlError,
      renderMethod: ctx.renderMethod || 'fetch',
      renderWarning: ctx.renderWarning || null,
      deadlineExceeded: ctx.deadlineExceeded || false,
      totalTime
    }
  };
}

function getCharsetFromContentType(contentType) {
  const match = contentType?.match(/charset=([^;\s]+)/i);
  return match ? match[1].replace(/['"]/g, '') : 'utf-8';
}

// Helper function to fetch HTML content
async function fetchHTML(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      redirect: 'follow'
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch HTML: ${response.status}`);
    }
    
    const buffer = await response.arrayBuffer();
    const charset = getCharsetFromContentType(response.headers.get('content-type'));
    return new TextDecoder(charset).decode(buffer);
  } catch (error) {
    console.error('[audit] HTML fetch error:', error);
    throw error;
  }
}

// Extract visible text and links from HTML
function extractContent(html) {
  const $ = cheerio.load(html, { decodeEntities: true });
  
  // Remove script, style, noscript, and other non-content elements
  $('script, style, noscript, iframe, svg, head').remove();
  
  // Remove elements with display:none or visibility:hidden
  $('[style*="display:none"], [style*="display: none"], [style*="visibility:hidden"], [style*="visibility: hidden"]').remove();
  
  const blockSelector = 'p, h1, h2, h3, h4, h5, h6, li, td, th, figcaption, dt, dd, blockquote, label';
  const segments = [];
  
  // Collect text from leaf block elements to preserve boundaries between adjacent items
  $(blockSelector).each((_, el) => {
    if ($(el).find(blockSelector).length > 0) return;
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text) segments.push(text);
  });
  
  // Standalone nav/menu links not already inside a collected block
  $('a, button').each((_, el) => {
    const $el = $(el);
    if ($el.closest(blockSelector).length > 0) return;
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (text) segments.push(text);
  });
  
  let visibleText = segments
    .join('\n')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([.!?])([A-Z])/g, '$1 $2')
    .trim();
  
  // Extract all links
  const links = [];
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    const text = $(element).text().trim();
    if (href) {
      links.push({ url: href, text });
    }
  });
  
  return { visibleText, links };
}

// Detect plain fetches that likely need JS rendering (SPA shells, empty body, etc.)
function needsBrowserRender(html, { visibleText, links }) {
  const $ = cheerio.load(html, { decodeEntities: true });
  const metaCount = $('head meta').length;
  const bodyTextLen = visibleText.length;
  const linkCount = links.length;

  if (linkCount >= 3 && bodyTextLen >= 300) return false;
  if (bodyTextLen >= 600) return false;

  let suspiciousScore = 0;
  if (linkCount === 0) suspiciousScore += 2;
  else if (linkCount < 3 && bodyTextLen < 200) suspiciousScore += 1;

  if (metaCount === 0) suspiciousScore += 2;
  if (bodyTextLen < 100) suspiciousScore += 2;
  else if (bodyTextLen < 250) suspiciousScore += 1;

  const hasEmptySpaRoot = $('#root, #__next, #app').toArray().some((el) => {
    return $(el).text().replace(/\s+/g, '').length < 80;
  });
  if (hasEmptySpaRoot) suspiciousScore += 2;

  return suspiciousScore >= 3;
}

// Headless browser fallback for JS-rendered sites (Vercel serverless Chromium)
async function renderHTMLWithBrowser(url, timeoutMs = BROWSER_RENDER_TIMEOUT_MS) {
  const timeoutError = "Couldn't fully render this site";
  let browser = null;
  const browserBudget = Math.max(500, timeoutMs);

  const renderWork = async () => {
    const puppeteer = (await import('puppeteer-core')).default;
    const chromium = (await import('@sparticuz/chromium')).default;

    chromium.setGraphicsMode = false;

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 800 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);

    const gotoTimeout = Math.max(500, browserBudget - 800);
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: gotoTimeout
    });

    const hydrationTimeout = Math.min(800, Math.max(200, browserBudget - 1200));
    await page.waitForFunction(
      () => document.querySelectorAll('a[href]').length > 0 || (document.body?.innerText?.length ?? 0) > 200,
      { timeout: hydrationTimeout }
    ).catch(() => {});

    return page.content();
  };

  try {
    const html = await Promise.race([
      renderWork(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Render timeout')), browserBudget);
      })
    ]);
    return { html, error: null };
  } catch (error) {
    console.error('[audit] Browser render failed:', error.message);
    return { html: null, error: timeoutError };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// Browser fallback when plain HTML already fetched and looks like a JS shell
async function applyBrowserFallback(url, plainHtml, plainContent, deadline) {
  console.log('[audit] Plain HTML looks like a JS shell, attempting headless render (PageSpeed skipped)');
  const browserBudget = deadline.budgetFor(BROWSER_RENDER_TIMEOUT_MS);
  const { html: renderedHtml, error } = await renderHTMLWithBrowser(url, browserBudget);

  if (renderedHtml) {
    const renderedContent = extractContent(renderedHtml);
    if (
      renderedContent.links.length > plainContent.links.length ||
      renderedContent.visibleText.length > plainContent.visibleText.length
    ) {
      return {
        html: renderedHtml,
        visibleText: renderedContent.visibleText,
        links: renderedContent.links,
        renderMethod: 'browser',
        renderWarning: null
      };
    }
    return {
      html: plainHtml,
      visibleText: plainContent.visibleText,
      links: plainContent.links,
      renderMethod: 'fetch',
      renderWarning: 'Browser render did not improve content; using plain fetch'
    };
  }

  return {
    html: plainHtml,
    visibleText: plainContent.visibleText,
    links: plainContent.links,
    renderMethod: 'fetch',
    renderWarning: error
  };
}

const SOCIAL_MEDIA_BASES = [
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'tiktok.com',
  'youtube.com',
  'youtu.be'
];

function isSocialMediaUrl(urlString) {
  try {
    const hostname = new URL(urlString).hostname.toLowerCase();
    return SOCIAL_MEDIA_BASES.some(
      (base) => hostname === base || hostname.endsWith(`.${base}`)
    );
  } catch {
    return false;
  }
}

function classifyLinkCheckResult(absoluteUrl, response, link, brokenLinks, unverifiedLinks) {
  const isSocial = isSocialMediaUrl(absoluteUrl);

  if (response.ok) return;

  if (isSocial) {
    if (response.status === 404) {
      brokenLinks.push({ url: absoluteUrl, status: response.status, text: link.text });
      return;
    }
    if (!response.ok) {
      unverifiedLinks.push({
        url: absoluteUrl,
        status: response.status,
        text: link.text,
        reason: "Couldn't verify (site may be blocking automated checks)"
      });
    }
    return;
  }

  if (response.status === 404 || !response.ok) {
    brokenLinks.push({ url: absoluteUrl, status: response.status, text: link.text });
  }
}

// Check for broken links with timeout
async function checkBrokenLinks(links, baseUrl, deadline) {
  const brokenLinks = [];
  const unverifiedLinks = [];
  const checkedUrls = new Set();
  const TIMEOUT_MS = 2000;
  let partial = false;

  // Cap link checks so the overall audit stays within the Hobby-tier budget
  const MAX_LINKS_TO_CHECK = 30;
  const linksToCheck = links.slice(0, MAX_LINKS_TO_CHECK);
  if (links.length > MAX_LINKS_TO_CHECK) {
    partial = true;
  }
  
  for (const link of linksToCheck) {
    if (deadline?.expired()) {
      console.log('[audit] Link check stopped — request deadline reached');
      partial = true;
      break;
    }

    let absoluteUrl;
    
    // Convert relative URLs to absolute
    try {
      absoluteUrl = new URL(link.url, baseUrl).href;
    } catch {
      continue; // Skip invalid URLs
    }
    
    // Skip already checked URLs
    if (checkedUrls.has(absoluteUrl)) continue;
    checkedUrls.add(absoluteUrl);
    
    // Skip non-http(s) links (mailto:, tel:, javascript:, etc.)
    if (!absoluteUrl.startsWith('http://') && !absoluteUrl.startsWith('https://')) continue;
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
      
      const response = await fetch(absoluteUrl, {
        method: 'HEAD',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5'
        },
        redirect: 'follow',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      classifyLinkCheckResult(absoluteUrl, response, link, brokenLinks, unverifiedLinks);
    } catch (error) {
      if (error.name === 'AbortError') {
        // Skip timed out links rather than marking as broken
        console.log('[audit] Link check timeout for:', absoluteUrl);
        continue;
      }
      if (isSocialMediaUrl(absoluteUrl)) {
        unverifiedLinks.push({
          url: absoluteUrl,
          status: 'UNVERIFIED',
          text: link.text,
          reason: "Couldn't verify (site may be blocking automated checks)"
        });
      } else {
        brokenLinks.push({
          url: absoluteUrl,
          status: 'FAILED',
          text: link.text,
          error: error.message
        });
      }
    }
  }
  
  return { brokenLinks, unverifiedLinks, partial };
}

// Call Google PageSpeed Insights API with timeout
async function getPageSpeedData(url, timeoutMs = PAGESPEED_TIMEOUT_MS) {
  const apiKey = process.env.GOOGLE_PAGESPEED_API_KEY;
  
  console.log('[audit] PageSpeed API key check:', {
    hasKey: !!apiKey,
    keyLength: apiKey?.length,
    keyPreview: apiKey ? `${apiKey.substring(0, 8)}...` : 'none',
    allEnvKeys: Object.keys(process.env).filter(k => k.includes('PAGE') || k.includes('SPEED') || k.includes('GOOGLE'))
  });
  
  if (!apiKey) {
    console.warn('[audit] GOOGLE_PAGESPEED_API_KEY not configured');
    return {
      error: 'API key not configured',
      mobileScore: null,
      loadTime: null,
      issues: []
    };
  }
  
  const TIMEOUT_MS = Math.max(500, timeoutMs);
  
  console.log('[audit] PageSpeed API call starting for:', url, 'with timeout:', TIMEOUT_MS, 'ms');
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    
    const response = await fetch(
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&key=${apiKey}&strategy=mobile`,
      { signal: controller.signal }
    );
    
    clearTimeout(timeoutId);
    
    console.log('[audit] PageSpeed API response status:', response.status);
    
    if (!response.ok) {
      console.error('[audit] PageSpeed API error response:', response.status, response.statusText);
      throw new Error(`PageSpeed API error: ${response.status} - ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // Extract mobile score
    const mobileScore = data.lighthouseResult?.categories?.performance?.score * 100 || null;
    
    // Extract load time
    const loadTime = data.lighthouseResult?.audits?.['interactive']?.numericValue || null;
    
    // Extract performance issues
    const issues = [];
    const audits = data.lighthouseResult?.audits || {};
    
    for (const [key, audit] of Object.entries(audits)) {
      if (audit.score === 0 && audit.details) {
        issues.push({
          id: key,
          title: audit.title,
          description: audit.description,
          displayValue: audit.displayValue
        });
      }
    }
    
    return {
      mobileScore,
      loadTime: loadTime ? Math.round(loadTime / 1000) : null, // Convert to seconds
      issues: issues.slice(0, 10) // Limit to top 10 issues
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('[audit] PageSpeed API timeout after', TIMEOUT_MS, 'ms');
      return {
        error: 'Request timeout (PageSpeed API slow)',
        mobileScore: null,
        loadTime: null,
        issues: []
      };
    }
    console.error('[audit] PageSpeed API error:', error);
    return {
      error: error.message,
      mobileScore: null,
      loadTime: null,
      issues: []
    };
  }
}

// Perform technical checks
function performTechnicalChecks(html, url) {
  const $ = cheerio.load(html);
  
  // Check HTTPS
  const isHttps = url.startsWith('https://');
  
  // Check for tel: links
  const hasTelLink = $('a[href^="tel:"]').length > 0;
  
  // Check for viewport meta tag
  const hasViewport = $('meta[name="viewport"]').length > 0;
  
  return {
    isHttps,
    hasTelLink,
    hasViewport
  };
}

function truncateAtWordBoundary(text, maxLength) {
  if (text.length <= maxLength) return text;
  const slice = text.substring(0, maxLength);
  const lastBreak = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
  return lastBreak > 0 ? slice.substring(0, lastBreak) : slice;
}

// Check spelling using two-pass system: LanguageTool + Groq classification
async function checkSpelling(text, deadline) {
  try {
    const apiKey = (process.env.GROQ_API_KEY || '').trim();
    
    if (!apiKey) {
      console.error('[audit] GROQ_API_KEY is missing or empty. Check Vercel environment variables.');
      return { issues: [], error: 'API key not configured', partial: false };
    }
    
    if (deadline?.expired()) {
      return { issues: [], error: 'Spelling check incomplete — time budget reached', partial: true };
    }
    
    const textToCheck = truncateAtWordBoundary(text, 3000);
    
    // PASS 1: Get LanguageTool candidates
    const languageToolIssues = await getLanguageToolCandidates(textToCheck);
    console.log('[audit] LanguageTool candidates found:', languageToolIssues.length);
    
    if (languageToolIssues.length === 0) {
      return { issues: [], error: null, partial: false };
    }
    
    console.log('[audit] LanguageTool candidates:', languageToolIssues.map(i => i.word));
    
    // PASS 2: Filter with Groq classification (Groq's contextual judgment handles duplicates)
    const { typos: validTypos, partial } = await filterWithGroq(languageToolIssues, textToCheck, deadline);
    console.log('[audit] Groq-confirmed typos:', validTypos.length);
    console.log('[audit] Groq-confirmed words:', validTypos.map(i => i.word));
    
    // Deduplicate by word (case-insensitive) — one report per unique typo, not a frequency filter
    const seenWords = new Set();
    const deduplicatedTypos = validTypos.filter(issue => {
      const lowerWord = issue.word.toLowerCase();
      if (seenWords.has(lowerWord)) {
        return false;
      }
      seenWords.add(lowerWord);
      return true;
    });
    
    // Format the response
    const issues = deduplicatedTypos.map(issue => ({
      word: issue.word,
      message: 'Possible spelling error',
      suggestions: issue.suggestions || [],
      offset: issue.offset,
      length: issue.length,
      type: 'TYPOS'
    }));
    
    return {
      issues,
      error: partial ? 'Spelling check incomplete — time budget reached' : null,
      partial
    };
  } catch (error) {
    console.error('[audit] Spelling check error:', error);
    return { issues: [], error: error.message, partial: false };
  }
}

// Get LanguageTool candidates (PASS 1)
async function getLanguageToolCandidates(text) {
  try {
    const TIMEOUT_MS = 5000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    
    const response = await fetch('https://api.languagetool.org/v2/check', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        text: text,
        language: 'auto', // Auto-detect for bilingual content
        enabledOnly: 'false'
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`LanguageTool API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    const issues = data.matches?.map(match => {
      let word = 'unknown';
      const start = match.offset || 0;
      const end = start + (match.length || 0);
      
      if (start >= 0 && end <= text.length) {
        word = text.substring(start, end);
      }
      
      return {
        word: word,
        suggestions: match.replacements?.slice(0, 3).map(r => r.value) || [],
        offset: match.offset,
        length: match.length,
        context: getContext(text, match.offset, match.length)
      };
    }) || [];
    
    return issues;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('[audit] LanguageTool timeout');
      return [];
    }
    console.error('[audit] LanguageTool error:', error);
    return [];
  }
}

// Get surrounding context for a word
function getContext(text, offset, length) {
  const start = Math.max(0, offset - 50);
  const end = Math.min(text.length, offset + length + 50);
  return text.substring(start, end);
}

// Filter LanguageTool candidates with Groq (PASS 2)
async function filterWithGroq(candidates, fullText, deadline) {
  const validTypos = [];
  let partial = false;
  
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  
  console.log('[audit] filterWithGroq called with', candidates.length, 'candidates and apiKey:', !!apiKey);
  
  for (const candidate of candidates) {
    if (deadline?.expired()) {
      console.log('[audit] Groq classification stopped — request deadline reached');
      partial = true;
      break;
    }

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content: 'You are a spelling classifier. Determine if a word is a genuine misspelling. Context: "Appetizier" appears twice (nav + header) but is still a typo. "Cheese Cheese" repeated in one context is likely a copy-paste error. Answer YES if genuine spelling error/typo, NO if proper noun, brand/business name, foreign-language word (especially Spanish), industry term, or acceptable abbreviation. Consider context - words repeated in different page sections (nav + content) might be intentional menu names, but repeated within the same text block suggests a typo. Answer ONLY "YES" or "NO".'
            },
            {
              role: 'user',
              content: `Context: "${candidate.context}"\nWord: "${candidate.word}"\n\nIs this a genuine spelling error? Answer YES or NO.`
            }
          ],
          temperature: 0.1,
          max_tokens: 10
        })
      });
      
      if (!response.ok) {
        console.error('[audit] Groq classification error for:', candidate.word);
        continue;
      }
      
      const data = await response.json();
      const answer = data.choices?.[0]?.message?.content?.trim().toUpperCase();
      
      console.log('[audit] Groq classification for', candidate.word, ':', answer);
      
      if (answer === 'YES') {
        validTypos.push(candidate);
      }
    } catch (error) {
      console.error('[audit] Error classifying word:', candidate.word, error);
    }
  }
  
  return { typos: validTypos, partial };
}

async function runAudit(url, deadline, ctx) {
  const plainHtml = await fetchHTML(url);
  deadline.assertTime('after plain fetch');

  const plainContent = extractContent(plainHtml);
  const willUseBrowser = needsBrowserRender(plainHtml, plainContent);

  let pageContent;
  if (willUseBrowser) {
    ctx.pageSpeed = PAGESPEED_SKIPPED;
    console.log('[audit] Skipping PageSpeed — JS shell detected, saving budget for browser render');
    pageContent = await applyBrowserFallback(url, plainHtml, plainContent, deadline);
  } else {
    const pageSpeedBudget = deadline.budgetFor(PAGESPEED_TIMEOUT_MS);
    ctx.pageSpeed = await getPageSpeedData(url, pageSpeedBudget);
    pageContent = {
      html: plainHtml,
      visibleText: plainContent.visibleText,
      links: plainContent.links,
      renderMethod: 'fetch',
      renderWarning: null
    };
  }
  deadline.assertTime('after page content');

  ctx.html = pageContent.html;
  ctx.visibleText = pageContent.visibleText;
  ctx.links = pageContent.links;
  ctx.renderMethod = pageContent.renderMethod;
  ctx.renderWarning = pageContent.renderWarning;
  ctx.htmlError = null;

  if (!ctx.html) {
    throw new Error('No HTML content retrieved');
  }

  if (ctx.visibleText.length > 50 || ctx.links.length > 0) {
    deadline.assertTime('before dependent checks');

    const [linksResult, spellingResult] = await Promise.allSettled([
      checkBrokenLinks(ctx.links, url, deadline),
      checkSpelling(ctx.visibleText, deadline)
    ]);

    if (linksResult.status === 'fulfilled') {
      ctx.brokenLinks = linksResult.value.brokenLinks;
      ctx.unverifiedLinks = linksResult.value.unverifiedLinks;
      ctx.linksPartial = linksResult.value.partial;
      ctx.linksError = linksResult.value.partial ? 'Link check incomplete — time budget reached' : null;
    } else {
      console.error('[audit] Link check failed:', linksResult.reason);
      ctx.brokenLinks = [];
      ctx.unverifiedLinks = [];
      ctx.linksError = linksResult.reason?.message || 'Link check failed';
    }

    if (spellingResult.status === 'fulfilled') {
      const spellingValue = spellingResult.value;
      ctx.spellingIssues = { issues: spellingValue.issues, error: null };
      ctx.spellingPartial = spellingValue.partial || false;
      ctx.spellingError = spellingValue.partial ? 'Spelling check incomplete — time budget reached' : null;
    } else {
      console.error('[audit] Spelling check failed:', spellingResult.reason);
      ctx.spellingIssues = { issues: [], error: spellingResult.reason?.message || 'Spelling check failed' };
      ctx.spellingError = spellingResult.reason?.message || 'Spelling check failed';
    }
  } else {
    ctx.linksError = 'No content to check';
    ctx.spellingIssues = { issues: [], error: 'No content to check' };
    ctx.spellingError = 'No content to check';
  }

  try {
    ctx.technicalChecks = performTechnicalChecks(ctx.html, url);
  } catch (error) {
    console.error('[audit] Technical checks failed:', error);
    ctx.technicalChecks = {
      isHttps: url.startsWith('https://'),
      hasTelLink: false,
      hasViewport: false
    };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const { url } = req.body || {};
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  
  // Validate URL format
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }
  
  try {
    const startTime = Date.now();
    const deadline = createDeadline(startTime);
    const ctx = createAuditContext(url);
    let responded = false;

    const respond = (statusCode, body) => {
      if (responded) return;
      responded = true;
      return res.status(statusCode).json(body);
    };

    const safetyTimer = setTimeout(() => {
      console.error('[audit] Request deadline safety net triggered');
      ctx.scanIncomplete = true;
      ctx.deadlineExceeded = true;
      respond(200, buildAuditResponse(ctx, startTime));
    }, REQUEST_BUDGET_MS);

    try {
      await runAudit(url, deadline, ctx);
      clearTimeout(safetyTimer);
      if (!responded) {
        console.log('[audit] Total audit time:', Date.now() - startTime, 'ms');
        respond(200, buildAuditResponse(ctx, startTime));
      }
    } catch (error) {
      clearTimeout(safetyTimer);
      if (responded) return;

      if (error.code === 'DEADLINE_EXCEEDED') {
        ctx.scanIncomplete = true;
        ctx.deadlineExceeded = true;
        respond(200, buildAuditResponse(ctx, startTime));
        return;
      }

      ctx.htmlError = error.message;
      ctx.scanIncomplete = true;
      respond(200, buildAuditResponse(ctx, startTime));
    }
    
  } catch (error) {
    console.error('[audit] Audit error:', error);
    return res.status(500).json({
      error: error.message || 'Internal server error',
      code: 'AUDIT_INTERNAL_ERROR'
    });
  }
}