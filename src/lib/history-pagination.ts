export const HISTORY_PAGE_SIZE = 25;

type HistoryHrefParams = {
  babyId?: string;
  type?: string;
  search?: string;
  cursor?: string;
};

export function historyHref({ babyId, type, search, cursor }: HistoryHrefParams) {
  const params = new URLSearchParams();
  if (babyId) params.set("babyId", babyId);
  if (type) params.set("type", type);
  if (search) params.set("search", search);
  if (cursor) params.set("cursor", cursor);

  const query = params.toString();
  return query ? `/app/history?${query}` : "/app/history";
}

export function paginateHistoryItems<T extends { id: string }>(items: T[]) {
  const pageItems = items.slice(0, HISTORY_PAGE_SIZE);
  return {
    items: pageItems,
    nextCursor: items.length > HISTORY_PAGE_SIZE ? pageItems.at(-1)?.id : undefined
  };
}

export function historyPageQuery(cursor?: string) {
  return {
    take: HISTORY_PAGE_SIZE + 1,
    orderBy: [{ occurredAt: "desc" as const }, { id: "desc" as const }],
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
  };
}
