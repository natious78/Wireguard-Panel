"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect } from "react";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <section className="card page-error" role="alert">
      <AlertTriangle aria-hidden="true" />
      <h1>This page could not be loaded</h1>
      <p>The database or a required service may be temporarily unavailable. No configuration change was made.</p>
      <button className="button button-primary" onClick={reset}><RefreshCw />Try again</button>
      <details>
        <summary>Technical details</summary>
        <code>{error.message || "Unknown application error"}{error.digest ? ` · Reference ${error.digest}` : ""}</code>
      </details>
    </section>
  );
}
