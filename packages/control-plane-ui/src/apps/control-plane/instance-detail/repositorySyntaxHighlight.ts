export function repositoryLanguageForPath(path: string) {
  const name = path.split("/").at(-1)?.toLowerCase() || "";
  if (name === "dockerfile") return "dockerfile";
  const extension = name.includes(".") ? name.split(".").at(-1) || "" : "";
  return ({
    bash: "bash", c: "cpp", cc: "cpp", cpp: "cpp", cs: "csharp", css: "css", cxx: "cpp",
    go: "go", h: "cpp", hpp: "cpp", htm: "xml", html: "xml", java: "java", js: "javascript",
    json: "json", jsonc: "json", jsx: "javascript", kt: "kotlin", kts: "kotlin", less: "css",
    md: "markdown", mjs: "javascript", php: "php", py: "python", rb: "ruby", rs: "rust",
    sass: "css", scss: "css", sh: "bash", sql: "sql", svg: "xml", swift: "swift", ts: "typescript",
    tsx: "typescript", vue: "xml", xml: "xml", yaml: "yaml", yml: "yaml", zsh: "bash",
  } as Record<string, string>)[extension] || "";
}
