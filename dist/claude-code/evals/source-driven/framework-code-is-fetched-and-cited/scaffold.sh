#!/usr/bin/env bash
# Scaffold for evals/source-driven/framework-code-is-fetched-and-cited, and sourced by the
# other source-driven cases that need a project.
#
# A minimal React app whose manifest pins a range and whose lockfile pins the installed
# version (react 19.1.0), so a run that reads only package.json sees a range and a run that
# reads the lockfile sees the version. src/OrderForm.jsx tracks submission state by hand with
# useState, which the React 19 docs replace with useActionState, so a run that fetched the
# docs has a documented conflict with the existing code to surface.
set -euo pipefail

mkdir -p src
cat > package.json <<'JSON'
{
  "name": "order-desk",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
JSON
cat > package-lock.json <<'JSON'
{
  "name": "order-desk",
  "version": "0.1.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": { "name": "order-desk", "version": "0.1.0",
          "dependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" } },
    "node_modules/react": { "version": "19.1.0" },
    "node_modules/react-dom": { "version": "19.1.0" }
  }
}
JSON
cat > src/OrderForm.jsx <<'JSX'
import { useState } from "react";

export function OrderForm({ submitOrder }) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(event) {
    event.preventDefault();
    setIsPending(true);
    try {
      await submitOrder(new FormData(event.currentTarget));
    } catch (e) {
      setError(e.message);
    } finally {
      setIsPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <input name="sku" />
      <button disabled={isPending}>Order</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
JSX
echo "scaffold: order-desk ready (react 19.1.0 in package-lock.json)"
