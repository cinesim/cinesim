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

`.video/` is local derived state. It is ignored in the project-level `.gitignore` created by Cinesim and can always be deleted and regenerated. Master media remains at its imported path; Cinesim never moves or mutates it.

## Timeline ordering and compatibility

Sequence track order is authored canonical state, not an incidental JSON order. It is preserved across save/load and matches the timeline UI: index `0` is the uppermost track. Upper visual tracks composite over lower video and overlay tracks. Track reordering uses a zero-based destination index within the track's existing sequence.

Audio-only assets may be placed only on audio tracks. Video and image assets may be placed on video or overlay tracks. A video asset retains its embedded audio while its clip lives on a visual track. Loading a project or applying a clip command rejects incompatible placements.

Tracks are changed through the shared command pathway:

- `track.add` takes `sequenceId`, `kind`, and an optional `name`. Core allocates the next project-wide stable track ID and appends the track.
- `track.update` takes `trackId` and at least one of `name`, `muted`, or `locked`. Names are trimmed and may not be empty.
- `track.reorder` takes `trackId` and a zero-based `index`. Locked tracks cannot be reordered.
- `track.remove` takes `trackId`. Removal is intentionally safe: the track must be unlocked and empty.

CLI and MCP operations are adapters for these commands; they do not implement separate editing behavior.
