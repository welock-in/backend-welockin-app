// Vercel serverless entry point.
//
// Vercel invokes a function's default export as the handler. An Express app is
// itself a `(req, res)` function, so exporting the built app directly lets the
// whole API run as one serverless function (see vercel.json, which rewrites
// every path here so Express does its own /api/* routing).
//
// For a long-running server (local dev, Render, Railway, Docker) use
// `src/index.ts` instead — it calls app.listen().
import { createApp } from "../src/app";

export default createApp();
