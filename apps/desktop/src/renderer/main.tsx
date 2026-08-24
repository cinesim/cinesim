import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { App } from "./app";
import { RendererControllerProvider } from "./store/renderer-store-context";
import "./styles.css";

const rootRoute = createRootRoute({ component: App });
const routeTree = rootRoute;
const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RendererControllerProvider api={window.cinesim}>
      <RouterProvider router={router} />
    </RendererControllerProvider>
  </StrictMode>,
);
