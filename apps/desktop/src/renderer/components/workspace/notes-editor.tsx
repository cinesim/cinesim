import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";

const config = {
  namespace: "CinesimProjectNotes",
  theme: { paragraph: "mb-2" },
  onError(error: Error) {
    throw error;
  },
};

export function NotesEditor() {
  return (
    <LexicalComposer initialConfig={config}>
      <div className="relative min-h-40 rounded-md border border-border bg-panel-muted">
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              aria-label="Creative notes"
              className="min-h-40 p-3 text-ui leading-5 text-secondary outline-none"
            />
          }
          placeholder={
            <div className="pointer-events-none absolute left-3 top-3 text-ui text-muted">
              Creative direction, shot notes, edit ideas…
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
      </div>
    </LexicalComposer>
  );
}
