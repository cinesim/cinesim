import { z } from "zod";

export const MAX_DESKTOP_PATH_LENGTH = 4_096;
export const MAX_REQUEST_IDS = 500;

export const desktopPathSchema = z.string().min(1).max(MAX_DESKTOP_PATH_LENGTH);
export const boundedIdSchema = z.string().min(1).max(200);
export const emptyRequestSchema = z.tuple([]);
