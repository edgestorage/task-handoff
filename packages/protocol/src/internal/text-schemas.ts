import { z } from "zod";

// Internal scalar building blocks, not domain contracts. Zod checks are immutable
// and retain their parent schema, so rebuilding identical trim/min chains for
// every field keeps all of those intermediate schemas alive. Domain schemas add
// their own limits and wrappers; do not register field-specific metadata here.
export const TrimmedTextSchema = z.string().trim();
export const NonEmptyTrimmedTextSchema = TrimmedTextSchema.min(1);
export const DateTimeStringSchema = z.string().datetime();
