import { useEffect, useState } from "react";
import type { DesktopProjectSession } from "../shared/api";
import { Welcome } from "./components/welcome";
import { Workspace } from "./components/workspace";

export function App() {
  const [session, setSession] = useState<DesktopProjectSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void window.cinesim
      .getSession()
      .then(setSession)
      .finally(() => setLoading(false));
  }, []);

  if (loading)
    return (
      <div className="grid h-screen place-items-center bg-canvas text-ui text-muted">
        Preparing Cinesim…
      </div>
    );
  return session ? (
    <Workspace session={session} onSession={setSession} />
  ) : (
    <Welcome onOpen={setSession} />
  );
}
