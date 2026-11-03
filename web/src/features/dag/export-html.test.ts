import { describe, expect, it } from "vitest";
import { serializeDagHtml } from "./export-html";

describe("serializeDagHtml", () => {
  it("uses the default offline palette and escapes the title when no palette is supplied", () => {
    const html = serializeDagHtml("<svg></svg>", `DAG <one> & "two"`);

    expect(html).toContain("--ground:#0b1015;");
    expect(html).toContain("<title>DAG &lt;one&gt; &amp; &quot;two&quot; · Burrow DagViz</title>");
    expect(html).toContain("<svg></svg>");
  });
});
