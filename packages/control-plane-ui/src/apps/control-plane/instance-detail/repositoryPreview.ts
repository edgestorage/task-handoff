export type RepositoryMediaKind = "image" | "video" | "audio" | "pdf" | "download";

// Extensions only decide whether to try the raw-file channel. The response MIME
// remains authoritative for selecting the browser renderer.
export function isRepositoryMediaPath(path: string) {
  return /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp|mp4|m4v|mov|webm|ogv|mkv|mp3|m4a|aac|wav|ogg|oga|flac|opus|pdf)$/i.test(path);
}

export function repositoryMediaKind(contentType: string | null): RepositoryMediaKind {
  const mime = contentType?.split(";", 1)[0]?.trim().toLowerCase() || "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  return "download";
}
