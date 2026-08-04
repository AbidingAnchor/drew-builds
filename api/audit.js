import * as cheerio from 'cheerio';

// Helper function to fetch HTML content
async function fetchHTML(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      redirect: 'follow'
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch HTML: ${response.status}`);
    }
    
    return await response.text();
  } catch (error) {
    console.error('[audit] HTML fetch error:', error);
    throw error;
  }
}

// Extract visible text and links from HTML
function extractContent(html) {
  const $ = cheerio.load(html);
  
  // Remove script, style, noscript, and other non-content elements
  $('script, style, noscript, iframe, svg, head').remove();
  
  // Remove elements with display:none or visibility:hidden
  $('[style*="display:none"], [style*="display: none"], [style*="visibility:hidden"], [style*="visibility: hidden"]').remove();
  
  // Add spaces around block elements to prevent text concatenation
  $('p, div, h1, h2, h3, h4, h5, h6, li, span, a, button, strong, em, b, i').each((_, element) => {
    $(element).prepend(' ').append(' ');
  });
  
  // Get visible text from body only
  let visibleText = $('body').text()
    .replace(/\s+/g, ' ')  // Replace multiple whitespace with single space
    .replace(/([a-z])([A-Z])/g, '$1 $2')  // Add space between camelCase
    .replace(/([.!?])([A-Z])/g, '$1 $2')  // Add space after sentence endings
    .replace(/([a-z])([0-9])/g, '$1 $2')  // Add space between letters and numbers
    .replace(/([0-9])([a-z])/g, '$1 $2')  // Add space between numbers and letters
    .replace(/[^\x20-\x7E\n]/g, '')  // Remove non-ASCII characters that might cause encoding issues
    .replace(/\s+/g, ' ')  // Clean up any double spaces created
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

// Check for broken links with timeout
async function checkBrokenLinks(links, baseUrl) {
  const brokenLinks = [];
  const checkedUrls = new Set();
  const TIMEOUT_MS = 3000; // 3 second timeout per link
  
  for (const link of links) {
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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5'
        },
        redirect: 'follow',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (response.status === 404 || !response.ok) {
        brokenLinks.push({
          url: absoluteUrl,
          status: response.status,
          text: link.text
        });
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        // Skip timed out links rather than marking as broken
        console.log('[audit] Link check timeout for:', absoluteUrl);
        continue;
      }
      brokenLinks.push({
        url: absoluteUrl,
        status: 'FAILED',
        text: link.text,
        error: error.message
      });
    }
  }
  
  return brokenLinks;
}

// Call Google PageSpeed Insights API with timeout
async function getPageSpeedData(url) {
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
  
  const TIMEOUT_MS = 8000; // 8 seconds (enough for PageSpeed but not too long)
  
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

// Check spelling using Groq LLM instead of LanguageTool
async function checkSpelling(text) {
  console.log('[audit] checkSpelling called with text length:', text.length);
  
  try {
    const apiKey = (process.env.GROQ_API_KEY || '').trim();
    
    console.log('[audit] GROQ_API_KEY check:', !!apiKey, 'length:', apiKey.length);
    
    if (!apiKey) {
      console.error('[audit] GROQ_API_KEY is missing or empty. Check Vercel environment variables.');
      return { issues: [], error: 'API key not configured' };
    }
    
    const textToCheck = text.substring(0, 3000); // Limit text length for LLM
    
    console.log('[audit] Sending text to Groq for spelling check (first 500 chars):', textToCheck.substring(0, 500));
    console.log('[audit] Full text length:', text.length, 'Sending:', textToCheck.length);

    const TIMEOUT_MS = 8000; // 8 second timeout
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    
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
            content: 'You are a spelling checker for website content. Identify genuine spelling errors including typos, misspellings, and obvious mistakes. IMPORTANT: Check ALL text including navigation links, menu labels, headings, and short phrases - typos in these are still errors. EXCLUDE: brand/business names, proper nouns, foreign-language words (especially Spanish, common on menus), industry terms, local place names, and technical vocabulary. Be aggressive about flagging clear misspellings like "Appetizier" -> "Appetizers". Return real mistakes with the correct spelling. If no genuine errors found, return an empty list. Respond in JSON format: [{"word": "incorrect", "correct": "correct", "message": "brief explanation"}]'
          },
          {
            role: 'user',
            content: `Check this text for spelling errors:\n\n${textToCheck}`
          }
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`Groq API error: ${response.status}`);
    }
    
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    
    if (!content) {
      return { issues: [], error: 'No response from API' };
    }
    
    const parsedResponse = JSON.parse(content);
    const spellingErrors = parsedResponse.errors || [];
    
    // Format the response to match expected structure
    const issues = spellingErrors.map(error => ({
      word: error.word,
      message: error.message || 'Possible spelling error',
      suggestions: error.correct ? [error.correct] : [],
      offset: textToCheck.indexOf(error.word),
      length: error.word.length,
      type: 'TYPOS'
    }));
    
    return { issues, error: null };
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('[audit] Groq API timeout after', TIMEOUT_MS, 'ms');
      return { issues: [], error: 'Request timeout' };
    }
    console.error('[audit] Groq API error:', error);
    return { issues: [], error: error.message };
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
    
    // Run independent checks in parallel: HTML fetch and PageSpeed
    const [htmlResult, pageSpeedResult] = await Promise.allSettled([
      fetchHTML(url),
      getPageSpeedData(url)
    ]);
    
    // Extract HTML result
    let html, visibleText, links, htmlError;
    if (htmlResult.status === 'fulfilled') {
      try {
        html = htmlResult.value;
        const content = extractContent(html);
        visibleText = content.visibleText;
        links = content.links;
        htmlError = null;
      } catch (error) {
        console.error('[audit] HTML extraction failed:', error);
        htmlError = error.message;
        visibleText = '';
        links = [];
      }
    } else {
      console.error('[audit] HTML fetch failed:', htmlResult.reason);
      htmlError = htmlResult.reason?.message || 'Failed to fetch HTML';
      visibleText = '';
      links = [];
    }
    
    // Extract PageSpeed result
    let pageSpeed;
    if (pageSpeedResult.status === 'fulfilled') {
      pageSpeed = pageSpeedResult.value;
    } else {
      console.error('[audit] PageSpeed check failed:', pageSpeedResult.reason);
      pageSpeed = {
        mobileScore: null,
        loadTime: null,
        issues: [],
        error: pageSpeedResult.reason?.message || 'PageSpeed check failed'
      };
    }
    
    // Run dependent checks in parallel (only if HTML succeeded)
    let brokenLinks, linksError, spellingIssues, spellingError, technicalChecks;
    
    if (!htmlError && links.length > 0) {
      const [linksResult, spellingResult] = await Promise.allSettled([
        checkBrokenLinks(links, url), // Check all links for accuracy
        checkSpelling(visibleText)
      ]);
      
      // Extract link check result
      if (linksResult.status === 'fulfilled') {
        brokenLinks = linksResult.value;
        linksError = null;
      } else {
        console.error('[audit] Link check failed:', linksResult.reason);
        brokenLinks = [];
        linksError = linksResult.reason?.message || 'Link check failed';
      }
      
      // Extract spelling result
      if (spellingResult.status === 'fulfilled') {
        spellingIssues = spellingResult.value;
        spellingError = null;
      } else {
        console.error('[audit] Spelling check failed:', spellingResult.reason);
        spellingIssues = { issues: [], error: spellingResult.reason?.message || 'Spelling check failed' };
        spellingError = spellingResult.reason?.message || 'Spelling check failed';
      }
    } else {
      brokenLinks = [];
      linksError = htmlError || 'No content to check';
      spellingIssues = { issues: [], error: htmlError || 'No content to check' };
      spellingError = htmlError || 'No content to check';
    }
    
    // Perform technical checks (synchronous, no need for parallel)
    if (!htmlError && html) {
      try {
        technicalChecks = performTechnicalChecks(html, url);
      } catch (error) {
        console.error('[audit] Technical checks failed:', error);
        technicalChecks = {
          isHttps: url.startsWith('https://'),
          hasTelLink: false,
          hasViewport: false
        };
      }
    } else {
      technicalChecks = {
        isHttps: url.startsWith('https://'),
        hasTelLink: false,
        hasViewport: false
      };
    }
    
    const endTime = Date.now();
    const totalTime = endTime - startTime;
    console.log('[audit] Total audit time:', totalTime, 'ms');
    
    // Return structured response with partial data if some checks failed
    return res.status(200).json({
      brokenLinks: {
        count: brokenLinks.length,
        links: brokenLinks,
        error: linksError
      },
      pageSpeed: {
        mobileScore: pageSpeed.mobileScore,
        loadTime: pageSpeed.loadTime,
        issues: pageSpeed.issues,
        error: pageSpeed.error
      },
      spellingIssues: {
        count: spellingIssues.issues.length,
        issues: spellingIssues.issues,
        error: spellingError
      },
      technicalChecks: {
        isHttps: technicalChecks.isHttps,
        hasTelLink: technicalChecks.hasTelLink,
        hasViewport: technicalChecks.hasViewport
      },
      auditMeta: {
        url,
        timestamp: new Date().toISOString(),
        linksChecked: links.length,
        totalLinksFound: links.length,
        partialScan: !!htmlError,
        htmlError: htmlError,
        totalTime: totalTime
      }
    });
    
  } catch (error) {
    console.error('[audit] Audit error:', error);
    return res.status(500).json({
      error: error.message || 'Internal server error',
      code: 'AUDIT_INTERNAL_ERROR'
    });
  }
}