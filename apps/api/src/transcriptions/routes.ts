import { Hono } from "hono";
import { z } from "zod";
import { auth } from "../auth";
import {
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  type OpenRouterTranscriptionGateway,
  TranscriptionGatewayError,
} from "./service";

const formatSchema = z.enum(["wav", "mp3", "flac", "m4a", "ogg", "webm", "aac"]);
const languageSchema = z
  .string()
  .trim()
  .regex(/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/)
  .nullable();
const keytermsSchema = z.array(z.string().trim().min(1).max(100)).max(100);
const audioContentTypes = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/flac",
  "audio/mp4",
  "audio/ogg",
  "audio/webm",
  "audio/aac",
]);

async function authenticatedUserId(headers: Headers): Promise<string | null> {
  return (await auth.api.getSession({ headers }))?.user.id ?? null;
}

export function createTranscriptionRoutes(service: OpenRouterTranscriptionGateway | null) {
  const routes = new Hono<{ Variables: { userId: string } }>();

  routes.use("*", async (context, next) => {
    const userId = await authenticatedUserId(context.req.raw.headers);
    if (!userId) return context.json({ error: "unauthorized" }, 401);
    context.set("userId", userId);
    if (!service) return context.json({ error: "transcription_unavailable" }, 503);
    await next();
  });

  routes.post("/", async (context) => {
    const contentType = context.req.header("content-type")?.split(";", 1)[0]?.trim() ?? "";
    if (!audioContentTypes.has(contentType)) {
      return context.json({ error: "unsupported_audio_type" }, 415);
    }
    const contentLength = Number(context.req.header("content-length") ?? "0");
    if (contentLength > MAX_TRANSCRIPTION_AUDIO_BYTES) {
      return context.json({ error: "audio_too_large" }, 413);
    }
    const body = context.req.raw.body;
    if (!body) return context.json({ error: "audio_required" }, 400);
    const format = formatSchema.parse(context.req.query("format"));
    const language = languageSchema.parse(context.req.query("language") ?? null);
    const rawKeyterms = context.req.header("x-cinesim-keyterms");
    const keyterms = keytermsSchema.parse(rawKeyterms ? JSON.parse(rawKeyterms) : []);
    const transcript = await service!.transcribe({
      audio: body,
      format,
      contentType,
      language,
      keyterms,
      signal: context.req.raw.signal,
    });
    return context.json(transcript);
  });

  routes.onError((error, context) => {
    if (error instanceof TranscriptionGatewayError) {
      return context.json({ error: error.code, message: error.message }, error.status as 400);
    }
    if (error instanceof z.ZodError) {
      return context.json({ error: "invalid_request", issues: error.issues }, 400);
    }
    if (error instanceof SyntaxError) return context.json({ error: "invalid_request" }, 400);
    throw error;
  });

  return routes;
}
