import type { Project, ProjectSettings } from "@cinesim/core";
import type { VisualIndexStore } from "@cinesim/project-io";
import type { DerivedMediaStore } from "../derived-media/service";
import type { TranscriptStore } from "../transcripts/service";
import type { FrameService } from "../frames/service";

export async function publishDependentProject(input: {
  derivedMedia: DerivedMediaStore;
  frames: FrameService;
  transcripts: TranscriptStore;
  visualIndex: VisualIndexStore;
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
}
