// ISO-3166 alpha-2 country code -> regional indicator flag emoji.
export function countryCodeToFlag(code: string): string {
  if (!code || code.length !== 2) return '🏳️';
  const upper = code.toUpperCase();
  const A = 0x41; // 'A'
  const base = 0x1f1e6; // regional indicator A
  const codePoints = [
    base + (upper.charCodeAt(0) - A),
    base + (upper.charCodeAt(1) - A),
  ];
  return String.fromCodePoint(...codePoints);
}
