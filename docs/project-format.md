# Cinesim project format v1

`cinesim.json` is the only project configuration file at the project root. It identifies the project and points to canonical files under `.cinesim/`.

```json
{
  "version": 1,
  "id": "project_example",
  "name": "Example",
  "activeSequenceId": "sequence_main",
  "files": {
    "assets": ".cinesim/assets.json",
    "timeline": ".cinesim/timeline.json",
    "settings": ".cinesim/settings.toml"
  }
}
```

`.cinesim/assets.json` and `.cinesim/timeline.json` are deterministic machine-edited canonical files. `.cinesim/settings.toml` is canonical and intentionally comfortable to edit by hand. All carry `version = 1` semantics and future versions are rejected until a migration exists.

`.video/` is local derived state. It is ignored in the project-level `.gitignore` created by Cinesim and can always be deleted and regenerated. A newly imported original remains at its source path until its private cloud upload and local edit proxy are both verified. Cinesim then commits an opaque cloud source through `asset.setSource` and moves the redundant local original to the system Trash.

## Timeline ordering and compatibility

Sequence track order is authored canonical state, not an incidental JSON order. It is preserved across save/load and matches the timeline UI: index `0` is the uppermost track. Upper visual tracks composite over lower video and overlay tracks. Track reordering uses a zero-based destination index within the track's existing sequence.

Every canonical clip declares a `mediaKind` of `video` or `audio`; playback and presentation never infer embedded audio from a visual clip. Audio-only assets may be placed only on audio tracks, while video and image components may be placed on video or overlay tracks. Adding a video asset with audio atomically creates reciprocal linked video and audio clips. The command chooses an available audio track or creates one when necessary, and linked move, trim, split, and remove edits remain one command and one undo step. Pre-component project files are deterministically upgraded to this representation during load. Loading a project or applying a clip command rejects incompatible placements and malformed links.

Tracks are changed through the shared command pathway:

- `track.add` takes `sequenceId`, `kind`, and an optional `name`. Core allocates the next project-wide stable track ID. Video and overlay tracks enter at the top of the visual stack; audio tracks enter at the bottom of the audio stack.
- `track.update` takes `trackId` and at least one of `name`, `muted`, or `locked`. Names are trimmed and may not be empty.
- `track.reorder` takes `trackId` and a zero-based `index`. Locked tracks cannot be reordered.
- `track.remove` takes `trackId`. Removal is intentionally safe: the track must be unlocked and empty.

Collection edits use the same command pathway:

- `sequence.createFromAssets` takes an ordered, non-empty `assetIds` list and optional name and
  format overrides. It creates standard video/audio tracks, places assets sequentially, creates
  reciprocal audio components when needed, and makes the new timeline active in one undo step.
- `asset.remove` takes a non-empty `assetIds` list. It removes the canonical asset references and
  every clip using them. A usage on a locked track blocks the operation. Cloud originals enter the
  account Trash through the desktop adapter; disposable derived artifacts are pruned after commit.
- `sequence.remove` deletes an unlocked timeline and its clips without removing assets. The last
  timeline cannot be deleted, and removing the active timeline chooses the lowest remaining stable
  sequence ID as the deterministic fallback.

Desktop project removal is deliberately outside core editing semantics. Forgetting a project only
removes app metadata. Moving a project to Trash closes active services and uses the operating system
Trash for the exact validated project directory.

CLI and MCP operations are adapters for these commands; they do not implement separate editing behavior.
