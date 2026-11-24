import { RGBA, type MarkdownRenderable, type Renderable } from "@opentui/core";
import type { Block, Colors, Range } from "./view";
import { tableText } from "./script";

type Leaf = Renderable & {
  plainText: string;
  lineInfo: { lineStartCols: number[]; lineWidthCols: number[] };
};
type NativeMarkdown = MarkdownRenderable & {
  blocks: readonly { kind: string; renderable?: Renderable }[];
};
const leaves = new WeakMap<Renderable, string>();
let cleanup: (() => void) | undefined;
type Frame = {
  width: number;
  height: number;
  withBuffers<T>(callback: (cells: { width: number; bg: Uint16Array }) => T): T;
};

export function nativeMarkdown(node: Renderable): node is NativeMarkdown {
  return (
    "blocks" in node && Array.isArray(node.blocks) && "rerunInlineHook" in node
  );
}

export function nativeBlocks(view: NativeMarkdown): Block[] {
  return view.blocks.flatMap((block): Block[] => {
    const node = block.renderable;
    if (!node || node.isDestroyed) return [];
    if (
      block.kind === "table" &&
      "content" in node &&
      Array.isArray(node.content)
    ) {
      const rows = (node.content as { text: string }[][][]).map((row) =>
        row.map((cell) => cell.map((chunk) => chunk.text).join("")),
      );
      const table = tableText(rows[0] ?? [], rows.slice(1));
      return table ? [{ kind: "table", text: table.text, table, node }] : [];
    }
    if (
      !["paragraph", "heading", "code"].includes(block.kind) ||
      !("plainText" in node)
    )
      return [];
    if (
      block.kind === "code" &&
      "filetype" in node &&
      !/^(?:text|txt|plain|plaintext)?$/i.test(String(node.filetype ?? ""))
    )
      return [];
    const text = String(node.plainText);
    leaves.set(node, text);
    return [{ kind: block.kind === "code" ? "code" : "prose", text, node }];
  });
}

export function nativeOffset(node: Renderable, x: number, y: number) {
  const text = leaves.get(node);
  if (text === undefined) return;
  const leaf = node as Leaf;
  const row = y - leaf.y;
  if (row < 0 || row >= leaf.lineInfo.lineStartCols.length) return;
  const column = leaf.lineInfo.lineStartCols[row] + Math.max(0, x - leaf.x);
  let cells = 0;
  for (const item of new Intl.Segmenter().segment(text)) {
    cells += item.segment === "\n" ? 1 : Bun.stringWidth(item.segment);
    if (cells > column) return item.index;
  }
  return text.length;
}

export function nativeClear() {
  cleanup?.();
  cleanup = undefined;
}

export function nativeShow(
  node: Renderable,
  sentence: Range,
  word: Range,
  colors: Colors,
) {
  const text = leaves.get(node);
  if (text === undefined) return false;
  nativeClear();
  const renderer = node.ctx as typeof node.ctx & {
    addPostProcessFn(fn: (buffer: Frame) => void): void;
    removePostProcessFn(fn: (buffer: Frame) => void): void;
  };
  const leaf = node as Leaf;
  const palette = {
    sentence: colors.sentence ?? tint(colors.background, colors.primary, 0.12),
    word: colors.word ?? tint(colors.background, colors.primary, 0.4),
  };
  // Color the finished native frame. Do not take ownership of Markdown's text,
  // inline hooks, syntax styles, links, or layout while speech advances.
  const paint = (buffer: Frame) => {
    if (node.isDestroyed || leaf.plainText !== text) return;
    const clip = {
      left: 0,
      top: 0,
      right: buffer.width,
      bottom: buffer.height,
    };
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!("viewport" in parent)) continue;
      const viewport = parent.viewport as Renderable;
      clip.left = Math.max(clip.left, viewport.x);
      clip.top = Math.max(clip.top, viewport.y);
      clip.right = Math.min(clip.right, viewport.x + viewport.width);
      clip.bottom = Math.min(clip.bottom, viewport.y + viewport.height);
    }
    let column = 0;
    for (const item of new Intl.Segmenter().segment(text)) {
      const width = item.segment === "\n" ? 1 : Bun.stringWidth(item.segment);
      const row = leaf.lineInfo.lineStartCols.findLastIndex(
        (start) => start <= column,
      );
      const x = leaf.x + column - (leaf.lineInfo.lineStartCols[row] ?? 0);
      const y = leaf.y + Math.max(row, 0);
      const bg =
        word.start <= item.index && item.index < word.end
          ? palette.word
          : sentence.start <= item.index && item.index < sentence.end
            ? palette.sentence
            : undefined;
      if (bg && item.segment !== "\n" && y >= clip.top && y < clip.bottom) {
        buffer.withBuffers((cells) => {
          for (let offset = 0; offset < width; offset++) {
            if (x + offset < clip.left || x + offset >= clip.right) continue;
            cells.bg.set(bg.buffer, (y * cells.width + x + offset) * 4);
          }
        });
      }
      column += width;
    }
  };
  renderer.addPostProcessFn(paint);
  cleanup = () => {
    renderer.removePostProcessFn(paint);
    if (!node.isDestroyed) node.requestRender();
  };
  node.requestRender();
  return true;
}

function tint(base: RGBA, overlay: RGBA, alpha: number) {
  const mix = (from: number, to: number) =>
    Math.round((from + (to - from) * alpha) * 255);
  return RGBA.fromInts(
    mix(base.r, overlay.r),
    mix(base.g, overlay.g),
    mix(base.b, overlay.b),
  );
}
