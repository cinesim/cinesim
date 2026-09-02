import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project } from "@cinesim/core";
import type { VisualIndexObservation } from "@cinesim/project-io";
import type { DerivedProjectScope } from "../../../shared/contracts";
import {
  mergeVisualObservations,
  splitVisualObservation,
  type ScreenplayVisualAsset,
} from "../../../shared/screenplay";

function sequenceVisualAssetIds(project: Project, sequenceId: string): string[] {
  const sequence = project.sequences.find(({ id }) => id === sequenceId);
  if (!sequence) return [];
  return [
    ...new Set(
      sequence.tracks.flatMap((track) =>
        track.clips.filter(({ mediaKind }) => mediaKind === "video").map(({ assetId }) => assetId),
      ),
    ),
  ];
}

export function useScreenplayVisuals(
  project: Project,
  sequenceId: string,
  scope: DerivedProjectScope,
) {
  const assetIds = useMemo(
    () => sequenceVisualAssetIds(project, sequenceId),
    [project, sequenceId],
  );
  const [visuals, setVisuals] = useState<Map<string, ScreenplayVisualAsset>>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const results = await Promise.all(
        assetIds.map((assetId) => window.cinesim.visualIndex.get(scope, assetId, { limit: 2_000 })),
      );
      setVisuals(new Map(assetIds.map((assetId, index) => [assetId, results[index]!])));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
    setLoading(false);
  }, [assetIds, scope]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void reload(), 0);
    const unsubscribe = window.cinesim.visualIndex.onChanged(() => void reload());
    return () => {
      window.clearTimeout(initialLoad);
      unsubscribe();
    };
  }, [reload]);

  const upsert = useCallback(
    async (assetId: string, observations: VisualIndexObservation[]) => {
      await window.cinesim.visualIndex.upsert(scope, assetId, observations);
      await reload();
    },
    [reload, scope],
  );

  const correct = useCallback(
    (assetId: string, observation: VisualIndexObservation, description: string) =>
      upsert(assetId, [{ ...observation, description: description.trim(), provenance: "ui" }]),
    [upsert],
  );

  const split = useCallback(
    async (assetId: string, observation: VisualIndexObservation) => {
      const current = visuals.get(assetId)?.observations ?? [];
      const parts = splitVisualObservation(observation, new Set(current.map(({ id }) => id)));
      if (parts) await upsert(assetId, parts);
    },
    [upsert, visuals],
  );

  const mergeNext = useCallback(
    async (assetId: string, observation: VisualIndexObservation) => {
      const current = visuals.get(assetId)?.observations ?? [];
      const index = current.findIndex(({ id }) => id === observation.id);
      const next = current[index + 1];
      if (!next) return;
      await window.cinesim.visualIndex.upsert(scope, assetId, [
        mergeVisualObservations(observation, next),
      ]);
      await window.cinesim.visualIndex.delete(scope, assetId, {
        observationIds: [next.id],
      });
      await reload();
    },
    [reload, scope, visuals],
  );

  const generate = useCallback(
    async (assetId: string, force = false) => {
      await window.cinesim.visualIndex.generate(scope, [assetId], force);
      await reload();
    },
    [reload, scope],
  );

  const clear = useCallback(
    async (assetId: string) => {
      await window.cinesim.visualIndex.clear(scope, [assetId]);
      await reload();
    },
    [reload, scope],
  );

  return { clear, correct, error, generate, loading, mergeNext, reload, split, visuals };
}
