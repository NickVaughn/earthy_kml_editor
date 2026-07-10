let counter = 0;

/** Monotonic internal node id (not the KML id attribute). */
export function nextId(): string {
  return `n${(++counter).toString(36)}`;
}
