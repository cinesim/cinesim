import type { Project, ProjectSettings } from "@cinesim/core";
import type { VisualIndexStore } from "@cinesim/project-io";
import type { DerivedMediaStore } from "../derived-media/service";
import type { TranscriptStore } from "../transcripts/service";

export async function publishDependentProject(input: {
  derivedMedia: DerivedMediaStore;
  transcripts: TranscriptStore;
  visualIndex: VisualIndexStore;
  directory: string;
  project: Project;
  settings: ProjectSettings;
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
}
