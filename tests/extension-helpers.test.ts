import { describe, expect, it } from "vitest";
import { isAssistantMessage, getTextContent } from "../src/extension.js";

describe("isAssistantMessage", () => {
  it("returns true for assistant messages with content array", () => {
    expect(isAssistantMessage({ role: "assistant", content: [] })).toBe(true);
  });

  it("returns true for assistant messages with text blocks", () => {
    expect(
      isAssistantMessage({
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      }),
    ).toBe(true);
  });

  it("returns false for user messages", () => {
    expect(isAssistantMessage({ role: "user", content: [] })).toBe(false);
  });

  it("returns false when content is not an array", () => {
    expect(isAssistantMessage({ role: "assistant", content: "text" })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isAssistantMessage(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isAssistantMessage(undefined)).toBe(false);
  });

  it("returns false for non-objects", () => {
    expect(isAssistantMessage("string")).toBe(false);
    expect(isAssistantMessage(42)).toBe(false);
  });

  it("returns false when content property is absent", () => {
    expect(isAssistantMessage({ role: "assistant" })).toBe(false);
  });
});

describe("getTextContent", () => {
  it("extracts text from a single text block", () => {
    const msg = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Hello" }],
    };
    expect(getTextContent(msg)).toBe("Hello");
  });

  it("joins multiple text blocks with newline", () => {
    const msg = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "Hello" },
        { type: "text" as const, text: "World" },
      ],
    };
    expect(getTextContent(msg)).toBe("Hello\nWorld");
  });

  it("filters out non-text blocks", () => {
    const msg = {
      role: "assistant" as const,
      content: [
        { type: "tool_use" },
        { type: "text" as const, text: "Result" },
        { type: "thinking" },
      ],
    };
    expect(getTextContent(msg)).toBe("Result");
  });

  it("returns empty string when content has no text blocks", () => {
    const msg = {
      role: "assistant" as const,
      content: [{ type: "tool_use" }],
    };
    expect(getTextContent(msg)).toBe("");
  });

  it("returns empty string for empty content array", () => {
    const msg = {
      role: "assistant" as const,
      content: [] as Array<{ type: string }>,
    };
    expect(getTextContent(msg)).toBe("");
  });
});
