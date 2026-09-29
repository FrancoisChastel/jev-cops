/** Column alignment. */
export type Align = "left" | "right";

/** Renders rows as a plain-text table with a header; widths fit the widest cell. */
export function renderTable(
  header: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
  align: readonly Align[] = [],
): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => (align[i] === "right" ? c.padStart(widths[i] ?? 0) : c.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)];
}
