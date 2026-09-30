import type { Block, Document, Inline, MarginBand } from "./ir.js";

type Image = { src: string };

/**
 * Rewrites every image source in place. Returning `null` removes the image,
 * e.g. when the asset could not be resolved.
 */
export function mapImages(doc: Document, fn: (src: string) => string | null): void {
  doc.children = mapBlocks(doc.children, fn);
  const page = doc.page;
  if (!page) return;
  if (page.foreground) page.foreground = mapBlocks(page.foreground, fn);
  for (const band of [page.header, page.footer]) {
    for (const box of Object.values(band ?? {})) {
      if (box?.blocks) box.blocks = mapBlocks(box.blocks, fn);
      if (box?.inlines) box.inlines = mapInlines(box.inlines, fn);
    }
  }
}

function mapBlocks(blocks: Block[], fn: (src: string) => string | null): Block[] {
  return blocks.flatMap((b): Block[] => {
    switch (b.kind) {
      case "image":
        return rewrite(b, fn) ? [b] : [];
      case "paragraph":
      case "heading":
        b.children = mapInlines(b.children, fn);
        return [b];
      case "list":
        b.items = b.items.map((item) => mapBlocks(item, fn));
        return [b];
      case "box":
      case "styled-block":
      case "place":
      case "transform":
      case "pad":
        b.children = mapBlocks(b.children, fn);
        return [b];
      case "grid":
        b.cells = b.cells.map((cell) => mapBlocks(cell, fn));
        return [b];
      case "table":
        for (const rows of [b.header, b.body, b.footer]) {
          for (const row of rows ?? []) for (const cell of row.cells) cell.children = mapBlocks(cell.children, fn);
        }
        return [b];
      default:
        return [b];
    }
  });
}

function mapInlines(nodes: Inline[], fn: (src: string) => string | null): Inline[] {
  return nodes.flatMap((n): Inline[] => {
    if (n.kind === "image") return rewrite(n, fn) ? [n] : [];
    if ("children" in n) n.children = mapInlines(n.children, fn);
    return [n];
  });
}

function rewrite(img: Image, fn: (src: string) => string | null): boolean {
  const next = fn(img.src);
  if (next === null) return false;
  img.src = next;
  return true;
}

/** Plain text of the document in reading order, for content-loss checks. */
export function documentText(doc: Document): string {
  const out: string[] = [];
  const inl = (nodes: Inline[]) => {
    for (const n of nodes) {
      if (n.kind === "text" || n.kind === "code") out.push(n.value);
      else if (n.kind === "linebreak") out.push(" ");
      else if ("children" in n) inl(n.children);
    }
  };
  const blk = (blocks: Block[]) => {
    for (const b of blocks) {
      out.push(" ");
      switch (b.kind) {
        case "paragraph": case "heading": inl(b.children); break;
        case "list": b.items.forEach(blk); break;
        case "box": case "styled-block": case "place": case "transform": case "pad": blk(b.children); break;
        case "grid": b.cells.forEach(blk); break;
        case "raw-block": out.push(b.value); break;
        case "table":
          for (const rows of [b.header, b.body, b.footer]) {
            for (const row of rows ?? []) for (const cell of row.cells) blk(cell.children);
          }
          break;
      }
      out.push(" ");
    }
  };
  // Content moved to page margins and the page foreground, in document order
  // it would have had: running headers first, then the body, then fixed/footer.
  const bandBlocks = (band: MarginBand | undefined) =>
    Object.values(band ?? {}).forEach((box) => (box?.blocks ? blk(box.blocks) : box?.inlines && inl(box.inlines)));
  bandBlocks(doc.page?.header);
  blk(doc.children);
  blk(doc.page?.foreground ?? []);
  bandBlocks(doc.page?.footer);
  return out.join("").replace(/\s+/g, " ").trim();
}
