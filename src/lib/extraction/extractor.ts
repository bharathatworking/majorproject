import { Readability } from '@mozilla/readability';
import DOMPurify from 'dompurify';
import type { ExtractedArticle } from '../../types';
import { sha256 } from '../utils/hash';

export function stripNoise(doc: Document): void {
  const noiseSelectors = [
    'nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', 'iframe', 'ins',
    '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
  ];
  doc.querySelectorAll(noiseSelectors.join(', ')).forEach(n => n.remove());

  // Remove hidden elements using inline-style checks only.
  // window.getComputedStyle() requires a live, laid-out document — it returns
  // default values on cloned nodes and is therefore useless here. Inline styles
  // and aria-hidden are reliable across both live and cloned documents.
  doc.querySelectorAll('*').forEach(el => {
    if (!(el instanceof HTMLElement)) return;
    if (
      el.getAttribute('aria-hidden') === 'true' ||
      el.style.display === 'none' ||
      el.style.visibility === 'hidden'
    ) {
      el.remove();
    }
  });
}

/**
 * Arc90-style fallback: score blocks by text density and pick the winner.
 * Receives the already-noise-stripped clone so we don't re-query the live DOM.
 */
function fallbackExtract(
  strippedClone: Document,
): { title: string; content: string; textContent: string } {
  let maxScore = 0;
  let bestNode: Element | null = null;

  // Query the noise-stripped clone, not the live document or a fresh clone.
  strippedClone.querySelectorAll('p, div, article, section').forEach(block => {
    const text = block.textContent || '';
    if (text.length < 50) return;
    let linkTextLength = 0;
    block.querySelectorAll('a').forEach(a => linkTextLength += (a.textContent || '').length);
    const score = text.length - linkTextLength * 2;
    if (score > maxScore) {
      maxScore = score;
      bestNode = block;
    }
  });

  const title = strippedClone.title || 'Extracted Article';
  if (!bestNode) return { title, content: '', textContent: '' };
  return {
    title,
    content: (bestNode as Element).innerHTML,
    textContent: (bestNode as Element).textContent || '',
  };
}

export async function extractArticle(doc: Document): Promise<ExtractedArticle> {
  // Clone once, strip noise on the clone — never mutate the live page.
  const clone = doc.cloneNode(true) as Document;
  stripNoise(clone);

  let parsed: ReturnType<Readability['parse']> = null;
  try {
    parsed = new Readability(clone).parse();
  } catch (e) {
    console.warn('[Clarity] Readability failed, using fallback', e);
  }

  let title: string;
  let content: string;
  let textContent: string;
  let excerpt: string | null = null;
  let byline: string | null = null;
  let siteName: string | null = null;

  if (parsed) {
    title = parsed.title ?? doc.title ?? 'Untitled';
    content = parsed.content ?? '';
    textContent = parsed.textContent ?? '';
    excerpt = parsed.excerpt ?? null;
    byline = parsed.byline ?? null;
    siteName = parsed.siteName ?? null;
  } else {
    // Pass the already-stripped clone — fallbackExtract must not re-query the
    // live DOM or create another clone.
    const fb = fallbackExtract(clone);
    title = fb.title;
    content = fb.content;
    textContent = fb.textContent;
  }

  const cleanContent = DOMPurify.sanitize(content);
  const contentHash = await sha256(textContent);

  return { title, byline, content: cleanContent, textContent, excerpt, siteName, contentHash };
}
