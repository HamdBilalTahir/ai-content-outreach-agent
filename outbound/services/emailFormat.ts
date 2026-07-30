/**
 * Markdown → email formatter for outbound emails. Dependency-free by design.
 *
 * The agent composes bodies in Markdown (`**bold**`, `[text](url)`, bare URLs, `- ` lists). Sent as
 * plain text that renders literal `**`, and worse, Gmail's auto-linker swallows a trailing `**` into
 * the href and corrupts the link. So emails go out as `multipart/alternative`: a rendered HTML part
 * with real anchors, plus a clean plain-text fallback with the Markdown stripped and URLs intact.
 *
 * Kept minimal on purpose — the agent only uses bold, links, line breaks and simple bullets, so a
 * full Markdown dependency would be a large surface for no gain.
 */

/** Bare URL up to whitespace or a bracket. */
const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

/**
 * Trailing characters trimmed off a matched URL so they stay OUTSIDE the anchor. `*` is in the set
 * specifically so `**https://x**` does not put asterisks inside the href.
 */
const TRAILING = '*.,);:!?>”"\'';

const LINK_MD_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const BOLD_RE = /(?:\*\*|__)([\s\S]+?)(?:\*\*|__)/g;

/** Split a URL into `[cleanUrl, trailingPunctuation]`. */
function splitTrailing(url: string): [string, string] {
  let u = url;
  let trail = '';
  while (u && TRAILING.includes(u[u.length - 1])) {
    trail = u[u.length - 1] + trail;
    u = u.slice(0, -1);
  }
  return [u, trail];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Plain-text fallback: strip emphasis, turn `[t](u)` into `t (u)` so the URL survives, keep bare URLs
 * as-is, and collapse runs of 3+ blank lines to two.
 */
export function toText(body: string): string {
  if (!body) return '';
  let text = body.replace(LINK_MD_RE, (_m, label, url) => `${label} (${url})`);
  text = text.replace(BOLD_RE, (_m, inner) => String(inner));
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** Escape, then apply inline formatting (links, bare URLs, bold) to one text segment. */
function inlineHtml(segment: string): string {
  let out = escapeHtml(segment);

  // `[text](url)` → anchor. escapeHtml leaves brackets and parens alone, so the pattern still matches.
  out = out.replace(
    LINK_MD_RE,
    (_m, label, url) => `<a href="${escapeHtml(String(url))}">${label}</a>`
  );

  // Bare URLs → anchors, skipping anything already inside an anchor we just produced.
  const parts = out.split(/(<a [^>]*>.*?<\/a>)/);
  out = parts
    .map((p) =>
      p.startsWith('<a ')
        ? p
        : p.replace(URL_RE, (m) => {
            const [url, trail] = splitTrailing(m);
            return `<a href="${url}">${url}</a>${trail}`;
          })
    )
    .join('');

  // `**bold**` / `__bold__` → <strong>
  out = out.replace(BOLD_RE, (_m, inner) => `<strong>${inner}</strong>`);
  return out;
}

/**
 * Render the body to minimal, email-client-safe HTML.
 *
 * Inline styles only — email clients strip `<style>` blocks and have no useful CSS cascade. Paragraph
 * runs join with `<br>`; `- `/`* ` lines become a `<ul>`; a blank line flushes both.
 */
export function toHtml(body: string): string {
  const source = body ?? '';
  const lines = source.replace(/\r\n/g, '\n').split('\n');

  const blocks: string[] = [];
  let para: string[] = [];
  let ul: string[] = [];

  const flushPara = (): void => {
    if (para.length) {
      blocks.push(
        `<p style="margin:0 0 12px;">${para.map((l) => inlineHtml(l)).join('<br>')}</p>`
      );
      para = [];
    }
  };

  const flushUl = (): void => {
    if (ul.length) {
      const items = ul
        .map((i) => `<li style="margin:0 0 4px;">${inlineHtml(i)}</li>`)
        .join('');
      blocks.push(`<ul style="margin:0 0 12px 20px;padding:0;">${items}</ul>`);
      ul = [];
    }
  };

  for (const line of lines) {
    const s = line.trim();
    const m = /^[-*]\s+(.*)$/.exec(s);
    if (m) {
      flushPara();
      ul.push(m[1]);
    } else if (s === '') {
      flushUl();
      flushPara();
    } else {
      flushUl();
      para.push(line);
    }
  }
  flushUl();
  flushPara();

  return (
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
    'font-size:14px;line-height:1.5;color:#1a1a1a;">' +
    `${blocks.join('\n')}</div>`
  );
}
