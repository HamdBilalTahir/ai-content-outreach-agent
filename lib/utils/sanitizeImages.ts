const BLOCKED_PATTERNS = [
  'logo',
  'icon',
  'avatar',
  'nav',
  'footer',
  'bg',
  'background',
  'spinner',
  'placeholder',
  'flag',
  'badge',
];

const BLOCKED_EXTENSIONS = ['.svg', '.gif', '.ico'];

export function sanitizeImages(urls: string[]): string[] {
  return urls
    .filter((url) => {
      if (url.length < 20) return false;
      if (!url.startsWith('http')) return false;

      const lower = url.toLowerCase();

      if (BLOCKED_EXTENSIONS.some((ext) => lower.includes(ext))) return false;
      if (BLOCKED_PATTERNS.some((p) => lower.includes(p))) return false;

      return true;
    })
    .slice(0, 10);
}
