import { describe, expect, it } from "vite-plus/test";
import { LANGUAGE_REFERENCE, searchLanguageReference } from "../src";

describe("language reference", () => {
  it("separates compiler acceptance from actual preview and export capability", () => {
    expect(LANGUAGE_REFERENCE.find(({ id }) => id === "element:colorgrade")?.capability).toEqual({
      compiler: "supported",
      preview: "supported",
      export: "supported",
    });
    expect(LANGUAGE_REFERENCE.find(({ id }) => id === "element:ducker")?.capability).toEqual({
      compiler: "supported",
      preview: "supported",
      export: "supported",
    });
    expect(LANGUAGE_REFERENCE.find(({ id }) => id === "element:blur")?.capability).toMatchObject({
      compiler: "supported",
      preview: "supported",
      export: "supported",
    });
    expect(LANGUAGE_REFERENCE.find(({ id }) => id === "element:captiontrack")?.capability).toEqual({
      compiler: "supported",
      preview: "supported",
      export: "supported",
    });
    expect(LANGUAGE_REFERENCE.some(({ id }) => id === "element:captions")).toBe(false);
    expect(LANGUAGE_REFERENCE.find(({ id }) => id === "element:transition")?.capability).toEqual({
      compiler: "supported",
      preview: "supported",
      export: "supported",
    });
    expect(
      LANGUAGE_REFERENCE.find(({ id }) => id === "element:audiocrossfade")?.capability,
    ).toEqual({ compiler: "supported", preview: "supported", export: "supported" });
    expect(LANGUAGE_REFERENCE.find(({ id }) => id === "element:marker")?.capability).toMatchObject({
      compiler: "supported",
      preview: "partial",
      export: "partial",
    });
    expect(LANGUAGE_REFERENCE.find(({ id }) => id === "element:lut")?.capability).toMatchObject({
      compiler: "supported",
      preview: "unsupported",
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
