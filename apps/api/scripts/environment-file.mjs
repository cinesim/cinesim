const assignmentPattern = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function environmentKeys(contents) {
  const keys = new Set();
  for (const line of contents.split("\n")) {
    const match = assignmentPattern.exec(line);
    if (match) keys.add(match[1]);
  }
  return keys;
}

export function populateAuthSecret(contents, authSecret) {
  return contents.replace("replace-with-at-least-32-random-characters", authSecret);
}

export function backfillMissingEnvironmentVariables(existing, example, authSecret) {
  const existingKeys = environmentKeys(existing);
  const addedKeys = [];
  const addedLines = [];

  for (const line of example.split("\n")) {
    const match = assignmentPattern.exec(line);
    if (!match || existingKeys.has(match[1])) continue;

    existingKeys.add(match[1]);
    addedKeys.push(match[1]);
    addedLines.push(populateAuthSecret(line, authSecret));
  }

  if (addedLines.length === 0) return { contents: existing, addedKeys };

  const base = existing.endsWith("\n") ? existing : `${existing}\n`;
  const separator = base.trim().length === 0 ? "" : "\n";
  return {
    contents: `${base}${separator}# Added by vp run api:setup from .env.example; existing values were preserved.\n${addedLines.join("\n")}\n`,
    addedKeys,
  };
}
