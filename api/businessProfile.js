import { groqCompletion } from '../lib/groq.js';
import * as cheerio from 'cheerio';

const VALID_CATEGORIES = new Set(['restaurant', 'wellness', 'none']);

const US_PHONE_RE = /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})\b/g;

const STREET_ADDRESS_RE = /\b(\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9.'-]+(?:\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Hwy|Highway|Cir|Circle))\.?(?:\s+(?:Ste|Suite|Unit|#)\.?\s*[A-Za-z0-9-]+)?)\b/i;

const CITY_STATE_ZIP_RE = /\b([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/;

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanBusinessName(value) {
  const name = cleanText(value)
    .replace(/\s*[|\-–—]\s*.+$/, '')
    .replace(/\s+(Home|Welcome|Official Site|Official Website)$/i, '')
    .trim();
  return name.length >= 2 && name.length <= 80 ? name : null;
}

function formatPhone(match) {
  const [, area, prefix, line] = match;
  return `(${area}) ${prefix}-${line}`;
}

function normalizePhoneDigits(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits.length === 10 ? digits : null;
}

function collectJsonLdNodes(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.flatMap(collectJsonLdNodes);
  if (raw['@graph']) return collectJsonLdNodes(raw['@graph']);
  return [raw];
}

function findJsonLd(html) {
  const $ = cheerio.load(html, { decodeEntities: true });
  const nodes = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      nodes.push(...collectJsonLdNodes(JSON.parse($(el).text())));
    } catch {
      // ignore invalid JSON-LD blocks
    }
  });

  return nodes;
}

function isLocalBusinessType(typeValue) {
  const types = Array.isArray(typeValue) ? typeValue : [typeValue];
  return types.some((type) => /LocalBusiness|Restaurant|FoodEstablishment|HealthAndBeautyBusiness|DaySpa|ExerciseGym|MedicalBusiness|Organization/i.test(String(type)));
}

function extractPhoneFromHtml(html, visibleText) {
  const $ = cheerio.load(html, { decodeEntities: true });

  for (const node of findJsonLd(html)) {
    const tel = node.telephone || node.phone;
    if (tel) {
      const digits = normalizePhoneDigits(tel);
      if (digits) {
        return formatPhone([null, digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)]);
      }
    }
  }

  const telHref = $('a[href^="tel:"]').first().attr('href');
  if (telHref) {
    const digits = normalizePhoneDigits(telHref.replace(/^tel:/i, ''));
    if (digits) {
      return formatPhone([null, digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)]);
    }
  }

  const sources = [visibleText, $('body').text()];
  for (const source of sources) {
    US_PHONE_RE.lastIndex = 0;
    const match = US_PHONE_RE.exec(source);
    if (match) return formatPhone(match);
  }

  return null;
}

function formatPostalAddress(address) {
  if (!address) return null;
  if (typeof address === 'string') return cleanText(address);

  const parts = [
    address.streetAddress,
    address.addressLocality,
    address.addressRegion,
    address.postalCode
  ].map(cleanText).filter(Boolean);

  if (parts.length >= 2) {
    const street = parts[0];
    const city = parts[1];
    const state = parts[2] || '';
    const zip = parts[3] || '';
    const cityLine = [city, state].filter(Boolean).join(', ');
    return cleanText(`${street}, ${cityLine}${zip ? ` ${zip}` : ''}`);
  }

  return null;
}

function extractAddressFromHtml(html, visibleText) {
  for (const node of findJsonLd(html)) {
    if (node.address) {
      const formatted = formatPostalAddress(node.address);
      if (formatted) return formatted;
    }
  }

  const lines = visibleText.split('\n').map(cleanText).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const streetMatch = lines[i].match(STREET_ADDRESS_RE);
    const cityMatch = lines[i].match(CITY_STATE_ZIP_RE) || lines[i + 1]?.match(CITY_STATE_ZIP_RE);

    if (streetMatch && cityMatch) {
      return cleanText(`${streetMatch[1]}, ${cityMatch[1]}, ${cityMatch[2]} ${cityMatch[3]}`);
    }

    if (cityMatch && streetMatch) {
      return cleanText(`${streetMatch[1]}, ${cityMatch[1]}, ${cityMatch[2]} ${cityMatch[3]}`);
    }
  }

  for (const line of lines) {
    const combined = line.match(
      new RegExp(`${STREET_ADDRESS_RE.source}\\s*,\\s*${CITY_STATE_ZIP_RE.source}`, 'i')
    );
    if (combined) {
      return cleanText(line);
    }

    const cityOnly = line.match(CITY_STATE_ZIP_RE);
    if (cityOnly && line.length < 120) {
      const prev = lines[lines.indexOf(line) - 1];
      if (prev && STREET_ADDRESS_RE.test(prev)) {
        return cleanText(`${prev}, ${cityOnly[1]}, ${cityOnly[2]} ${cityOnly[3]}`);
      }
    }
  }

  return null;
}

