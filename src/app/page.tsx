import { Suspense } from "react";
import StreamApp from "./stream-app";

export default function Home() {
  return (
    <Suspense
      fallback={
        <main className="app-shell">
          <p className="loading-state">Carregando sala…</p>
        </main>
      }
    >
      <StreamApp />
    </Suspense>
  );
}
