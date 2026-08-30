import { dialog } from "electron";

export interface UserIntentPrompt {
  title: string;
  message: string;
  detail: string;
  confirmLabel: string;
}

export async function requireUserIntent(prompt: UserIntentPrompt): Promise<void> {
  const result = await dialog.showMessageBox({
    type: "warning",
    title: prompt.title,
    message: prompt.message,
    detail: prompt.detail,
    buttons: [prompt.confirmLabel, "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (result.response !== 0) throw new Error("Action cancelled by the user");
}
