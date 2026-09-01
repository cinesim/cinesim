import type { Project, ProjectSettings } from "@cinesim/core";
import type { VisualIndexStore } from "@cinesim/project-io";
import type { DerivedMediaStore } from "../derived-media/service";
import type { TranscriptStore } from "../transcripts/service";
import type { FrameService } from "../frames/service";
import type { VisualAnalysisService } from "../visual-analysis/service";
import type { ExportService } from "../exports/service";

export async function publishDependentProject(input: {
  derivedMedia: DerivedMediaStore;
  frames: FrameService;
  exports: ExportService;
  transcripts: TranscriptStore;
  visualIndex: VisualIndexStore;
  visualAnalysis: VisualAnalysisService;
  directory: string;
  project: Project;
  settings: ProjectSettings;
  acceptedGeneration: string;
  preparedDerived?: Awaited<ReturnType<DerivedMediaStore["prepareProject"]>>;
}): Promise<void> {
  await input.derivedMedia.setProject(
    input.directory,
    input.project,
    input.preparedDerived,
    input.settings,
  );
  await input.transcripts.setProject(input.directory, input.project, input.derivedMedia.scope());
  input.visualIndex.setProject(input.directory, input.project);
  input.frames.setProject({
    directory: input.directory,
    project: input.project,
    acceptedGeneration: input.acceptedGeneration,
    scope: input.derivedMedia.scope(),
  });
  await input.exports.setProject({
    directory: input.directory,
    project: input.project,
    acceptedGeneration: input.acceptedGeneration,
    scope: input.derivedMedia.scope(),
  });
  input.visualAnalysis.setProject({
    project: input.project,
    acceptedGeneration: input.acceptedGeneration,
    scope: input.derivedMedia.scope(),
  });
}
