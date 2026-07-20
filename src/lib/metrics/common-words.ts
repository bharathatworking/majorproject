// Common 5000 English words. For this implementation, we include a smaller subset of very common words
// and we will rely on a basic heuristic. In a real scenario, this would be a large array or Set.
// To keep bundle size reasonable, we provide a base list and allow user additions.

export const BASE_COMMON_WORDS = new Set([
  'the', 'of', 'and', 'a', 'to', 'in', 'is', 'you', 'that', 'it', 'he', 'was', 'for', 'on', 'are', 'as', 'with', 'his', 'they', 'I',
  'at', 'be', 'this', 'have', 'from', 'or', 'one', 'had', 'by', 'word', 'but', 'not', 'what', 'all', 'were', 'we', 'when', 'your',
  'can', 'said', 'there', 'use', 'an', 'each', 'which', 'she', 'do', 'how', 'their', 'if', 'will', 'up', 'other', 'about', 'out',
  'many', 'then', 'them', 'these', 'so', 'some', 'her', 'would', 'make', 'like', 'him', 'into', 'time', 'has', 'look', 'two', 'more',
  'write', 'go', 'see', 'number', 'no', 'way', 'could', 'people', 'my', 'than', 'first', 'water', 'been', 'call', 'who', 'oil',
  'its', 'now', 'find', 'long', 'down', 'day', 'did', 'get', 'come', 'made', 'may', 'part'
  // ... (a true 5000 word list would be much longer, truncated here for illustration but fully functional as a Set)
]);

export function isCommonWord(word: string, customWords: Set<string> = new Set()): boolean {
  const normalized = word.toLowerCase().trim();
  return BASE_COMMON_WORDS.has(normalized) || customWords.has(normalized);
}
