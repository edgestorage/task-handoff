const Segmenter = (Intl as typeof Intl & {
  Segmenter?: new (locale?: string | string[], options?: { granularity: 'grapheme' }) => {
    segment(input: string): Iterable<{ segment: string }>;
  };
}).Segmenter;

const graphemeSegmenter = Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : undefined;

export function splitGraphemes(value: string) {
  return graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(value), (entry) => entry.segment)
    : Array.from(value);
}
