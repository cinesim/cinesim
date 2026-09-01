import { describe, expect, it } from "vite-plus/test";
import { LANGUAGE_REFERENCE, searchLanguageReference } from "../src";

describe("language reference", () => {
  it("separates compiler acceptance from actual preview and export capability", () => {
    expect(LANGUAGE_REFERENCE.find(({ id }) => id === "element:colorgrade")?.capability).toEqual({
      compiler: "supported",
      preview: "supported",
      export: "unsupported",
    });
    expect(LANGUAGE_REFERENCE.find(({ id }) => id === "element:ducker")?.capability).toEqual({
      compiler: "supported",
      preview: "supported",
      export: "unsupported",
    });
    expect(LANGUAGE_REFERENCE.find(({ id }) => id === "element:blur")?.capability).toMatchObject({
      compiler: "supported",
      preview: "unsupported",
      export: "unsupported",
    });
    expect(
      LANGUAGE_REFERENCE.find(({ id }) => id === "element:captions")?.capability,
    ).toMatchObject({
      compiler: "supported",
      preview: "partial",
      export: "unsupported",
    });
  });

  it("fuzzy-searches recipes and property constraints with a hard result cap", () => {
    expect(searchLanguageReference("reaction cutaway", 3)[0]).toMatchObject({
      id: "recipe:cutaway",
      capability: { preview: "supported" },
    });
    expect(searchLanguageReference("fadeIn", 20)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "element:clip",
          properties: expect.arrayContaining([
            expect.objectContaining({ name: "fadeIn", type: "time" }),
          ]),
        }),
      ]),
    );
    expect(searchLanguageReference("", 200)).toHaveLength(20);
  });
});
