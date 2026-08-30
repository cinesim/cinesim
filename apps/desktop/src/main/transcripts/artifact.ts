import { z } from "zod";
import {
  TRANSCRIPT_ARTIFACT_VERSION,
  TRANSCRIPT_GENERATOR_VERSION,
  TRANSCRIPTION_MODEL,
} from "../../shared/transcript";
import type { TranscriptArtifact } from "../../shared/transcript";

const timeUs = z.number().int().nonnegative().safe();
const confidence = z.number().min(0).max(1).finite();
const fingerprintSchema = z.object({
  size: z.number().int().nonnegative().safe(),
  mtimeMs: z.number().nonnegative().finite(),
  edgeHash: z.string().min(1).max(256),
});
const wordSchema = z
  .object({
    id: z.string().regex(/^word_[0-9]{6}$/),
    text: z.string().min(1).max(1_000),
    sourceStartUs: timeUs,
    sourceEndUs: timeUs,
    confidence: confidence.optional(),
    speakerClusterId: z.string().min(1).max(128).optional(),
    utteranceId: z
      .string()
      .regex(/^utterance_[0-9]{6}$/)
      .optional(),
    paragraphId: z.string().min(1).max(128).optional(),
    detectedLanguage: z.string().min(1).max(32).optional(),
  })
  .refine((word) => word.sourceEndUs > word.sourceStartUs, {
    message: "Transcript words must have a positive source duration",
  });
const utteranceSchema = z
  .object({
    id: z.string().regex(/^utterance_[0-9]{6}$/),
    sourceStartUs: timeUs,
    sourceEndUs: timeUs,
    speakerClusterId: z.string().min(1).max(128).optional(),
    confidence: confidence.optional(),
    detectedLanguage: z.string().min(1).max(32).optional(),
    wordIds: z.array(z.string().regex(/^word_[0-9]{6}$/)).max(100_000),
  })
  .refine((utterance) => utterance.sourceEndUs > utterance.sourceStartUs, {
    message: "Transcript utterances must have a positive source duration",
  });

const transcriptArtifactStructure = z.object({
  version: z.literal(TRANSCRIPT_ARTIFACT_VERSION),
  assetId: z.string().regex(/^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  sourceFingerprint: fingerprintSchema,
  generator: z.object({
    gateway: z.literal("direct"),
    provider: z.literal("deepgram"),
    model: z.literal(TRANSCRIPTION_MODEL),
    version: z.literal(TRANSCRIPT_GENERATOR_VERSION),
    requestId: z.string().min(1).max(1_024).optional(),
  }),
  options: z.object({
    language: z.string().min(1).max(32).nullable(),
    detectLanguage: z.boolean(),
    multilingual: z.boolean(),
    diarization: z.literal(true),
    utterances: z.literal(true),
    paragraphs: z.literal(true),
    smartFormat: z.literal(true),
    punctuation: z.literal(true),
    fillerWords: z.literal(true),
    profanityFilter: z.literal(false),
    redactPersonalInformation: z.literal(false),
    keyterms: z.array(z.string().min(1).max(100)).max(100),
  }),
  language: z.string().min(1).max(32).nullable(),
  durationUs: timeUs,
  confidence: confidence.optional(),
  words: z.array(wordSchema).max(500_000),
  utterances: z.array(utteranceSchema).max(100_000),
});

type ParsedTranscriptArtifact = z.infer<typeof transcriptArtifactStructure>;

function validateWords(artifact: ParsedTranscriptArtifact, context: z.RefinementCtx): Set<string> {
  const wordIds = new Set<string>();
  let previousStartUs = -1;
  for (let index = 0; index < artifact.words.length; index += 1) {
    const word = artifact.words[index]!;
    if (wordIds.has(word.id))
      context.addIssue({ code: "custom", path: ["words", index, "id"], message: "duplicate" });
    wordIds.add(word.id);
    if (word.sourceStartUs < previousStartUs)
      context.addIssue({
        code: "custom",
        path: ["words", index, "sourceStartUs"],
        message: "words must be sorted",
      });
    if (word.sourceEndUs > artifact.durationUs)
      context.addIssue({
        code: "custom",
        path: ["words", index, "sourceEndUs"],
        message: "word exceeds asset duration",
      });
    previousStartUs = word.sourceStartUs;
  }
  return wordIds;
}

function validateUtteranceWords(
  artifact: ParsedTranscriptArtifact,
  wordIds: ReadonlySet<string>,
  context: z.RefinementCtx,
): void {
  for (let index = 0; index < artifact.utterances.length; index += 1) {
    for (const wordId of artifact.utterances[index]!.wordIds) {
      if (wordIds.has(wordId)) continue;
      context.addIssue({
        code: "custom",
        path: ["utterances", index, "wordIds"],
        message: `unknown word ${wordId}`,
      });
    }
  }
}

function validateArtifactRelationships(
  artifact: ParsedTranscriptArtifact,
  context: z.RefinementCtx,
): void {
  validateUtteranceWords(artifact, validateWords(artifact, context), context);
}

export const transcriptArtifactSchema = transcriptArtifactStructure.superRefine(
  validateArtifactRelationships,
);

export function parseTranscriptArtifact(value: unknown): TranscriptArtifact {
  return transcriptArtifactSchema.parse(value) as TranscriptArtifact;
}
