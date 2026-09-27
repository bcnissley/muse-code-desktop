import { describe, expect, it } from "vitest";
import { extractExecText, isExecNoise } from "./exec";

describe("extractExecText", () => {
  it("passes plain-text lines through", () => {
    expect(extractExecText("hello world")).toEqual({ text: "hello world" });
  });

  it("returns empty for blank lines", () => {
    expect(extractExecText("   ")).toEqual({ text: "" });
    expect(extractExecText("")).toEqual({ text: "" });
  });

  it("extracts a top-level text field", () => {
    const line = JSON.stringify({ type: "message", text: "Hello!" });
    expect(extractExecText(line)).toEqual({ text: "Hello!", event: "message" });
  });

  it("extracts nested text/delta fields", () => {
    const line = JSON.stringify({ type: "delta", delta: { text: "Hel" } });
    expect(extractExecText(line)).toEqual({ text: "Hel", event: "delta" });
  });

  it("collects text across nested arrays", () => {
    const line = JSON.stringify({ content: [{ text: "a" }, { text: "b" }] });
    expect(extractExecText(line).text).toBe("ab");
  });

  it("matches text keys case-insensitively", () => {
    const line = JSON.stringify({ Delta: { Text: "Hi" } });
    expect(extractExecText(line).text).toBe("Hi");
  });

  it("detects tool-call events via type + tool", () => {
    const line = JSON.stringify({ type: "tool_call", tool: "read_file" });
    expect(extractExecText(line)).toEqual({ text: "", tool: "read_file", event: "tool" });
  });

  it("detects the tool_name variant", () => {
    const line = JSON.stringify({ type: "tool_use", tool_name: "bash" });
    expect(extractExecText(line).tool).toBe("bash");
  });

  it("does not flag non-tool types as tools", () => {
    const line = JSON.stringify({ type: "message", name: "bob", text: "hi" });
    expect(extractExecText(line)).toEqual({ text: "hi", event: "message" });
  });

  it("treats garbage as plain text", () => {
    expect(extractExecText("{not json")).toEqual({ text: "{not json" });
  });

  it("handles bare JSON strings", () => {
    expect(extractExecText('"hi"')).toEqual({ text: "hi" });
  });

  it("handles JSON null/numbers without crashing", () => {
    expect(extractExecText("null")).toEqual({ text: "" });
    expect(extractExecText("42")).toEqual({ text: "" });
  });

  it("exposes an event label for telemetry", () => {
    const line = JSON.stringify({ type: "thinking", text: "" });
    expect(extractExecText(line).event).toBe("thinking");
  });

  it("returns no event label for plain text", () => {
    expect(extractExecText("just a line").event).toBeUndefined();
  });

  it("flags CLI internal log noise", () => {
    expect(isExecNoise("muse: workspace root: C:\\x")).toBe(true);
    expect(isExecNoise("muse: workspace trust: trusted")).toBe(true);
    expect(isExecNoise("opening meta model stream attempt 1/10")).toBe(true);
    expect(isExecNoise("completed meta model stream attempt 1/10")).toBe(true);
  });

  it("does not flag real answer text as noise", () => {
    expect(isExecNoise("Hello! How can I help?")).toBe(false);
    expect(isExecNoise('{"type":"message","text":"hi"}')).toBe(false);
  });
});
