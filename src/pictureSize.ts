// Photos of about 12 MP keep small label text legible without the delay of 50 MP captures.
const MAX_PICTURE_PIXELS = 13_000_000;

export function pictureSizeFor(sizes: readonly string[]): string | undefined {
  const parsed = sizes
    .map(size => {
      const match = /^(\d+)x(\d+)$/.exec(size);
      return { size, width: Number(match?.[1] ?? 0), height: Number(match?.[2] ?? 0) };
    })
    .filter(item => item.width > 0 && item.height > 0 && item.width * item.height <= MAX_PICTURE_PIXELS);
  const fourThree = parsed.filter(item => Math.abs(Math.max(item.width, item.height) / Math.min(item.width, item.height) - 4 / 3) < 0.05);
  const candidates = fourThree.length ? fourThree : parsed;
  return [...candidates].sort((left, right) => right.width * right.height - left.width * left.height)[0]?.size;
}
