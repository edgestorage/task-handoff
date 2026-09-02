import { z } from "zod";

export const StoryIdSchema = z.string().trim().min(1).max(120);
