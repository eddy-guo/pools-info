import type { AnalyticsReader, SearchResult } from "@pools/core";

// Read-only snapshot adapter. Loaded on demand rather than embedding the
// entire transaction index in every page's initial HTML.
export class BrowserSnapshotSearch implements Pick<
  AnalyticsReader,
  "search" | "searchIndex"
> {
  private pending: Promise<SearchResult[]> | undefined;
  async searchIndex(): Promise<SearchResult[]> {
    this.pending ??= fetch("/data/search.json")
      .then(async (response) => {
        if (!response.ok) throw new Error("Search snapshot is unavailable");
        const rows: unknown = await response.json();
        if (!Array.isArray(rows)) throw new Error("Invalid search snapshot");
        return rows as SearchResult[];
      })
      .catch((error) => {
        this.pending = undefined;
        throw error;
      });
    return this.pending;
  }
  async search(query: string) {
    const q = query.trim().toLowerCase();
    return q
      ? (await this.searchIndex())
          .filter((r) => `${r.title} ${r.subtitle}`.toLowerCase().includes(q))
          .slice(0, 20)
      : [];
  }
}
export const snapshotSearch = new BrowserSnapshotSearch();
