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