function extractBusinessName(html, visibleText, url) {
  const $ = cheerio.load(html, { decodeEntities: true });

  for (const node of findJsonLd(html)) {
    if (node.name && isLocalBusinessType(node['@type'])) {
      const name = cleanBusinessName(node.name);
      if (name) return name;
    }
  }

  for (const node of findJsonLd(html)) {
    if (node.name) {
      const name = cleanBusinessName(node.name);
      if (name) return name;
    }
  }

  const ogSiteName = cleanBusinessName($('meta[property="og:site_name"]').attr('content'));
  if (ogSiteName) return ogSiteName;

  const titleName = cleanBusinessName($('title').text());
  if (titleName) return titleName;

  const h1Name = cleanBusinessName($('h1').first().text());
  if (h1Name) return h1Name;

  const firstLine = cleanBusinessName(visibleText.split('\n')[0]);
  if (firstLine && firstLine.length <= 60) return firstLine;

  try {
    const slug = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
    if (slug && slug !== 'localhost') {
      return slug
        .split('-')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
    }
  } catch {
    // ignore invalid URL
  }

  return null;
}

export function extractBusinessInfo({ html, visibleText, url }) {
  const businessName = extractBusinessName(html, visibleText, url);
  const phone = extractPhoneFromHtml(html, visibleText);
  const address = extractAddressFromHtml(html, visibleText);

  return {
    businessName,
    phone,
    address
  };
}

function parseCategoryAnswer(raw) {
  const answer = cleanText(raw).toLowerCase().replace(/[^a-z]/g, '');

  if (answer === 'restaurant') return 'restaurant';
  if (answer === 'wellness') return 'wellness';
  if (answer === 'none') return 'none';

  if (raw.toLowerCase().includes('restaurant')) return 'restaurant';
  if (raw.toLowerCase().includes('wellness')) return 'wellness';
  return 'none';
}

export async function classifyBusinessCategory(visibleText, apiKey) {
  if (!apiKey) {
    return { category: 'none', error: 'API key not configured' };
  }

  const sample = cleanText(visibleText).slice(0, 2500);
  if (sample.length < 40) {
    return { category: 'none', error: 'Not enough content to classify' };
  }

  try {
    const { response } = await groqCompletion(apiKey, {
      messages: [
        {
          role: 'system',
          content:
            'You classify small-business websites into exactly one category. Reply with ONLY one word: restaurant, wellness, or none. restaurant = food service businesses (restaurants, cafes, pizzerias, bars/pubs with food, catering, bakeries). wellness = health and wellness (spas, yoga/pilates studios, gyms/fitness, massage, therapy, mental health, salons focused on wellness). none = anything else, mixed/unclear businesses, casinos, retail, churches, law firms, or insufficient evidence.'
        },
        {
          role: 'user',
          content: `Classify this business based on its website text:\n\n${sample}`
        }
      ],
      temperature: 0,
      max_completion_tokens: 1024
    });

    if (!response.ok) {
      return { category: 'none', error: `Groq classification failed (${response.status})` };
    }

    const data = await response.json();
    const rawAnswer = data.choices?.[0]?.message?.content || '';
    const category = parseCategoryAnswer(rawAnswer);

    if (!VALID_CATEGORIES.has(category)) {
      return { category: 'none', error: 'Unrecognized classification response' };
    }

    return { category, rawAnswer: cleanText(rawAnswer) };
  } catch (error) {
    return { category: 'none', error: error.message };
  }
}

export async function buildBusinessProfile({ html, visibleText, url, apiKey }) {
  const info = extractBusinessInfo({ html, visibleText, url });
  const classification = await classifyBusinessCategory(visibleText, apiKey);

  return {
    category: classification.category,
    businessName: info.businessName,
    phone: info.phone,
    address: info.address,
    classificationError: classification.error || null,
    classificationRaw: classification.rawAnswer || null
  };
}
