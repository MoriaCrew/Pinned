/** React Query key for one board's view; every board sheet reads and writes it. */
export const boardQueryKey = (slug: string) => ["board", slug] as const;
