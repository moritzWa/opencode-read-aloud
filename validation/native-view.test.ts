import { expect, test } from "bun:test";
import { MarkdownRenderable, RGBA, SyntaxStyle } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { blocks, clear, markdowns, pick, show, type Spot } from "../view";
import { nativeOffset } from "../native-view";

test.skipIf(!("blocks" in MarkdownRenderable.prototype)).each([24, 80])(
  "native Markdown keeps speech discovery, lavender highlights and click offsets at width %s",
  async (width) => {
    const setup = await createTestRenderer({ width, height: 40, remote: true });
    const syntax = SyntaxStyle.fromStyles(
      { default: { fg: "#ffffff" } },
      setup.renderer.nativeScene,
    );
    const view = new MarkdownRenderable(setup.renderer, {
      content:
        "# Summary\n\n界😀 There are **two words** here.\n\n- First item\n- Second item\n\n```text\nReadable fence\n```\n\n```ts\nconst excluded = true\n```\n\n| Name | Value |\n| - | - |\n| A | One |",
      syntaxStyle: syntax,
      conceal: true,
      width,
    });
    setup.renderer.root.add(view);
    try {
      await setup.renderOnce();
      expect(markdowns(setup.renderer.root)).toEqual([view]);
      const found = blocks(view)!;
      expect(found.map((block) => block.text).join("\n")).toContain(
        "There are two words",
      );
      expect(found.map((block) => block.text).join("\n")).toContain(
        "Readable fence",
      );
      expect(found.map((block) => block.text).join("\n")).not.toContain(
        "excluded",
      );
      expect(found.some((block) => block.kind === "table")).toBe(true);
      const target = found.find((block) => block.text.includes("two words"))!;
      const start = target.text.indexOf("two");
      const original = setup.captureCharFrame();
      const colors = {
        background: RGBA.fromHex("#ffffff"),
        primary: RGBA.fromHex("#111111"),
        sentence: RGBA.fromHex("#e2e2ff"),
        word: RGBA.fromHex("#adadff"),
      };
      show(
        target.node,
        { start: 0, end: target.text.length },
        { start, end: start + 3 },
        colors,
      );
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toBe(original);
      const painted = setup.captureSpans().lines.flatMap((line) => line.spans);
      expect(
        painted
          .filter((span) => span.bg.equals(colors.word))
          .map((span) => span.text)
          .join(""),
      ).toBe("two");
      expect(
        painted.some(
          (span) =>
            span.bg.equals(colors.sentence) && span.text.includes("There"),
        ),
      ).toBe(true);
      expect(nativeOffset(target.node, target.node.x + 5, target.node.y)).toBe(
        4,
      );
      clear();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toBe(original);
      expect(
        setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .some((span) => span.bg.equals(colors.word)),
      ).toBe(false);
      const table = found.find((block) => block.kind === "table")!;
      const cell = table.text.indexOf("One");
      show(
        table.node,
        { start: 0, end: table.text.length },
        { start: cell, end: cell + 3 },
        colors,
        table.table,
      );
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toBe(original);
      expect(
        setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .filter((span) => span.bg.equals(colors.word))
          .map((span) => span.text)
          .join(""),
      ).toBe("One");
      clear();
      view.content = "## Updated\n\nA streamed replacement stays readable.";
      await setup.renderOnce();
      expect(blocks(view)!.map((block) => block.text)).toContain(
        "A streamed replacement stays readable.",
      );
      expect(
        setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .some((span) => span.bg.equals(colors.word)),
      ).toBe(false);
    } finally {
      clear();
      setup.renderer.destroy();
    }
  },
);

test.skipIf(!("blocks" in MarkdownRenderable.prototype))(
  "native duplicate answers keep click and highlight ownership on the selected message",
  async () => {
    const setup = await createTestRenderer({
      width: 60,
      height: 12,
      remote: true,
    });
    const syntax = SyntaxStyle.fromStyles(
      { default: { fg: "#ffffff" } },
      setup.renderer.nativeScene,
    );
    const clicks: Spot[] = [];
    const views = ["old", "new"].map((id) => {
      const view = new MarkdownRenderable(setup.renderer, {
        id,
        content: "Same answer twice.",
        syntaxStyle: syntax,
        width: 60,
        onMouseUp: (event) => {
          const spot = pick(view, `part-${id}`, `message-${id}`, event);
          if (spot) clicks.push(spot);
        },
      });
      setup.renderer.root.add(view);
      return view;
    });
    try {
      await setup.renderOnce();
      const node = blocks(views[1])![0].node;
      const original = setup.captureCharFrame();
      await setup.mockMouse.click(node.x + 5, node.y);
      await setup.mockMouse.click(node.x + 5, node.y);
      expect(clicks).toHaveLength(1);
      expect(clicks[0]).toMatchObject({
        messageID: "message-new",
        partID: "part-new",
        node,
        offset: 5,
      });
      const color = RGBA.fromHex("#adadff");
      show(
        node,
        { start: 0, end: 18 },
        { start: 5, end: 11 },
        { background: RGBA.fromHex("#000000"), primary: color, word: color },
      );
      await setup.renderOnce();
      expect(
        setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .filter((span) => span.bg.equals(color))
          .map((span) => span.text)
          .join(""),
      ).toBe("answer");
      expect(setup.captureCharFrame()).toBe(original);
    } finally {
      clear();
      setup.renderer.destroy();
    }
  },
);
